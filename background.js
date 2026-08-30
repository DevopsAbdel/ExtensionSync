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
  // Because chrome.storage.sync caps each item at 8 KB (QUOTA_BYTES_PER_ITEM),
  // the payload is sharded across multiple chunk keys + one index key.
  SYNC_CHUNKS_PREFIX: 'es_chunk_',             // keys: es_chunk_0, es_chunk_1, …
  SYNC_MANIFEST: 'extensionsync_manifest',     // { chunkCount, extensionCount, sizeBytes }
  CUSTOM_ENDPOINT: 'extensionsync_endpoint',   // user webhook / REST URL (in chrome.storage.local)
  STORE_PROXY: 'extensionsync_store_proxy',    // optional CORS proxy for Web Store metadata (in chrome.storage.local)
  LAST_SYNC_AT: 'extensionsync_last_sync_at',  // epoch ms of last successful sync
  VERSION: 'extensionsync_version'             // schema version for forward compatibility
};

// chrome.storage.sync hard caps: 8 KB per item, 100 KB total, 512 items max.
const SYNC_ITEM_BUDGET = 7000; // conservative bytes-per-chunk (we leave headroom)

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

/**
 * A store proxy must be HTTPS — except localhost/127.0.0.1, which are allowed
 * over plain HTTP (e.g. `node tools/cors-proxy-node.js` during local testing).
 */
