/**
 * ExtensionSync — Background Service Worker
 * ===========================================
 * Manifest V3 architecture.
 *
 * CRITICAL MV3 CONSTRAINT:
 * This service worker is EPHEMERAL — it is terminated by the browser after
 * ~30 seconds of inactivity and restarted on demand. Therefore:
 *   1. All event listeners MUST be registered at the top level, synchronously.
 *   2. NO state may live in global variables — everything is persisted to
 *      chrome.storage.
 *   3. fetch() is used instead of XMLHttpRequest (unavailable in workers).
 *
 * This module:
 *   - Initializes default settings on first install.
 *   - Monitors extension state changes (install/uninstall/enable/disable)
 *     and propagates them to the cloud sync payload.
 *   - Handles message-passing requests from the popup.
 *   - Pushes serialized payloads to a user-configured custom REST endpoint.
 */

/* --------------------------------------------------------------------------
 * STORAGE KEYS (shared contract between popup.js and background.js)
 * ------------------------------------------------------------------------ */
const STORAGE_KEYS = {
  SYNC_PAYLOAD: 'extensionsync_payload',       // serialized extension array (in chrome.storage.sync)
  CUSTOM_ENDPOINT: 'extensionsync_endpoint',   // user webhook / REST URL (in chrome.storage.local)
  LAST_SYNC_AT: 'extensionsync_last_sync_at',  // epoch ms of last successful sync
  VERSION: 'extensionsync_version'             // schema version for forward compatibility
};

const SCHEMA_VERSION = 1;

/**
 * Constructs the canonical Chrome Web Store detail URL for a given extension.
 * We intentionally pass the ID even without a name slug — Chrome's store
 * redirects `/detail/-/{id}` to the correct listing, so we never need to
 * guess the human-readable slug.
 *
 * @param {string} id — 32-char extension ID
 * @returns {string} canonical web store URL
 */
function buildWebStoreUrl(id = '') {
  return `https://chromewebstore.google.com/detail/-/${id}`;
}

/* --------------------------------------------------------------------------
 * INSTALL / UPDATE HOOK — register once at top level (must be synchronous)
 * ------------------------------------------------------------------------ */
chrome.runtime.onInstalled.addListener((details) => {
  // 'install' fires once the very first time the extension is loaded,
  // 'update' fires on every subsequent version bump.
  if (details.reason === 'install') {
    // Seed defaults so downstream reads never return undefined.
    chrome.storage.local.set({
      [STORAGE_KEYS.CUSTOM_ENDPOINT]: '',
      [STORAGE_KEYS.LAST_SYNC_AT]: null,
      [STORAGE_KEYS.VERSION]: SCHEMA_VERSION
    });

    // Compute an initial sync payload so the popup shows data immediately.
    void refreshSyncPayload();
  }
});

/* --------------------------------------------------------------------------
 * EXTENSION STATE MONITORING
 *
 * The management API fires these events whenever ANY extension (including
 * ExtensionSync itself) is installed, uninstalled, enabled, or disabled.
 * We listen and re-serialize the payload so that cloud sync stays current
 * without any user interaction.
 * ------------------------------------------------------------------------ */
chrome.management.onInstalled.addListener(() => {
  // Debounce: events can arrive in bursts (e.g. bulk uninstall).
  schedulePayloadRefresh();
});

chrome.management.onUninstalled.addListener(() => {
  schedulePayloadRefresh();
});

chrome.management.onEnabled.addListener(() => {
  schedulePayloadRefresh();
});

chrome.management.onDisabled.addListener(() => {
  schedulePayloadRefresh();
});

let refreshTimer = null;

/**
 * Debounces refreshSyncPayload so rapid-fire management events collapse into
 * a single storage write.
 */
function schedulePayloadRefresh() {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
  }
  // 800ms coalescing window; setTimeout is safe here because the browser
  // keeps the worker alive long enough for the debounce to resolve, and even
  // if terminated prematurely the next popup open will re-sync anyway.
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSyncPayload();
  }, 800);
}

/**
 * Enumerates all installed extensions via chrome.management.getAll(),
 * excludes THIS extension, and serializes an array of minimal, portable
 * records into chrome.storage.sync so it propagates across browser profiles.
 *
 * The payload deliberately keeps only essential fields to respect the
 * 8 KB-per-item / 100 KB-total chrome.storage.sync quota.
 *
 * @returns {Promise<Array<Object>>} the serialized payload that was stored
 */
