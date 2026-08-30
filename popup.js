/**
 * ExtensionSync — Popup Controller
 * =================================
 * All UI orchestration lives here. The popup is recreated from scratch on
 * every click of the toolbar icon, so:
 *   - State is hydrated from chrome.storage on DOMContentLoaded.
 *   - The service worker is the source of truth for the payload; the popup
 *     either reads it from storage or sends a message to refresh it.
 *
 * MV3 note: no inline scripts allowed — everything is this file.
 */

/* --------------------------------------------------------------------------
 * DOM REFERENCES
 * ------------------------------------------------------------------------ */
const dom = {
  // Header
  syncStatus: document.getElementById('sync-status'),

  // Tabs
  tabBar: document.querySelector('.tab-bar'),

  // Panels
  panelExport: document.getElementById('panel-export'),
  panelImport: document.getElementById('panel-import'),
  panelSettings: document.getElementById('panel-settings'),

  // Export
  searchInput: document.getElementById('search-input'),
  searchClearBtn: document.getElementById('search-clear-btn'),
  exportAllBtn: document.getElementById('export-all-btn'),
  exportSelectedBtn: document.getElementById('export-selected-btn'),
  clearSelectionBtn: document.getElementById('clear-selection-btn'),
  extensionGrid: document.getElementById('extension-grid'),
  gridLoading: document.getElementById('grid-loading'),
  listMeta: document.getElementById('list-meta'),
  extensionCount: document.getElementById('extension-count'),
  stateSummary: document.getElementById('state-summary'),
  selectAllBtn: document.getElementById('select-all-btn'),
  selectionBar: document.getElementById('selection-bar'),
  selectionCount: document.getElementById('selection-count'),
  toast: document.getElementById('toast'),

  // Import
  dropzone: document.getElementById('dropzone'),
  importFile: document.getElementById('import-file'),
  importDashboard: document.getElementById('import-dashboard'),
  importSummary: document.getElementById('import-summary'),
  importList: document.getElementById('import-list'),
  initializeSyncBtn: document.getElementById('initialize-sync-btn'),
  clearImportBtn: document.getElementById('clear-import-btn'),
  launchProgress: document.getElementById('launch-progress'),
  launchProgressText: document.getElementById('launch-progress-text'),

  // Settings
  lastSyncTime: document.getElementById('last-sync-time'),
  forceSyncBtn: document.getElementById('force-sync-btn'),
  endpointInput: document.getElementById('endpoint-input'),
  saveEndpointBtn: document.getElementById('save-endpoint-btn'),
  endpointStatus: document.getElementById('endpoint-status')
};

/* --------------------------------------------------------------------------
 * POPUP STATE
 * ------------------------------------------------------------------------ */
const state = {
  extensions: [],     // live list of installed extensions (export view)
  selected: new Set(), // ids checked for import launch
  filter: ''
};

/* --------------------------------------------------------------------------
 * UTILITIES
 * ------------------------------------------------------------------------ */

/** Escapes a string for safe insertion into HTML text content. */
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

/** Abbreviates an extension id for compact display. */
function shortId(id) {
  return id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/** Formats an epoch timestamp into a human-readable string. */
function formatTime(epoch) {
  if (!epoch) return 'Never';
  const d = new Date(epoch);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

/** Sets the header sync-status indicator. */
function setSyncStatus(mode) {
  dom.syncStatus.dataset.state = mode; // 'synced' | 'pending' | 'error' | 'idle'
}

/** Shows a transient global toast notification from any panel. */
function showToast(message, type = 'success') {
  clearTimeout(showToast._t);
  dom.toast.textContent = message;
  dom.toast.className = `toast is-${type}`;
  // Force reflow so the entrance transition restarts on repeated toasts.
  void dom.toast.offsetWidth;
  showToast._t = setTimeout(() => dom.toast.classList.add('is-hidden'), 3000);
}

/** Legacy alias so existing callers keep working. */
function showCallout(message, type = 'success', autoHide = true) {
  showToast(message, type);
}

/** Sends a message to the background service worker and returns its response. */
async function sendToBackground(message) {
  return chrome.runtime.sendMessage(message);
}

/** Detects the Chromium-based browser. */
async function detectBrowser() {
  // Brave removes "Brave" from its User-Agent by default, but exposes the
  // navigator.brave.isBrave() flag marker — check it before the UA fallback.
  try {
    if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
      if (await navigator.brave.isBrave()) return 'Brave';
    }
  } catch {
    /* detection unavailable — fall through to UA */
  }
  const ua = navigator.userAgent;
  if (/Edg\/\d/.test(ua)) return 'Edge';
  if (/Vivaldi/.test(ua)) return 'Vivaldi';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Brave/.test(ua)) return 'Brave';
  if (/Chrome\/\d/.test(ua)) return 'Chrome';
  if (/Chromium\/\d/.test(ua)) return 'Chromium';
  return 'Browser';
}