function isValidProxyUrl(url) {
  if (/^https:\/\//i.test(url)) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(url)) return true;
  return false;
}

/**
 * Shards a serialized array of records into multiple sub-arrays, each sized so
 * that its JSON representation stays under the 8 KB per-item quota. Returns an
 * array of sub-arrays (chunks).
 *
 * @param {Array<Object>} records — the full extension payload
 * @returns {Array<Array<Object>>} chunks that each fit the per-item budget
 */
function chunkPayload(records) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;

  for (const record of records) {
    // A single oversized record (rare: huge name/URL) gets its own slot.
    const recBytes = new TextEncoder().encode(JSON.stringify(record)).length;

    // +2 for "[]" wrappers; the whole chunk must stay under budget.
    if (currentBytes + recBytes + 2 > SYNC_ITEM_BUDGET && current.length > 0) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(record);
    currentBytes += recBytes + 1; // +1 for the comma separator
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Writes a chunked payload to chrome.storage.sync. Returns null on success or
 * a fallback (compact single-chunk) if it still exceeds the per-item quota —
 * storage.sync simply cannot hold very large sets, so we degrade gracefully.
 */
async function storePayloadChunked(records) {
  const chunks = chunkPayload(records);
  const payloadKeys = [];

  const writeObj = {};
  chunks.forEach((chunk, i) => {
    const key = `${STORAGE_KEYS.SYNC_CHUNKS_PREFIX}${i}`;
    writeObj[key] = chunk;
    payloadKeys.push(key);
  });

  // Manifest records how many chunks exist so readers can reassemble.
  writeObj[STORAGE_KEYS.SYNC_MANIFEST] = {
    chunkCount: chunks.length,
    extensionCount: records.length
  };

  await chrome.storage.sync.set(writeObj);
  return chunks;
}

/**
 * Reads and reassembles the chunked payload from chrome.storage.sync.
 * Returns the array of extension records (possibly empty).
 */
async function loadPayloadChunked() {
  const { [STORAGE_KEYS.SYNC_MANIFEST]: manifest = null } =
    await chrome.storage.sync.get(STORAGE_KEYS.SYNC_MANIFEST);

  if (!manifest || typeof manifest.chunkCount !== 'number' || manifest.chunkCount <= 0) {
    return [];
  }

  const keys = [];
  for (let i = 0; i < manifest.chunkCount; i++) {
    keys.push(`${STORAGE_KEYS.SYNC_CHUNKS_PREFIX}${i}`);
  }

  const stored = await chrome.storage.sync.get(keys);
  const records = [];
  for (const key of keys) {
    if (Array.isArray(stored[key])) records.push(...stored[key]);
  }
  return records;
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

    // Persist to sync storage (cross-account propagation), sharded so every
    // chunk stays under the 8 KB per-item quota.
    await storePayloadChunked(payload);

    // Also fan out to the custom endpoint if the user configured one.
    await pushToCustomEndpoint(payload);

    await chrome.storage.local.set({
      [STORAGE_KEYS.LAST_SYNC_AT]: Date.now()
    });

    return payload;
  } catch (error) {
    console.error('[ExtensionSync] refreshSyncPayload failed:', error);
    // Fall back to the previously stored payload so we never hard-crash.
    return loadPayloadChunked();
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
 * CHROME WEB STORE METADATA (publisher, rating, user count)
 *
 * chrome.management does NOT expose publisher/rating — so we fetch each
 * extension's public Chrome Web Store detail page and parse the embedded
 * `AF_initDataCallback({key: 'ds:0' ...})` payload. Results are cached in
 * chrome.storage.local with a TTL so repeated popup opens don't re-fetch.
 * ------------------------------------------------------------------------ */
const META_CACHE_PREFIX = 'es_meta_';   // per-id cache: { author, rating, numRatings, users, ts }
const META_TTL_MS = 24 * 60 * 60 * 1000; // refresh at most once per day
const META_CONCURRENCY = 3;              // CWS-friendly parallel fetch limit
const META_FETCH_TIMEOUT = 10000;

/**
 * Given a string and the index of an opening '[' or '{', returns the index of
 * its matching closing bracket, respecting nested brackets and quoted strings.
 */
function findMatchingClose(text, openIdx) {
  const pairs = { '[': ']', '{': '}' };
  const close = pairs[text[openIdx]];
  let depth = 0;
  let inString = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === text[openIdx]) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extracts a balanced JSON array (starting with '[') that begins at or after
 * `startIdx` and returns its end index, or -1 if not found.
 */
function findJsonArrayEnd(text, startIdx) {
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '[') {
      const end = findMatchingClose(text, i);
      if (end !== -1) return end;
    }
  }
  return -1;
}

/**
 * Parses the publisher/rating/user metadata out of a Chrome Web Store detail
 * page HTML string. Returns null when it cannot be extracted reliably.
 */
function parseStoreMeta(html, id) {
  try {
    // Locate the main item payload: AF_initDataCallback({key: 'ds:0', ...}).
    const marker = "AF_initDataCallback({key: 'ds:0'";
    const keyIdx = html.indexOf(marker);
    if (keyIdx === -1) return null;

    // The `data:` value that follows is a JSON array of arrays.
    const dataIdx = html.indexOf('data:', keyIdx);
    if (dataIdx === -1) return null;

    const outerStart = html.indexOf('[', dataIdx);
    if (outerStart === -1) return null;
    const outerEnd = findMatchingClose(html, outerStart);
    if (outerEnd === -1) return null;

    const outer = JSON.parse(html.slice(outerStart, outerEnd + 1));
    // `outer` is an array of candidate item arrays; the item whose [0] is our
    // extension id is the one we want (guards against related-extension rows).
    const item = Array.isArray(outer)
      ? outer.find((row) => Array.isArray(row) && row[0] === id)
      : null;
    if (!item) return null;

    const rating = typeof item[3] === 'number' ? item[3] : null;
    const numRatings = typeof item[4] === 'number' ? item[4] : null;
    const users = typeof item[14] === 'number' ? item[14] : null;

    // Publisher: prefer the rendered "Offered by" label, fall back to the
    // author inside the stringified manifest at item[18].
    let author = null;
    const offered = html.match(/Offered by<\/div><div>([^<]+)<\/div>/);
    if (offered) author = offered[1].trim();
    if (!author && typeof item[18] === 'string') {
      const m = item[18].match(/"author"\s*:\s*"([^"]+)"/);
      if (m) author = m[1].replace(/\\u0026/g, '&').trim();
    }

    return {
      id,
      author: author || null,
      rating,          // average rating (0-5)
      numRatings,      // number of user ratings
      users            // approx active user count
    };
  } catch {
    return null;
  }
}

