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
  panelSearch: document.getElementById('panel-search'),
  panelExport: document.getElementById('panel-export'),
  panelImport: document.getElementById('panel-import'),
  panelSync: document.getElementById('panel-sync'),
  panelConfig: document.getElementById('panel-config'),

  // Search / Export grids
  searchInput: document.getElementById('search-input'),
  searchClearBtn: document.getElementById('search-clear-btn'),
  exportAllBtn: document.getElementById('export-all-btn'),
  exportSelectedBtn: document.getElementById('export-selected-btn'),
  clearSelectionBtn: document.getElementById('clear-selection-btn'),
  extensionGrid: document.getElementById('extension-grid'),
  exportGrid: document.getElementById('export-grid'),
  gridLoading: document.getElementById('grid-loading'),
  exportGridLoading: document.getElementById('export-grid-loading'),
  listMeta: document.getElementById('list-meta'),
  extensionCount: document.getElementById('extension-count'),
  stateSummary: document.getElementById('state-summary'),
  selectAllBtn: document.getElementById('select-all-btn'),
  publisherFilter: document.getElementById('publisher-filter'),
  ratingSort: document.getElementById('rating-sort'),
  filterResetBtn: document.getElementById('filter-reset-btn'),
  selectionBar: document.getElementById('selection-bar'),
  selectionCount: document.getElementById('selection-count'),
  toast: document.getElementById('toast'),

  // Chrome Web Store online search
  storeSearchInput: document.getElementById('store-search-input'),
  storeSearchBtn: document.getElementById('store-search-btn'),
  storeSearchStatus: document.getElementById('store-search-status'),
  storeSearchLoading: document.getElementById('store-search-loading'),
  storeResults: document.getElementById('store-results'),
  storeSelectAll: document.getElementById('store-select-all'),
  storeSelectionBar: document.getElementById('store-selection-bar'),
  storeSelectionCount: document.getElementById('store-selection-count'),
  installStoreBtn: document.getElementById('install-store-btn'),
  storeInstallHint: document.getElementById('store-install-hint'),
  storeInstallProgress: document.getElementById('store-install-progress'),
  storeInstallProgressText: document.getElementById('store-install-progress-text'),

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
  endpointStatus: document.getElementById('endpoint-status'),
  storeProxyInput: document.getElementById('store-proxy-input'),
  saveStoreProxyBtn: document.getElementById('save-store-proxy-btn'),
  storeProxyStatus: document.getElementById('store-proxy-status')
};

/* --------------------------------------------------------------------------
 * POPUP STATE
 * ------------------------------------------------------------------------ */
const state = {
  extensions: [],     // live list of installed extensions (export view)
  selected: new Set(), // ids checked for import launch
  filter: '',         // free-text name/id search
  publisher: '',      // publisher filter value
  sort: '',           // rating sort mode: '' | 'rated'
  storeResults: [],   // current online store search results
  storeSelection: new Set() // ids of store results chosen to install
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
  dom.panelSearch.hidden = tabName !== 'search';
  dom.panelExport.hidden = tabName !== 'export';
  dom.panelImport.hidden = tabName !== 'import';
  dom.panelSync.hidden = tabName !== 'sync';
  dom.panelConfig.hidden = tabName !== 'config';

  // Load per-panel data when switching tabs.
  if (tabName === 'search' || tabName === 'export') {
    loadExtensions();
  } else if (tabName === 'sync') {
    loadSettingsView();
  } else if (tabName === 'config') {
    loadConfigView();
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
  dom.exportGridLoading.classList.remove('is-hidden');
  dom.extensionGrid.innerHTML = '';
  dom.exportGrid.innerHTML = '';
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
        webStoreUrl: `https://chromewebstore.google.com/detail/-/${ext.id}`,
        author: null,      // filled in from Chrome Web Store below
        rating: null,
        numRatings: null,
        users: null
      }));

    // Enrich with Web Store metadata (publisher/rating/users) when available.
    await enrichWithStoreMeta();

    setSyncStatus('synced');
    renderSearchGrid();
    renderExportList();

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
    renderSearchGrid();
    renderExportList();
  }
}

/**
 * Fetches Chrome Web Store metadata (publisher, rating, users) via the
 * background worker and merges it into the in-memory extension records.
 * Runs after enumeration; failures degrade to null meta fields.
 */