/**
 * Derives a compact, filesystem-safe profile label. Returns the signed-in
 * account email (if the browser exposes it via identity.getProfileUserInfo,
 * no token/OAuth popup required) — otherwise a sanitized hostname.
 */
async function detectProfileLabel() {
  try {
    const info = await chrome.identity.getProfileUserInfo();
    const email = (info && info.email) || '';
    if (/^[^@\s]+@[^@\s]+$/.test(email)) {
      // Use the local part, e.g. "john.doe" — safe for filenames.
      return email.split('@')[0].replace(/[^\w.-]+/g, '_') || 'No_Profil';
    }
  } catch {
    /* identity unavailable — fall through */
  }
  return 'No_Profil';
}

/** YYYY-MM-DD (UTC, local date is fine for backups) */
function dateStamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* --------------------------------------------------------------------------
 * TAB NAVIGATION
 * ------------------------------------------------------------------------ */
function activateTab(tabName) {
  // Update button active state.
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const isActive = btn.dataset.tab === tabName;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  // Toggle panels.
  dom.panelExport.hidden = tabName !== 'export';
  dom.panelImport.hidden = tabName !== 'import';
  dom.panelSettings.hidden = tabName !== 'settings';

  // Load per-panel data when switching tabs.
  if (tabName === 'export') {
    loadExtensions();
  } else if (tabName === 'settings') {
    loadSettingsView();
  }
}

dom.tabBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (btn) activateTab(btn.dataset.tab);
});

/* --------------------------------------------------------------------------
 * EXPORT — load & render installed extensions
 * ------------------------------------------------------------------------ */

/**
 * Reads the current sync payload from the background worker (which already
 * persists it to chrome.storage.sync). Falls back to storage if the worker
 * is unresponsive.
 */
async function loadExtensions() {
  setSyncStatus('pending');
  dom.gridLoading.classList.remove('is-hidden');
  dom.extensionGrid.innerHTML = '';
  try {
    // The popup has the management permission, so enumerate live extensions
    // DIRECTLY. Never trust a possibly-empty persisted payload — the payload
    // is only a cache for cross-device sync, not the source of truth.
    const all = await chrome.management.getAll();
    const selfId = chrome.runtime.id;

    state.extensions = all
      .filter((ext) => ext.id !== selfId && ext.type === 'extension')
      .map((ext) => ({
        name: ext.name,
        id: ext.id,
        version: ext.version,
        enabled: ext.enabled,
        mayDisable: ext.mayDisable,
        installType: ext.installType || 'unknown',
        webStoreUrl: `https://chromewebstore.google.com/detail/-/${ext.id}`
      }));

    setSyncStatus('synced');
    renderExportGrid();

    // Opportunistically refresh the background payload so cloud sync is up
    // to date; failures here must not break the grid we already rendered.
    try {
      sendToBackground({ type: 'REFRESH_PAYLOAD' });
    } catch {
      /* background refresh is best-effort */
    }
  } catch (error) {
    setSyncStatus('error');
    // Fall back to the synced payload if management enumeration fails.
    // Ask the background worker, which reassembles the chunked payload.
    try {
      const res = await sendToBackground({ type: 'GET_PAYLOAD' });
      if (res?.ok && Array.isArray(res.payload) && res.payload.length > 0) {
        state.extensions = res.payload;
      }
    } catch {
      /* background unreachable */
    }
    renderExportGrid();
  }
}