async function refreshSyncPayload() {
  try {
    const allExtensions = await chrome.management.getAll();

    const selfId = chrome.runtime.id;

    // Reduce each ExtensionInfo to a compact, serializable record.
    const payload = allExtensions
      .filter((ext) => ext.id !== selfId && ext.type === 'extension')
      .map((ext) => ({
        name: ext.name,
        id: ext.id,
        version: ext.version,
        enabled: ext.enabled,
        installType: ext.installType || 'unknown',
        webStoreUrl: buildWebStoreUrl(ext.id)
      }));

    // Persist to sync storage (cross-account propagation).
    await chrome.storage.sync.set({
      [STORAGE_KEYS.SYNC_PAYLOAD]: payload
    });

    // Also fan out to the custom endpoint if the user configured one.
    await pushToCustomEndpoint(payload);

    await chrome.storage.local.set({
      [STORAGE_KEYS.LAST_SYNC_AT]: Date.now()
    });

    return payload;
  } catch (error) {
    console.error('[ExtensionSync] refreshSyncPayload failed:', error);
    // Fall back to the previously stored payload so we never hard-crash.
    const { [STORAGE_KEYS.SYNC_PAYLOAD]: cached = [] } =
      await chrome.storage.sync.get(STORAGE_KEYS.SYNC_PAYLOAD);
    return cached;
  }
}

/* --------------------------------------------------------------------------
 * CUSTOM ENDPOINT SYNC (Power-User Webhook)
 * ------------------------------------------------------------------------ */

/**
 * POSTs the current payload to a user-configured REST endpoint / webhook.
 * Requires a CORS-enabled endpoint and HTTPS host permission if deployed —
 * for the default (no endpoint configured) case this is a no-op.
 *
 * @param {Array<Object>} payload — the serialized extension records
 * @returns {Promise<boolean>} true if pushed, false if skipped or failed
 */
async function pushToCustomEndpoint(payload = []) {
  const { [STORAGE_KEYS.CUSTOM_ENDPOINT]: endpoint = '' } =
    await chrome.storage.local.get(STORAGE_KEYS.CUSTOM_ENDPOINT);

  if (!endpoint || !/^https:\/\//i.test(endpoint)) {
    return false; // No valid HTTPS endpoint configured.
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Include a lightweight envelope with schema version + timestamp so a
      // downstream service can version/paginate if needed.
      body: JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        syncedAt: new Date().toISOString(),
        extensions: payload
      })
    });

    if (!response.ok) {
      console.error('[ExtensionSync] custom endpoint responded', response.status);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[ExtensionSync] custom endpoint fetch failed:', error);
    return false;
  }
}

/* --------------------------------------------------------------------------
 * MESSAGE HANDLING — popup ⇄ service worker
 *
 * IMPORTANT (MV3): because sendResponse may be invoked asynchronously inside
 * an async handler, we MUST return `true` from the listener to keep the
 * message channel open. Every branch routes through sendResponse exactly once.
 * ------------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Guard against malformed messages.
  if (!message || typeof message !== 'object' || !message.type) {
    sendResponse({ ok: false, error: 'Invalid message shape' });
    return false; // synchronous response issued — channel can close
  }

  switch (message.type) {
    case 'GET_PAYLOAD': {
      // Popup asks for the current serialized snapshot.
      void (async () => {
        let { [STORAGE_KEYS.SYNC_PAYLOAD]: payload = [] } =
          await chrome.storage.sync.get(STORAGE_KEYS.SYNC_PAYLOAD);
        const { [STORAGE_KEYS.LAST_SYNC_AT]: lastSyncAt = null } =
          await chrome.storage.local.get(STORAGE_KEYS.LAST_SYNC_AT);

        // If the persisted payload is empty (e.g. the worker was terminated
        // before the initial scan, or storage was cleared), recompute it live
        // so the popup always sees real data.
        if (!Array.isArray(payload) || payload.length === 0) {
          payload = await refreshSyncPayload();
        }

        sendResponse({ ok: true, payload, lastSyncAt });
      })();
      return true; // async response
    }

    case 'REFRESH_PAYLOAD': {
      // Popup (or UI action) forces an immediate re-scan of installed exts.
      void (async () => {
        const payload = await refreshSyncPayload();
        sendResponse({ ok: true, payload });
      })();
      return true;
    }

    case 'PUSH_TO_CUSTOM_ENDPOINT': {
      // Push current payload to user endpoint without re-scanning.
      void (async () => {
        const { [STORAGE_KEYS.SYNC_PAYLOAD]: payload = [] } =
          await chrome.storage.sync.get(STORAGE_KEYS.SYNC_PAYLOAD);
        const pushed = await pushToCustomEndpoint(payload);
        sendResponse({ ok: true, pushed });
      })();
      return true;
    }

    case 'SET_CUSTOM_ENDPOINT': {
      // Persist the user's webhook URL (validated in the popup).
      void (async () => {
        const url = typeof message.url === 'string' ? message.url.trim() : '';
        await chrome.storage.local.set({ [STORAGE_KEYS.CUSTOM_ENDPOINT]: url });
        sendResponse({ ok: true });
      })();
      return true;
    }

    case 'GET_CUSTOM_ENDPOINT': {
      void (async () => {
        const { [STORAGE_KEYS.CUSTOM_ENDPOINT]: endpoint = '' } =
          await chrome.storage.local.get(STORAGE_KEYS.CUSTOM_ENDPOINT);
        sendResponse({ ok: true, endpoint });
      })();
      return true;
    }

    default: {
      sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      return false;
    }
  }
});