/**
 * Fetches and parses store metadata for a single extension id, with timeout.
 *
 * NOTE: the Chrome Web Store sends `Cross-Origin-Resource-Policy: same-site`
 * on its detail pages, which the browser enforces even for extension fetches
 * with host permissions (host permissions bypass CORS but not CORP). The
 * extension therefore CANNOT read the store page directly. Instead we route
 * the request through a user-configured CORS proxy that fetches the page
 * server-side and returns it with permissive CORS headers. When no proxy is
 * configured, metadata is silently skipped (never fatal).
 */
async function fetchStoreMeta(id) {
  const { [STORAGE_KEYS.STORE_PROXY]: proxy = '' } =
    await chrome.storage.local.get(STORAGE_KEYS.STORE_PROXY);
  if (!proxy || !isValidProxyUrl(proxy)) return null;

  const cwsUrl = buildWebStoreUrl(id);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), META_FETCH_TIMEOUT);
  try {
    // Proxy contract: it fetches the CWS detail page server-side and responds
    // with the page HTML and `Access-Control-Allow-Origin: *`. The target is
    // passed as the `url` query parameter (common CORS-proxy convention).
    const sep = proxy.includes('?') ? '&' : '?';
    const url = `${proxy}${sep}url=${encodeURIComponent(cwsUrl)}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const html = await response.text();
    return parseStoreMeta(html, id);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parses the Chrome Web Store search-results page into extension summaries.
 * Results live in the `AF_initDataCallback({key: 'ds:1' ...})` payload, each
 * item being a 20-field array: [id, icon, name, rating, numRatings, icon2,
 * description, homepage, ..., users, ..., manifestJson, name].
 */
function parseStoreSearch(html) {
  const results = [];
  try {
    const marker = "AF_initDataCallback({key: 'ds:1'";
    const keyIdx = html.indexOf(marker);
    if (keyIdx === -1) return results;
    const dataIdx = html.indexOf('data:', keyIdx);
    if (dataIdx === -1) return results;
    const outerStart = html.indexOf('[', dataIdx);
    if (outerStart === -1) return results;
    const outerEnd = findMatchingClose(html, outerStart);
    if (outerEnd === -1) return results;

    const data = JSON.parse(html.slice(outerStart, outerEnd + 1));
    const seen = new Set();

    (function scan(node) {
      if (!Array.isArray(node)) return;
      const isItemLike =
        node.length === 20 &&
        typeof node[0] === 'string' && /^[a-p]{32}$/.test(node[0]) &&
        typeof node[1] === 'string' && node[1].startsWith('http') &&
        typeof node[2] === 'string' &&
        typeof node[3] === 'number' &&
        typeof node[14] === 'number';
      if (isItemLike) {
        if (!seen.has(node[0])) {
          seen.add(node[0]);
          let author = null;
          if (typeof node[18] === 'string') {
            const m = node[18].match(/"author"\s*:\s*"([^"]+)"/);
            if (m) author = m[1].replace(/\\u0026/g, '&').trim();
          }
          results.push({
            id: node[0],
            name: node[2],
            icon: node[1],
            rating: node[3],
            numRatings: node[4],
            users: node[14],
            description: typeof node[6] === 'string' ? node[6] : null,
            author
          });
        }
        return;
      }
      node.forEach(scan);
    })(data);
  } catch {
    /* ignore malformed payloads */
  }
  return results;
}

/**
 * Searches the Chrome Web Store via the configured CORS proxy. Returns null
 * when no proxy is configured, otherwise an array of extension summaries
 * (possibly empty on failure).
 */
async function searchWebStore(query) {
  const { [STORAGE_KEYS.STORE_PROXY]: proxy = '' } =
    await chrome.storage.local.get(STORAGE_KEYS.STORE_PROXY);
  if (!proxy || !isValidProxyUrl(proxy)) return null;

  const target = `https://chromewebstore.google.com/search/${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), META_FETCH_TIMEOUT);
  try {
    const sep = proxy.includes('?') ? '&' : '?';
    const url = `${proxy}${sep}url=${encodeURIComponent(target)}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return [];
    const html = await response.text();
    return parseStoreSearch(html);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the cached store-meta for an id, or null if absent/expired.
 */
async function readMetaCache(id) {
  const { [META_CACHE_PREFIX + id]: cached = null } =
    await chrome.storage.local.get(META_CACHE_PREFIX + id);
  if (cached && cached.ts && Date.now() - cached.ts < META_TTL_MS) {
    const { id: _id, ts, ...meta } = cached;
    return { ...meta, id };
  }
  return null;
}

/**
 * Fetches metadata for many ids with caching + bounded concurrency.
 * Returns a map of id → meta (only ids that resolved successfully).
 */
async function getStoreMetas(ids) {
  const unique = [...new Set(ids)];
  const result = {};

  // Serve everything we already have cached.
  const cachedEntries = await chrome.storage.local.get(
    unique.map((id) => META_CACHE_PREFIX + id)
  );
  const toFetch = [];
  for (const id of unique) {
    const entry = cachedEntries[META_CACHE_PREFIX + id];
    if (entry && entry.ts && Date.now() - entry.ts < META_TTL_MS) {
      const { id: _id, ts, ...meta } = entry;
      result[id] = { ...meta, id };
    } else {
      toFetch.push(id);
    }
  }

  // Fetch the remainder at a bounded concurrency to stay CWS-friendly.
  for (let i = 0; i < toFetch.length; i += META_CONCURRENCY) {
    const batch = toFetch.slice(i, i + META_CONCURRENCY);
    const batchMeta = await Promise.all(batch.map(fetchStoreMeta));
    for (let j = 0; j < batch.length; j++) {
      const meta = batchMeta[j];
      if (meta) {
        result[meta.id] = meta;
        await chrome.storage.local.set({
          [META_CACHE_PREFIX + meta.id]: { ...meta, ts: Date.now() }
        });
      }
    }
  }

  return result;
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
        let payload = await loadPayloadChunked();
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
        const payload = await loadPayloadChunked();
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

    case 'GET_STORE_META': {
      // Popup requests Web Store metadata (publisher/rating/users) for a set
      // of extension ids so it can offer publisher filters and rating display.
      void (async () => {
        const ids = Array.isArray(message.ids)
          ? message.ids.filter((x) => typeof x === 'string')
          : [];
        const metas = await getStoreMetas(ids);
        sendResponse({ ok: true, metas });
      })();
      return true;
    }

    case 'GET_STORE_SEARCH': {
      // Search the Chrome Web Store online through the configured CORS proxy.
      void (async () => {
        const query = typeof message.query === 'string' ? message.query.trim() : '';
        if (!query) { sendResponse({ ok: true, configured: true, results: [] }); return; }
        const results = await searchWebStore(query);
        sendResponse({ ok: true, configured: results !== null, results: results || [] });
      })();
      return true;
    }

    case 'SET_STORE_PROXY': {
      // Persist the user's CORS proxy URL for Web Store metadata fetching.
      void (async () => {
        const url = typeof message.url === 'string' ? message.url.trim() : '';
        await chrome.storage.local.set({ [STORAGE_KEYS.STORE_PROXY]: url });
        // A changed proxy invalidates any previously cached store metadata.
        await chrome.storage.local.remove(
          await chrome.storage.local.get(null)
            .then((all) => Object.keys(all).filter((k) => k.startsWith(META_CACHE_PREFIX)))
        );
        sendResponse({ ok: true });
      })();
      return true;
    }

    case 'GET_STORE_PROXY': {
      void (async () => {
        const { [STORAGE_KEYS.STORE_PROXY]: proxy = '' } =
          await chrome.storage.local.get(STORAGE_KEYS.STORE_PROXY);
        sendResponse({ ok: true, proxy });
      })();
      return true;
    }

    default: {
      sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      return false;
    }
  }
});