/** Re-renders the export grid honoring the current search filter. */
function renderExportGrid() {
  dom.gridLoading.classList.add('is-hidden');
  const filter = state.filter.trim().toLowerCase();

  const visible = state.extensions.filter((ext) =>
    !filter || ext.name.toLowerCase().includes(filter) || ext.id.includes(filter)
  );

  dom.extensionCount.textContent = `${state.extensions.length} extension${state.extensions.length === 1 ? '' : 's'}`;

  // Enabled / disabled summary.
  const enabledCount = state.extensions.filter((e) => e.enabled).length;
  dom.stateSummary.textContent =
    `${enabledCount} active · ${state.extensions.length - enabledCount} off`;

  if (state.extensions.length === 0) {
    dom.extensionGrid.innerHTML = renderEmptyState(
      'No extensions found',
      'ExtensionSync could not enumerate your installed extensions.',
      'refresh'
    );
    dom.selectAllBtn.textContent = 'Select all';
    dom.selectAllBtn.dataset.state = 'none';
    updateSelectionBar();
    return;
  }

  if (visible.length === 0) {
    dom.extensionGrid.innerHTML = renderEmptyState(
      `No matches for “${escapeHtml(state.filter.trim())}”`,
      'Try a different name or extension ID.',
      'clear'
    );
    dom.selectAllBtn.textContent = 'Select all';
    dom.selectAllBtn.dataset.state = 'none';
    updateSelectionBar();
    return;
  }

  dom.extensionGrid.innerHTML = visible
    .map((ext) => renderExtensionCard(ext))
    .join('');

  // Determine select-all state.
  const allVisibleSelected = visible.length > 0 && visible.every((ext) => state.selected.has(ext.id));
  dom.selectAllBtn.textContent = allVisibleSelected ? 'Deselect all' : 'Select all';
  dom.selectAllBtn.dataset.state = allVisibleSelected ? 'all' : (state.selected.size > 0 ? 'some' : 'none');
  updateSelectionBar();
}

/** Toggles the sticky selection action bar based on the current selection. */
function updateSelectionBar() {
  const count = state.selected.size;
  const anySelected = count > 0;
  dom.selectionBar.classList.toggle('is-hidden', !anySelected);
  dom.selectionBar.classList.toggle('has-selection', anySelected);
  dom.selectionCount.textContent = `${count} selected`;
}

function renderEmptyState(title, hint, action) {
  const actionHtml = action === 'clear'
    ? '<button id="empty-clear-btn" class="btn-outline btn-sm" type="button">Clear search</button>'
    : action === 'refresh'
      ? '<button id="empty-refresh-btn" class="btn-outline btn-sm" type="button">Try again</button>'
      : '';
  return `
    <div class="empty-state">
      <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
      <p>${escapeHtml(title)}</p>
      <p class="empty-hint">${escapeHtml(hint)}</p>
      ${actionHtml}
    </div>`;
}

/**
 * Renders a single extension card with a selection checkbox. Selection drives
 * the bulk "Export Selected" action as well as the individual enable/disable
 * toggle.
 */
function renderExtensionCard(ext) {
  const isSelected = state.selected.has(ext.id);
  const initials = (ext.name || '?').slice(0, 2).toUpperCase();

  return `
    <article class="ext-card ${isSelected ? 'is-selected' : ''}" data-id="${escapeHtml(ext.id)}">
      <label class="sel-check" title="Select ${escapeHtml(ext.name)}">
        <input
          type="checkbox"
          data-action="select-exp"
          data-id="${escapeHtml(ext.id)}"
          ${isSelected ? 'checked' : ''}
        >
        <span class="sel-check-box"></span>
      </label>
      <div class="ext-icon">${escapeHtml(initials)}</div>
      <div class="ext-info">
        <div class="ext-name" title="${escapeHtml(ext.name)}">${escapeHtml(ext.name)}</div>
        <div class="ext-sub" title="${escapeHtml(ext.id)}">v${escapeHtml(ext.version)} · ${escapeHtml(shortId(ext.id))}</div>
      </div>
      <span class="ext-status ${ext.enabled ? 'is-enabled' : 'is-disabled'}">
        ${ext.enabled ? 'ON' : 'OFF'}
      </span>
      <label class="toggle" title="${ext.enabled ? 'Disable extension' : 'Enable extension'}">
        <input
          type="checkbox"
          data-action="toggle-exp"
          data-id="${escapeHtml(ext.id)}"
          ${ext.enabled ? 'checked' : ''}
          ${ext.mayDisable === false ? 'disabled' : ''}
        >
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
      </label>
    </article>`;
}