async function enrichWithStoreMeta() {
  try {
    const ids = state.extensions.map((e) => e.id);
    if (ids.length === 0) return;
    const res = await sendToBackground({ type: 'GET_STORE_META', ids });
    if (!res?.ok || !res.metas) return;
    for (const ext of state.extensions) {
      const meta = res.metas[ext.id];
      if (meta) {
        ext.author = meta.author || null;
        ext.rating = meta.rating ?? null;
        ext.numRatings = meta.numRatings ?? null;
        ext.users = meta.users ?? null;
      }
    }
  } catch {
    /* store meta is best-effort */
  }
}

/** Repopulates the publisher dropdown from the current extension set. */
function buildPublisherOptions() {
  const authors = new Set(
    state.extensions.map((e) => e.author).filter(Boolean)
  );
  const current = state.publisher;
  const sorted = [...authors].sort((a, b) => a.localeCompare(b));
  dom.publisherFilter.innerHTML =
    '<option value="">All publishers</option>' +
    sorted.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
  dom.publisherFilter.value = authors.has(current) ? current : '';
  if (dom.publisherFilter.value !== current) state.publisher = dom.publisherFilter.value;
}

/** Re-renders the Search grid honoring the current search + filters. */
function renderSearchGrid() {
  dom.gridLoading.classList.add('is-hidden');
  const filter = state.filter.trim().toLowerCase();
  const pub = state.publisher;

  let visible = state.extensions.filter((ext) =>
    (!filter || ext.name.toLowerCase().includes(filter) || ext.id.includes(filter)) &&
    (!pub || ext.author === pub)
  );

  // Optional rating sort: best-rated first.
  if (state.sort === 'rated') {
    visible = [...visible].sort((a, b) => {
      const ra = a.rating ?? -1, rb = b.rating ?? -1;
      return rb - ra;
    });
  }

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
    const filtered = Boolean(state.filter.trim()) || Boolean(state.publisher) || Boolean(state.sort);
    dom.extensionGrid.innerHTML = renderEmptyState(
      filtered ? 'No matches for current filters' : 'No extensions to show',
      'Try a different name, extension ID, or clear the filters.',
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

  // Keep the publisher dropdown in sync with what we actually have.
  buildPublisherOptions();

  // Toggle the reset control when any filter is active.
  const filtering = Boolean(state.filter.trim()) || Boolean(state.publisher) || Boolean(state.sort);
  dom.filterResetBtn.classList.toggle('is-hidden', !filtering);

  // Determine select-all state.
  updateSelectAllState(visible);
  updateSelectionBar();
}

/** Re-renders the Export list — always the full, unfiltered extension set. */
function renderExportList() {
  dom.exportGridLoading.classList.add('is-hidden');
  if (state.extensions.length === 0) {
    dom.exportGrid.innerHTML = renderEmptyState(
      'No extensions found',
      'ExtensionSync could not enumerate your installed extensions.',
      'refresh'
    );
    return;
  }
  dom.exportGrid.innerHTML = state.extensions
    .map((ext) => renderExtensionCard(ext))
    .join('');
  updateSelectionBar();
}

/** Syncs the select-all button label to the given (already-filtered) list. */
function updateSelectAllState(visible) {
  const allVisibleSelected = visible.length > 0 && visible.every((ext) => state.selected.has(ext.id));
  dom.selectAllBtn.textContent = allVisibleSelected ? 'Deselect all' : 'Select all';
  dom.selectAllBtn.dataset.state = allVisibleSelected ? 'all' : (state.selected.size > 0 ? 'some' : 'none');
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
/** Formats a user count compactly, e.g. 1_800_000 -> "1.8M". */
function formatUsers(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

/** Renders the Web Store meta line (publisher · rating · users), if any. */
function renderStoreMetaLine(ext) {
  const parts = [];
  if (ext.author) parts.push(escapeHtml(ext.author));
  if (typeof ext.rating === 'number') {
    parts.push(`<span class="rating">★ ${ext.rating.toFixed(1)}${ext.numRatings ? ` (${formatUsers(ext.numRatings)})` : ''}</span>`);
  } else if (ext.users) {
    parts.push(`<span>${escapeHtml(formatUsers(ext.users))} users</span>`);
  }
  if (parts.length === 0) return '';
  return `<div class="ext-store" title="${escapeHtml(ext.author || 'Web Store data')}">${parts.join(' · ')}</div>`;
}

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
        ${renderStoreMetaLine(ext)}
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
  renderSearchGrid();
});

/** Clear the search filter. */
function clearSearch() {
  state.filter = '';
  dom.searchInput.value = '';
  dom.searchClearBtn.classList.add('is-hidden');
  renderSearchGrid();
}
dom.searchClearBtn.addEventListener('click', clearSearch);

/** Publisher dropdown filter. */
dom.publisherFilter.addEventListener('change', (e) => {
  state.publisher = e.target.value;
  renderSearchGrid();
});

/** Rating sort dropdown. */
dom.ratingSort.addEventListener('change', (e) => {
  state.sort = e.target.value;
  renderSearchGrid();
});

/** Reset search + all filters to defaults. */
function resetFilters() {
  state.filter = '';
  state.publisher = '';
  state.sort = '';
  dom.searchInput.value = '';
  dom.searchClearBtn.classList.add('is-hidden');
  dom.publisherFilter.value = '';
  dom.ratingSort.value = '';
  renderSearchGrid();
}
dom.filterResetBtn.addEventListener('click', resetFilters);

/** Per-card selection/toggle from any grid (Search or Export). */
function handleGridChange(e) {
  const selectInput = e.target.closest('input[data-action="select-exp"]');
  if (selectInput) {
    if (selectInput.checked) {
      state.selected.add(selectInput.dataset.id);
    } else {
      state.selected.delete(selectInput.dataset.id);
    }
    renderSearchGrid();
    renderExportList();
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
}

dom.extensionGrid.addEventListener('change', handleGridChange);
dom.exportGrid.addEventListener('change', handleGridChange);

/** Actions rendered inside the empty-state (clear search / try again). */
function handleGridClick(e) {
  if (e.target.closest('#empty-clear-btn')) resetFilters();
  if (e.target.closest('#empty-refresh-btn')) loadExtensions();
}

dom.extensionGrid.addEventListener('click', handleGridClick);
dom.exportGrid.addEventListener('click', handleGridClick);

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
  renderSearchGrid();
  renderExportList();
});