/** Search filter input. */
dom.searchInput.addEventListener('input', (e) => {
  state.filter = e.target.value;
  dom.searchClearBtn.classList.toggle('is-hidden', !state.filter);
  renderExportGrid();
});

/** Clear the search filter. */
function clearSearch() {
  state.filter = '';
  dom.searchInput.value = '';
  dom.searchClearBtn.classList.add('is-hidden');
  renderExportGrid();
}
dom.searchClearBtn.addEventListener('click', clearSearch);

/** Per-card selection from the grid. */
dom.extensionGrid.addEventListener('change', (e) => {
  const selectInput = e.target.closest('input[data-action="select-exp"]');
  if (selectInput) {
    if (selectInput.checked) {
      state.selected.add(selectInput.dataset.id);
    } else {
      state.selected.delete(selectInput.dataset.id);
    }
    renderExportGrid();
    return;
  }

  const toggleInput = e.target.closest('input[data-action="toggle-exp"]');
  if (!toggleInput) return;

  const ext = state.extensions.find((x) => x.id === toggleInput.dataset.id);
  if (!ext) return;

  // chrome.management.setEnabled requires a user gesture; the change event
  // qualifies. May show a native confirmation dialog for disabledExtension.
  chrome.management.setEnabled(ext.id, toggleInput.checked).catch((err) => {
    toggleInput.checked = !toggleInput.checked; // rollback toggle on failure
    showCallout(`Could not ${toggleInput.checked ? 'enable' : 'disable'} ${ext.name}`, 'error');
  });
});

/** Actions rendered inside the empty-state (clear search / try again). */
dom.extensionGrid.addEventListener('click', (e) => {
  if (e.target.closest('#empty-clear-btn')) clearSearch();
  if (e.target.closest('#empty-refresh-btn')) loadExtensions();
});

/** "Select all / Deselect" for bulk export. */
dom.selectAllBtn.addEventListener('click', () => {
  const filter = state.filter.trim().toLowerCase();
  const visible = state.extensions.filter((ext) =>
    !filter || ext.name.toLowerCase().includes(filter) || ext.id.includes(filter)
  );

  const allSelected = visible.length > 0 && visible.every((ext) => state.selected.has(ext.id));

  if (allSelected) {
    visible.forEach((ext) => state.selected.delete(ext.id));
  } else {
    visible.forEach((ext) => state.selected.add(ext.id));
  }
  renderExportGrid();
});

/** Clear the current selection. */
dom.clearSelectionBtn.addEventListener('click', () => {
  state.selected.clear();
  renderExportGrid();
});

/* --------------------------------------------------------------------------
 * EXPORT — serialize & download backup
 * ------------------------------------------------------------------------ */

/**
 * Enriches a native ExtensionInfo object into a clean, human-readable backup
 * record. Sorted and structured so the resulting JSON file is both easy to
 * read and machine-parsable.
 */
function toBackupRecord(ext) {
  // Pick the largest icon for a nicer document.
  const bestIcon = (ext.icons || []).reduce((acc, icon) =>
    !acc || icon.size > acc.size ? icon : acc, null);

  return {
    // --- identification ---
    name: ext.name || 'Untitled',
    id: ext.id,
    version: ext.version,
    versionName: ext.versionName || null,
    description: ext.description || '',
    shortName: ext.shortName || null,

    // --- state ---
    enabled: ext.enabled,
    disabledReason: ext.disabledReason || null,
    mayDisable: ext.mayDisable,
    mayEnable: ext.mayEnable,
    installType: ext.installType || 'unknown',
    type: ext.type || 'extension',

    // --- where it lives / links ---
    webStoreUrl: `https://chromewebstore.google.com/detail/-/${ext.id}`,
    optionsUrl: ext.optionsUrl || null,
    homepageUrl: ext.homepageUrl || null,
    updateUrl: ext.updateUrl || null,

    // --- capabilities ---
    permissions: (ext.permissions || []).sort(),
    hostPermissions: (ext.hostPermissions || []).sort(),

    // --- presentation ---
    iconUrl: (bestIcon && bestIcon.url) || null,
    iconSize: (bestIcon && bestIcon.size) || null
  };
}

/**
 * Builds the backup JSON blob and saves it via the downloads API.
 *
 * The file is named `yyyy-mm-dd_Extensions_{browser}_{profile}.json` and is
 * pretty-printed (2-space indent) so it reads cleanly by hand while remaining
 * fully machine-parseable. A rich metadata header describes the source browser,
 * profile, and export time.
 *
 * Note: the download is triggered with a standard <a download> + blob URL
 * click inside the button's user gesture. The chrome.downloads.download API
 * has a long-standing Chromium bug that ignores `filename` for data:/blob:
 * URLs, which would save the file under the browser default (e.g.
 * "téléchargement"); the anchor download attribute reliably names the file.
 */
async function exportAll(appliedIds) {
  const isSubset = Array.isArray(appliedIds) && appliedIds.length > 0;
  const ids = isSubset ? new Set(appliedIds) : null;
  const btn = isSubset ? dom.exportSelectedBtn : dom.exportAllBtn;
  btn.disabled = true;
  setSyncStatus('pending');
  try {
    // Enumerate ALL extensions for an authoritative export (or filter to the
    // user's selection below).
    const all = await chrome.management.getAll();
    const selfId = chrome.runtime.id;

    const records = all
      .filter((ext) =>
        ext.id !== selfId &&
        ext.type === 'extension' &&
        (!ids || ids.has(ext.id)))
      .map(toBackupRecord)
      .sort((a, b) => a.name.localeCompare(b.name));

    const enabledCount = records.filter((r) => r.enabled).length;

    const browser = await detectBrowser();
    const profile = await detectProfileLabel();
    const now = new Date();

    // Comprehensive, self-describing document.
    const document_ = {
      schema: {
        name: 'ExtensionSync Backup',
        version: 1,
        description: 'A portable snapshot of installed browser extensions.'
      },
      metadata: {
        exportedAt: now.toISOString(),
        exportedAtLocal: now.toString(),
        browser,
        profile,
        extensionCount: records.length,
        enabledCount,
        disabledCount: records.length - enabledCount
      },
      extensions: records
    };

    // Pretty-print with 2-space indentation for readability.
    const json = JSON.stringify(document_, null, 2);

    // yyyy-mm-dd_Extensions_{browser}_{profile}.json — all path-safe.
    const filename = `${dateStamp(now)}_Extensions_${browser}_${profile}.json`;

    // Trigger the download via a standard <a download> + blob URL click.
    // The chrome.downloads.download API has a long-standing Chromium bug that
    // ignores the `filename` option for data:/blob: URLs (saving as the browser
    // default like "téléchargement"). An anchor download attribute, clicked
    // within this button's user gesture, reliably names the file.
    const blob = new Blob([json], { type: 'application/json' });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);

    showCallout(`Exported ${records.length} extension${records.length === 1 ? '' : 's'}`);
  } catch (error) {
    setSyncStatus('error');
    showCallout('Export failed. See console for details.', 'error');
    console.error('[ExtensionSync] export failed:', error);
  } finally {
    btn.disabled = false;
    setSyncStatus('synced');
  }
}

dom.exportAllBtn.addEventListener('click', () => exportAll());

/** Export only the currently selected extensions. */
dom.exportSelectedBtn.addEventListener('click', () => {
  exportAll([...state.selected]);
});

/* --------------------------------------------------------------------------
 * IMPORT — backup file upload & interactive wizard
 * ------------------------------------------------------------------------ */