/** Clear the current selection. */
dom.clearSelectionBtn.addEventListener('click', () => {
  state.selected.clear();
  renderSearchGrid();
  renderExportList();
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

/**
 * Opens the Chrome Web Store install pages for each URL, one at a time, with a
 * small delay to avoid the browser's rapid-open throttle. Shows progress via
 * the provided progress elements.
 *
 * @param {string[]} urls - store page URLs to open
 * @param {object} refs - { progress, progressText, button } DOM references
 * @returns {Promise<number>} number of tabs successfully opened
 */
async function openWebStorePages(urls, refs) {
  const { progress, progressText, button } = refs;
  const total = urls.length;
  if (progress) progress.classList.remove('is-hidden');
  if (button) button.disabled = true;
  setSyncStatus('pending');

  let opened = 0;
  for (let i = 0; i < urls.length; i++) {
    if (progressText) {
      progressText.textContent = `Opening store page… (${i + 1}/${total})`;
    }
    try {
      await chrome.tabs.create({ url: urls[i] });
      opened++;
    } catch (err) {
      console.error('[ExtensionSync] failed to open tab:', err);
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  if (progress) progress.classList.add('is-hidden');
  if (button) button.disabled = false;
  setSyncStatus('synced');
  return opened;
}

async function initializeSyncLaunch() {
  const checkboxes = [...dom.importList.querySelectorAll('input[data-import-index]:checked')];
  if (checkboxes.length === 0) return;

  const urls = [];
  for (const cb of checkboxes) {
    const index = Number(cb.dataset.importIndex);
    const ext = state.importData?.[index];
    if (!ext) continue;
    // Prefer a canonical web store URL if present in the backup; otherwise
    // derive from the ID.
    const url = (ext.webStoreUrl && /^https:\/\//i.test(ext.webStoreUrl))
      ? ext.webStoreUrl
      : `https://chromewebstore.google.com/detail/-/${ext.id}`;
    urls.push(url);
  }
  if (urls.length === 0) return;

  const opened = await openWebStorePages(urls, {
    progress: dom.launchProgress,
    progressText: dom.launchProgressText,
    button: dom.initializeSyncBtn
  });
  showCallout(`Opened ${opened} web store page${opened === 1 ? '' : 's'}`);
}

dom.initializeSyncBtn.addEventListener('click', initializeSyncLaunch);

/* --------------------------------------------------------------------------
 * SYNC & CONFIGURATION
 * ------------------------------------------------------------------------ */

async function loadSettingsView() {
  // Last sync timestamp.
  const { extensionsync_last_sync_at: lastSyncAt = null } =
    await chrome.storage.local.get('extensionsync_last_sync_at');
  dom.lastSyncTime.textContent = formatTime(lastSyncAt);
}

/** Loads Configuration panel values (custom endpoint + store proxy). */
async function loadConfigView() {
  // Custom endpoint URL.
  const res = await sendToBackground({ type: 'GET_CUSTOM_ENDPOINT' });
  if (res?.ok) {
    dom.endpointInput.value = res.endpoint || '';
  }

  // Web Store CORS proxy URL.
  const sres = await sendToBackground({ type: 'GET_STORE_PROXY' });
  if (sres?.ok) {
    dom.storeProxyInput.value = sres.proxy || '';
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

/**
 * A store proxy must be HTTPS — except localhost/127.0.0.1, which are allowed
 * over plain HTTP (e.g. `node tools/cors-proxy-node.js` during local testing).
 */
function isValidProxyUrl(url) {
  if (/^https:\/\//i.test(url)) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(url)) return true;
  return false;
}

/** Save the Web Store metadata proxy URL. HTTPS required except for localhost. */
async function saveStoreProxy() {
  const url = dom.storeProxyInput.value.trim();

  if (url && !isValidProxyUrl(url)) {
    dom.storeProxyStatus.textContent =
      'Proxy must be an HTTPS URL (http://localhost is allowed for local testing).';
    dom.storeProxyStatus.className = 'endpoint-status is-error';
    return;
  }

  const res = await sendToBackground({ type: 'SET_STORE_PROXY', url });
  if (res?.ok) {
    dom.storeProxyStatus.textContent = url
      ? 'Proxy saved. Reload extensions to fetch publisher & ratings.'
      : 'Proxy cleared. Store metadata disabled.';
    dom.storeProxyStatus.className = 'endpoint-status is-success';
    loadExtensions();
  } else {
    dom.storeProxyStatus.textContent = 'Failed to save proxy.';
    dom.storeProxyStatus.className = 'endpoint-status is-error';
  }
}

dom.saveStoreProxyBtn.addEventListener('click', saveStoreProxy);
dom.storeProxyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveStoreProxy();
});

/* --------------------------------------------------------------------------
 * CHROME WEB STORE ONLINE SEARCH
 * ------------------------------------------------------------------------ */

/** Runs an online store search for the given query and renders the results. */
async function runStoreSearch(query) {
  const q = (query ?? '').trim();
  dom.storeResults.innerHTML = '';
  dom.storeSearchStatus.textContent = '';
  dom.storeSearchStatus.classList.remove('is-error');
  state.storeResults = [];
  state.storeSelection.clear();
  updateStoreSelectionUI();

  if (!q) { updateStoreSelectionUI(); return; }

  dom.storeSearchLoading.classList.remove('is-hidden');
  try {
    const res = await sendToBackground({ type: 'GET_STORE_SEARCH', query: q });
    if (!res || res.ok === false) throw new Error('search failed');
    dom.storeSearchLoading.classList.add('is-hidden');

    if (res.configured === false) {
      dom.storeSearchStatus.textContent =
        'Store search is disabled. Set a Web Store proxy in Configuration → Web Store Proxy.';
      dom.storeSearchStatus.classList.add('is-error');
      return;
    }
    if (!res.results.length) {
      dom.storeResults.innerHTML =
        '<div class="store-card-empty">No extensions found on the Chrome Web Store.</div>';
      return;
    }
    state.storeResults = res.results;
    renderStoreResults();
  } catch {
    dom.storeSearchLoading.classList.add('is-hidden');
    dom.storeSearchStatus.textContent =
      'Search failed. Check the Web Store proxy in Configuration.';
    dom.storeSearchStatus.classList.add('is-error');
  }
}

/** Renders online store result cards with a selection checkbox. */
function renderStoreResults() {
  const results = state.storeResults;
  dom.storeResults.innerHTML = results.map((r) => {
    const meta = renderStoreMetaLine(r);
    const desc = r.description ? escapeHtml(r.description) : '';
    const isSel = state.storeSelection.has(r.id);
    const icon = r.icon
      ? `<img class="store-card-icon" src="${escapeHtml(r.icon)}" alt="" loading="lazy">`
      : '<div class="store-card-icon"></div>';
    return `
      <article class="store-card${isSel ? ' is-selected' : ''}" data-id="${escapeHtml(r.id)}">
        <label class="sel-check" title="Select ${escapeHtml(r.name)}">
          <input type="checkbox" data-action="store-select" data-id="${escapeHtml(r.id)}" ${isSel ? 'checked' : ''}>
          <span class="sel-check-box"></span>
        </label>
        <a class="store-card-link" href="${escapeHtml(`https://chromewebstore.google.com/detail/${r.id}`)}"
           target="_blank" rel="noopener noreferrer">
          ${icon}
          <div class="store-card-body">
            <span class="store-card-name">${escapeHtml(r.name)}</span>
            ${meta}
            ${desc ? `<div class="store-card-desc">${desc}</div>` : ''}
          </div>
        </a>
      </article>`;
  }).join('');
  updateStoreSelectionUI();
}

/**
 * Reflects current store selection state onto the cards and the selection
 * toolbar (count, button state, select-all reflect).
 */
function updateStoreSelectionUI() {
  const total = state.storeResults.length;
  const count = state.storeSelection.size;
  const hasResults = total > 0;

  dom.storeSelectionBar.classList.toggle('is-hidden', !hasResults || count === 0);
  dom.storeInstallHint.classList.toggle('is-hidden', count === 0);

  if (hasResults) {
    dom.storeSelectAll.checked = count === total;
    dom.storeSelectAll.indeterminate = count > 0 && count < total;
  } else {
    dom.storeSelectAll.checked = false;
    dom.storeSelectAll.indeterminate = false;
  }

  dom.storeSelectionCount.textContent = `${count} selected`;
  dom.installStoreBtn.disabled = count === 0;
  dom.installStoreBtn.textContent = count > 0
    ? `Install Selected (${count})`
    : 'Install Selected';

  dom.storeResults.querySelectorAll('.store-card').forEach((card) => {
    const id = card.dataset.id;
    card.classList.toggle('is-selected', state.storeSelection.has(id));
  });
}

dom.storeResults.addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-action="store-select"]');
  if (!cb) return;
  const id = cb.dataset.id;
  if (cb.checked) state.storeSelection.add(id);
  else state.storeSelection.delete(id);
  updateStoreSelectionUI();
});

dom.storeSelectAll.addEventListener('change', () => {
  const selectAll = dom.storeSelectAll.checked;
  if (selectAll) {
    state.storeResults.forEach((r) => state.storeSelection.add(r.id));
  } else {
    state.storeResults.forEach((r) => state.storeSelection.delete(r.id));
  }
  renderStoreResults();
});

/** Opens the Chrome Web Store install page for every selected result. */
/**
 * "Install Selected" exports the chosen store IDs to a JSON file in the
 * Downloads folder. The user then runs tools/install-extensions.cmd once,
 * which batch-installs the matching <id>.crx files into the browser profile.
 *
 * Chrome/Brave sandbox extensions, so the popup cannot run the script itself;
 * it delivers the ID list the script needs.
 */
async function installSelectedStoreResults() {
  const ids = [...state.storeSelection];
  if (ids.length === 0) return;

  try {
    const json = JSON.stringify({ generated: Date.now(), extensions: ids }, null, 2);
    const dataUrl = `data:application/json;base64,${btoa(unescape(encodeURIComponent(json)))}`;
    await chrome.downloads.download({
      url: dataUrl,
      filename: 'extensionsync-install.json',
      saveAs: false,
      conflictAction: 'overwrite'
    });
    showCallout(`Exported ${ids.length} ID${ids.length === 1 ? '' : 's'} — run tools/install-extensions.cmd to install.`);
  } catch (err) {
    console.error('[ExtensionSync] export failed:', err);
    showCallout('Failed to export IDs.', 'error');
  }
}

dom.installStoreBtn.addEventListener('click', installSelectedStoreResults);

/* --------------------------------------------------------------------------
 * INITIALISATION
 * ------------------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', () => {
  activateTab('search');      // default tab

  // Wire the online store search.
  dom.storeSearchBtn.addEventListener('click', () => runStoreSearch(dom.storeSearchInput.value));
  dom.storeSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runStoreSearch(dom.storeSearchInput.value);
  });

  loadExtensions();           // render search & export grids
});