/** Handles both drag-drop and the hidden file input. */
function handleImportFile(file) {
  if (!file) return;
  if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
    showCallout('Please select a JSON backup file', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      const extensions = Array.isArray(parsed?.extensions) ? parsed.extensions : [];

      // Validate each record minimally.
      const valid = extensions.filter(
        (ext) => ext && typeof ext === 'object' && typeof ext.id === 'string'
      );

      if (valid.length === 0) {
        showCallout('No valid extension records found in file', 'error');
        return;
      }

      renderImportDashboard(valid);
    } catch (err) {
      showCallout('Invalid JSON backup file', 'error');
      console.error('[ExtensionSync] import parse error:', err);
    }
  };
  reader.readAsText(file);
}

/* Dropzone click → open file picker. */
dom.dropzone.addEventListener('click', () => dom.importFile.click());

/* Keyboard accessibility: Enter or Space opens the picker. */
dom.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    dom.importFile.click();
  }
});

/* Drag & drop support. */
['dragenter', 'dragover'].forEach((evt) => {
  dom.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dom.dropzone.classList.add('is-dragover');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dom.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dom.dropzone.classList.remove('is-dragover');
  });
});
dom.dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  handleImportFile(file);
});

dom.importFile.addEventListener('change', (e) => {
  handleImportFile(e.target.files?.[0]);
  e.target.value = ''; // reset so re-selecting the same file re-triggers
});

/**
 * Renders the import dashboard (checklist of extensions to install).
 * Requires the "tabs" permission to detect already-installed extensions —
 * we instead check against the current payload and mark matches as
 * "Already installed".
 */
async function renderImportDashboard(extensions) {
  dom.dropzone.classList.add('is-hidden');
  dom.importDashboard.classList.remove('is-hidden');

  let installed = [];
  try {
    // Ask the background worker for the current (reassembled) payload so we
    // can mark extensions that are already installed on this browser.
    const res = await sendToBackground({ type: 'GET_PAYLOAD' });
    if (res?.ok && Array.isArray(res.payload)) {
      installed = res.payload;
    }
  } catch {
    // Background unreachable; degrade to showing every item as needing install.
    installed = [];
  }

  const installedIds = new Set(installed.map((e) => e.id));
  state.importData = extensions;

  dom.importSummary.textContent =
    `${extensions.length} extension${extensions.length === 1 ? '' : 's'} parsed from backup`;

  dom.importList.innerHTML = extensions
    .map((ext, idx) => {
      const already = installedIds.has(ext.id);
      const initials = (ext.name || '?').slice(0, 2).toUpperCase();
      return `
        <label class="import-item is-selected" data-index="${idx}">
          <span class="checkbox">
            <input type="checkbox" data-import-index="${idx}" ${already ? 'disabled' : ''} ${already ? '' : 'checked'}>
            <span class="checkbox-box"></span>
          </span>
          <span class="ext-icon">${escapeHtml(initials)}</span>
          <span class="ext-info">
            <span class="ext-name">${escapeHtml(ext.name || 'Unknown')}</span>
            <span class="ext-sub">v${escapeHtml(ext.version || '?')} · ${escapeHtml(shortId(ext.id))}</span>
          </span>
          ${already ? '<span class="already-installed">Installed</span>' : ''}
        </label>`;
    })
    .join('');

  syncImportSelectionUI();
}

function syncImportSelectionUI() {
  const checkboxes = dom.importList.querySelectorAll('input[data-import-index]');
  let count = 0;
  checkboxes.forEach((cb) => {
    if (cb.checked) count++;
    cb.closest('.import-item').classList.toggle('is-selected', cb.checked && !cb.disabled);
  });
  dom.initializeSyncBtn.disabled = count === 0;
  dom.initializeSyncBtn.textContent = count > 0
    ? `Initialize Sync Launch (${count})`
    : 'No extensions selected';
}

dom.importList.addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-import-index]');
  if (cb) syncImportSelectionUI();
});

dom.clearImportBtn.addEventListener('click', () => {
  dom.importDashboard.classList.add('is-hidden');
  dom.dropzone.classList.remove('is-hidden');
  dom.importList.innerHTML = '';
  state.importData = [];
});

/* --------------------------------------------------------------------------
 * IMPORT — "Initialize Sync Launch" sequential tab opener
 *
 * MV3 forbids silent background installation, so we open the Chrome Web
 * Store pages in new tabs for each checked extension. Sequential creation
 * with a small delay prevents the browser from throttling burst tab opens.
 * ------------------------------------------------------------------------ */
async function initializeSyncLaunch() {
  const checkboxes = [...dom.importList.querySelectorAll('input[data-import-index]:checked')];

  if (checkboxes.length === 0) return;

  dom.initializeSyncBtn.disabled = true;
  dom.launchProgress.classList.remove('is-hidden');
  setSyncStatus('pending');

  let opened = 0;
  for (const cb of checkboxes) {
    const index = Number(cb.dataset.importIndex);
    const ext = state.importData?.[index];
    if (!ext) continue;

    dom.launchProgressText.textContent = `Opening ${ext.name || 'extension'}… (${opened + 1}/${checkboxes.length})`;

    // Prefer a canonical web store URL if present in the backup; otherwise
    // derive from the ID.
    const url = (ext.webStoreUrl && /^https:\/\//i.test(ext.webStoreUrl))
      ? ext.webStoreUrl
      : `https://chromewebstore.google.com/detail/-/${ext.id}`;

    try {
      await chrome.tabs.create({ url });
      opened++;
    } catch (err) {
      console.error('[ExtensionSync] failed to open tab:', err);
    }

    // 350ms pause between opens to avoid Chrome's rapid-open throttle.
    await new Promise((r) => setTimeout(r, 350));
  }

  dom.launchProgress.classList.add('is-hidden');
  dom.initializeSyncBtn.disabled = false;
  setSyncStatus('synced');
  showCallout(`Opened ${opened} web store page${opened === 1 ? '' : 's'}`);
}

dom.initializeSyncBtn.addEventListener('click', initializeSyncLaunch);

/* --------------------------------------------------------------------------
 * SETTINGS — cloud & custom endpoint sync
 * ------------------------------------------------------------------------ */

async function loadSettingsView() {
  // Last sync timestamp.
  const { extensionsync_last_sync_at: lastSyncAt = null } =
    await chrome.storage.local.get('extensionsync_last_sync_at');
  dom.lastSyncTime.textContent = formatTime(lastSyncAt);

  // Custom endpoint URL.
  const res = await sendToBackground({ type: 'GET_CUSTOM_ENDPOINT' });
  if (res?.ok) {
    dom.endpointInput.value = res.endpoint || '';
  }
}

/** "Force Sync" → re-scan and serialize installed extensions. */
dom.forceSyncBtn.addEventListener('click', async () => {
  dom.forceSyncBtn.disabled = true;
  setSyncStatus('pending');
  try {
    const res = await sendToBackground({ type: 'REFRESH_PAYLOAD' });
    setSyncStatus('synced');
    dom.lastSyncTime.textContent = formatTime(Date.now());
    if (res?.ok) {
      const { extensionsync_last_sync_at: ts } =
        await chrome.storage.local.get('extensionsync_last_sync_at');
      dom.lastSyncTime.textContent = formatTime(ts);
    } else {
      setSyncStatus('error');
    }
  } finally {
    dom.forceSyncBtn.disabled = false;
  }
});

/** Save the custom endpoint URL (validated to be HTTPS). */
async function saveEndpoint() {
  const url = dom.endpointInput.value.trim();

  if (url && !/^https:\/\//i.test(url)) {
    dom.endpointStatus.textContent = 'Endpoint must be an HTTPS URL.';
    dom.endpointStatus.className = 'endpoint-status is-error';
    return;
  }

  const res = await sendToBackground({ type: 'SET_CUSTOM_ENDPOINT', url });
  if (res?.ok) {
    dom.endpointStatus.textContent = url
      ? 'Endpoint saved. Payloads will be POSTed on refresh.'
      : 'Endpoint cleared. Custom sync disabled.';
    dom.endpointStatus.className = 'endpoint-status is-success';
  } else {
    dom.endpointStatus.textContent = 'Failed to save endpoint.';
    dom.endpointStatus.className = 'endpoint-status is-error';
  }
}

dom.saveEndpointBtn.addEventListener('click', saveEndpoint);
dom.endpointInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveEndpoint();
});

/* --------------------------------------------------------------------------
 * INITIALISATION
 * ------------------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', () => {
  activateTab('export');      // default tab
  loadExtensions();           // render export grid
});
