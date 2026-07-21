// Noorani Browser — renderer.js (Phase 5: settings, themes, search engine)
//
// contextIsolation=true, nodeIntegration=false. Everything disk-bound goes
// through window.nooraniAPI (preload.js).

// ------- DOM refs --------
const tabsEl         = document.getElementById('tabs');
const newTabBtn      = document.getElementById('new-tab');
const contentEl      = document.getElementById('content');
const urlInput       = document.getElementById('url');
const backBtn        = document.getElementById('back');
const forwardBtn     = document.getElementById('forward');
const reloadBtn      = document.getElementById('reload');
const homeBtn        = document.getElementById('home-btn');
const starBtn        = document.getElementById('star-btn');
const bookmarksBtn   = document.getElementById('bookmarks-btn');
const historyBtn     = document.getElementById('history-btn');
const downloadsBtn   = document.getElementById('downloads-btn');
const quranBtn       = document.getElementById('quran-btn');
const duasBtn        = document.getElementById('duas-btn');
const settingsBtn    = document.getElementById('settings-btn');
const dlBadge        = document.getElementById('dl-badge');

const loadingBarEl   = document.getElementById('loading-bar');
const bookmarkBarEl  = document.getElementById('bookmark-bar');
const bookmarkItemsEl= document.getElementById('bookmark-bar-items');
const bookmarkOverflowBtn = document.getElementById('bookmark-bar-overflow');
const panelEl        = document.getElementById('panel');
const panelTitle     = document.getElementById('panel-title');
const panelClose     = document.getElementById('panel-close');
const panelClear     = document.getElementById('panel-clear');
const bookmarksList  = document.getElementById('bookmarks-list');
const historyList    = document.getElementById('history-list');
const downloadsListEl = document.getElementById('downloads-list');
const historySearch  = document.getElementById('history-search');

// ------- Constants / resources --------
const INTERNAL_HOMEPAGE = 'noorani://home';
const INTERNAL_SETTINGS = 'noorani://settings';
const INTERNAL_WELCOME  = 'noorani://welcome';
const INTERNAL_QURAN    = 'noorani://quran';
const INTERNAL_DUAS     = 'noorani://duas';
const INTERNAL_PRIVATE  = 'noorani://private';

// webview preload — same preload.js, activated only on trusted schemes.
const PRELOAD_URL = new URL('preload.js', window.location.href).href;

// ------- Window identity (Phase v1.0.1 Parts C + E) --------
// A window is either the original main window, a detached-tab window
// (?openUrl=...), or an incognito window (?incognito=1&partition=...).
// All three load the exact same index.html/renderer.js — this is the only
// place that tells them apart.
const _bootParams   = new URLSearchParams(window.location.search);
const BOOT_OPEN_URL = _bootParams.get('openUrl') || null;
const IS_INCOGNITO  = _bootParams.get('incognito') === '1';
const INCOGNITO_PARTITION = _bootParams.get('partition') || null;

if (IS_INCOGNITO) document.documentElement.setAttribute('data-incognito', '1');
// History is disk-backed (history:add already no-ops for incognito, see
// below) — the button itself must never even be reachable in a private
// window, matching how quran-btn/duas-btn are gated on their own feature
// flags elsewhere in this file.
if (IS_INCOGNITO) historyBtn.hidden = true;

const FALLBACK_FAVICON =
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
    'fill="none" stroke="#9a9a9a" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="10"/>' +
    '<line x1="2" y1="12" x2="22" y2="12"/>' +
    '<path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z"/>' +
    '</svg>'
  );

const PANEL_TITLES = {
  bookmarks: 'Bookmarks',
  history:   'History',
  downloads: 'Downloads'
};

// Search engine URL prefixes — filled in once at startup from the API.
let SEARCH_ENGINES = {
  google: { name: 'Google', search: 'https://www.google.com/search?q=' }
};

// Live settings cache — mutated on settings:changed.
let currentSettings = {
  theme:             'light',
  searchEngine:      'google',
  homepage:          INTERNAL_HOMEPAGE,
  useCustomHomepage: false,
  _effectiveTheme:   'light'
};

// ------- Tab state --------
const tabs = [];
let currentTabId = null;
let nextIdCounter = 1;
const newId = () => 'tab-' + (nextIdCounter++);
let downloadsState = [];

function activeTab() {
  return tabs.find(t => t.id === currentTabId) || null;
}

// Loading bar — reflects the currently active tab's loading state.
let _loadingDoneTimer = null;
function syncLoadingBar() {
  const tab = activeTab();
  const isLoading = !!(tab && tab.isLoading);
  if (!loadingBarEl) return;

  if (_loadingDoneTimer) { clearTimeout(_loadingDoneTimer); _loadingDoneTimer = null; }

  if (isLoading) {
    loadingBarEl.classList.remove('is-done');
    // Reset to 0, then in the next frame let the transition run to 88%.
    loadingBarEl.classList.remove('is-loading');
    loadingBarEl.style.width = '0';
    // eslint-disable-next-line no-unused-expressions
    loadingBarEl.offsetWidth;
    requestAnimationFrame(() => loadingBarEl.classList.add('is-loading'));
  } else {
    loadingBarEl.classList.remove('is-loading');
    loadingBarEl.classList.add('is-done');
    _loadingDoneTimer = setTimeout(() => {
      loadingBarEl.classList.remove('is-done');
      loadingBarEl.style.width = '';
      _loadingDoneTimer = null;
    }, 500);
  }
}

// ============ Theme + homepage + engine helpers ============

function applyTheme(effective) {
  const theme = (effective === 'dark') ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('noorani-effective-theme', theme); } catch (_) {}
}

function getSearchPrefix() {
  const engine = SEARCH_ENGINES[currentSettings.searchEngine]
              || SEARCH_ENGINES.google;
  return engine.search;
}

function getHomepage() {
  // Private windows always land on the private-browsing landing page,
  // even if the user has a custom homepage configured for normal windows —
  // same convention real browsers use for "New private tab".
  if (IS_INCOGNITO) return INTERNAL_PRIVATE;
  if (currentSettings.useCustomHomepage &&
      currentSettings.homepage &&
      currentSettings.homepage !== INTERNAL_HOMEPAGE) {
    return currentSettings.homepage;
  }
  return INTERNAL_HOMEPAGE;
}

// ============ URL parsing ============

function parseInput(raw) {
  const input = raw.trim();
  if (!input) return null;

  if (/^(https?|file|about|data|noorani):/i.test(input)) return input;
  if (/^localhost(:\d+)?(\/|$)/i.test(input)) return 'http://' + input;
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)?/.test(input)) return 'http://' + input;

  const hostPart = input.split(/[\/?#]/)[0];
  if (!/\s/.test(input) && hostPart.includes('.') && !hostPart.endsWith('.')) {
    return 'https://' + input;
  }
  return getSearchPrefix() + encodeURIComponent(input);
}

function navigate(raw) {
  const target = parseInput(raw);
  const tab = activeTab();
  if (target && tab) tab.webview.loadURL(target);
}

function urlBarValueFor(url) {
  if (!url || url.startsWith('noorani:')) return '';
  return url;
}

// ============ DOM builder helper ============

function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className')    n.className = v;
      else if (k === 'text')     n.textContent = v;
      else if (k === 'onClick')  n.addEventListener('click', v);
      else if (v === false || v == null) continue;
      else if (v === true)       n.setAttribute(k, '');
      else                       n.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

function hostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

// Build a panel empty-state with a soft icon above the text.
const EMPTY_ICONS = {
  bookmarks: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  history:   '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/><polyline points="12 7 12 12 15 14"/>',
  downloads: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'
};
function emptyState(kind, text) {
  const wrap = document.createElement('div');
  wrap.className = 'panel__empty';
  wrap.innerHTML =
    '<svg class="panel__empty__icon" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
    'stroke-linejoin="round">' + (EMPTY_ICONS[kind] || '') + '</svg>' +
    '<div></div>';
  wrap.lastChild.textContent = text;
  return wrap;
}

// ============ Tab creation ============

function createTab(url) {
  const openUrl = url || getHomepage();
  const id = newId();

  const webview = document.createElement('webview');
  // Partition MUST be set before src for it to take effect — an incognito
  // window's webviews all share INCOGNITO_PARTITION (so tabs within one
  // private window share cookies/session with each other), which is a
  // non-"persist:" partition name, so Electron keeps it in memory only and
  // discards it once nothing references it anymore (i.e. when the window
  // closes). Normal windows omit the attribute entirely, which leaves the
  // webview on session.defaultSession — unchanged from v1.0.0 behaviour.
  if (IS_INCOGNITO && INCOGNITO_PARTITION) {
    webview.setAttribute('partition', INCOGNITO_PARTITION);
  }
  webview.setAttribute('src', openUrl);
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('preload', PRELOAD_URL);
  webview.classList.add('hidden');

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.tabId = id;
  tabEl.setAttribute('role', 'tab');
  tabEl.draggable = true;

  const favEl = document.createElement('img');
  favEl.className = 'tab__favicon';
  favEl.src = FALLBACK_FAVICON;
  favEl.alt = '';

  const titleEl = document.createElement('div');
  titleEl.className = 'tab__title';
  titleEl.textContent = 'New Tab';

  const closeEl = document.createElement('button');
  closeEl.className = 'tab__close';
  closeEl.type = 'button';
  closeEl.setAttribute('aria-label', 'Close tab');
  closeEl.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<line x1="6" y1="6" x2="18" y2="18"/>' +
    '<line x1="18" y1="6" x2="6" y2="18"/></svg>';

  tabEl.append(favEl, titleEl, closeEl);
  tabsEl.insertBefore(tabEl, newTabBtn);

  contentEl.insertBefore(webview, panelEl);

  const tab = {
    id, webview, tabEl, favEl, titleEl, closeEl,
    title: null,
    url: openUrl,
    favicon: null,
    isLoading: true,
    _loggedUrl: null
  };
  tabs.push(tab);

  wireTab(tab);
  switchToTab(id);
  return tab;
}

// ============ Tab event wiring ============

function wireTab(tab) {
  tab.tabEl.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('.tab__close')) {
      switchToTab(tab.id);
    } else if (e.button === 1) {
      e.preventDefault();
      closeTab(tab.id);
    }
  });
  tab.tabEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showTabContextMenu(tab.id, e.clientX, e.clientY);
  });
  tab.closeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tab.id);
  });

  // --- Drag to reorder / detach (Phase v1.0.1 Part C) ---
  tab.tabEl.addEventListener('dragstart', (e) => {
    dragTabId = tab.id;
    tab.tabEl.classList.add('is-dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tab.id);
    } catch (_) {}
  });
  tab.tabEl.addEventListener('dragend', (e) => {
    tab.tabEl.classList.remove('is-dragging');
    hideDragIndicator();
    const wasDragging = dragTabId === tab.id;
    dragTabId = null;
    if (!wasDragging) return;
    if (isDragOutsideTabBar()) detachTab(tab, e.screenX, e.screenY);
  });

  const wv = tab.webview;

  wv.addEventListener('did-navigate', (e) => {
    tab.url = e.url;
    tab._loggedUrl = null;
    tab.title = null;
    tab.titleEl.textContent = hostLabel(e.url) || 'Loading…';
    applySavedZoom(tab, e.url);
    if (tab.id === currentTabId) {
      urlInput.value = urlBarValueFor(e.url);
      updateNavButtons();
      syncStar();
      updateBookmarkBarVisibility();
    }
  });

  wv.addEventListener('did-navigate-in-page', (e) => {
    if (e.isMainFrame === false) return;
    tab.url = e.url;
    if (tab.id === currentTabId) {
      urlInput.value = urlBarValueFor(e.url);
      updateNavButtons();
      syncStar();
      updateBookmarkBarVisibility();
    }
  });

  wv.addEventListener('page-title-updated', (e) => {
    tab.title = e.title || null;
    tab.titleEl.textContent = tab.title || hostLabel(tab.url) || 'Untitled';
    tab.tabEl.title = tab.title || '';
    if (tab.id === currentTabId) syncWindowTitle();
    maybeLogHistory(tab);
  });

  wv.addEventListener('page-favicon-updated', (e) => {
    const favs = (e.favicons && e.favicons.length) ? e.favicons : [];
    if (!favs.length) return;
    tab.favicon = favs[0];
    tab.favEl.src = favs[0];
    tab.favEl.onerror = () => {
      tab.favEl.onerror = null;
      tab.favEl.src = FALLBACK_FAVICON;
    };
  });

  wv.addEventListener('did-start-loading', () => {
    tab.isLoading = true;
    tab.tabEl.classList.add('loading');
    if (tab.id === currentTabId) syncLoadingBar();
  });

  wv.addEventListener('did-stop-loading', () => {
    tab.isLoading = false;
    tab.tabEl.classList.remove('loading');
    if (tab.id === currentTabId) {
      updateNavButtons();
      syncLoadingBar();
    }
    maybeLogHistory(tab);
  });

  wv.addEventListener('dom-ready', () => {
    if (tab.id === currentTabId) updateNavButtons();
  });

  wv.addEventListener('new-window', (e) => {
    try { e.preventDefault(); } catch (_) {}
    if (!e.url) return;
    // "Always open external links in a private window" (Part E setting) —
    // a link that would otherwise open in a new tab opens in a fresh
    // private window instead. Already-private windows just stay private
    // via the normal new-tab path (IS_INCOGNITO already governs createTab's
    // partition), no extra routing needed.
    const wantsPrivate = !IS_INCOGNITO && !!(currentSettings.privateBrowsing &&
                          currentSettings.privateBrowsing.alwaysExternalLinks);
    if (wantsPrivate && api && api.window) {
      api.window.openPrivateUrl(e.url);
    } else {
      createTab(e.url);
    }
  });

  // Right-click inside the guest page. In this Electron build, params.x/y
  // for the webview's context-menu event are already reported in chrome-
  // window viewport coordinates (not webview-local). Earlier versions of
  // this code added webview.getBoundingClientRect() on top, which dropped
  // the menu 100–200px below the cursor — exactly rect.top's worth of
  // extra offset. Use params coords directly.
  wv.addEventListener('context-menu', (e) => {
    try { e.preventDefault(); } catch (_) {}
    const params = e.params || {};
    const items = buildWebviewContextMenu(tab, params);
    if (!items.length) return;
    window.nooraniContextMenu.show({
      x: params.x || 0,
      y: params.y || 0,
      items
    });
  });
}

function maybeLogHistory(tab) {
  if (IS_INCOGNITO) return;   // private windows never write to history.json
  if (!tab.url) return;
  if (tab._loggedUrl === tab.url) return;
  tab._loggedUrl = tab.url;
  window.nooraniAPI.history.add({
    url:     tab.url,
    title:   tab.title || hostLabel(tab.url),
    favicon: tab.favicon
  });
}

// ============ Switching / closing ============

function switchToTab(id) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  // Hide any open context menu — stale context from the previous tab.
  if (window.nooraniContextMenu) window.nooraniContextMenu.hide();
  // Also dismiss the prayer dropdown — its content (next-prayer countdown)
  // is global, but the visual association with the old tab is noise.
  if (typeof window.__nooraniClosePrayerDropdown === 'function') {
    window.__nooraniClosePrayerDropdown();
  }
  for (const t of tabs) {
    const isActive = (t.id === id);
    t.webview.classList.toggle('hidden', !isActive);
    t.tabEl.classList.toggle('active', isActive);
  }
  // Gentle fade-in on the new webview so fast tab switching feels fluid.
  // The outgoing tab hid instantly above — no visible overlap.
  tab.webview.classList.add('is-entering');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => tab.webview.classList.remove('is-entering'));
  });
  currentTabId = id;

  urlInput.value = urlBarValueFor(tab.url);
  syncWindowTitle();
  updateNavButtons();
  syncStar();
  syncLoadingBar();
  updateBookmarkBarVisibility();
  tab.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;

  const tab = tabs[idx];
  // Drop logical state + the webview immediately so switchToTab stays sane.
  tabs.splice(idx, 1);
  tab.webview.remove();

  // Animate the tab chrome element out, then remove from DOM.
  const node = tab.tabEl;
  node.classList.add('is-leaving');
  setTimeout(() => { if (node.parentNode) node.remove(); }, 170);

  if (tabs.length === 0) {
    window.close();
    return;
  }
  if (currentTabId === id) {
    const newIdx = Math.min(idx, tabs.length - 1);
    switchToTab(tabs[newIdx].id);
  }
}

// ============ Drag to reorder / detach (Phase v1.0.1 Part C) ============
//
// Stage 1 (reorder): a single delegated dragover/drop pair on tabsEl tracks
// where the dragged tab would land and shows a thin insertion indicator;
// drop commits the reorder into the `tabs` array (order also drives
// Ctrl+1..9 / cycleTab) and FLIP-animates the tab chrome into place.
//
// Stage 2 (detach): dragend decides whether the release point counted as
// "outside the tab strip" using the same lastDrag* tracking Stage 1 already
// maintains. If so, main.js is asked to either drop the tab into whatever
// other Noorani window is under the cursor, or open a fresh window for it.

const TAB_DETACH_Y_THRESHOLD = 46; // px below the tab bar before a drag counts as "wants out"
let dragTabId = null;
let dragIndicatorEl = null;
let lastDragClientX = 0;
let lastDragClientY = 0;
let lastDragOverTabBar = false;

function ensureDragIndicator() {
  if (dragIndicatorEl) return dragIndicatorEl;
  dragIndicatorEl = document.createElement('div');
  dragIndicatorEl.className = 'tab-drop-indicator';
  tabsEl.appendChild(dragIndicatorEl);
  return dragIndicatorEl;
}

function hideDragIndicator() {
  if (dragIndicatorEl) dragIndicatorEl.classList.remove('is-visible');
}

// Positions the insertion line for clientX and returns the id of the tab
// it would land before (null = end of the strip).
function positionDragIndicator(clientX) {
  const indicator = ensureDragIndicator();
  const others = Array.from(tabsEl.querySelectorAll('.tab'))
    .filter((el) => el.dataset.tabId !== dragTabId);

  let beforeEl = null;
  for (const el of others) {
    const r = el.getBoundingClientRect();
    if (clientX < r.left + r.width / 2) { beforeEl = el; break; }
  }

  const containerRect = tabsEl.getBoundingClientRect();
  const left = beforeEl
    ? beforeEl.getBoundingClientRect().left - containerRect.left + tabsEl.scrollLeft
    : (others.length
        ? others[others.length - 1].getBoundingClientRect().right - containerRect.left + tabsEl.scrollLeft
        : 0);

  indicator.style.left = left + 'px';
  indicator.classList.add('is-visible');
  return beforeEl ? beforeEl.dataset.tabId : null;
}

function isDragOutsideTabBar() {
  if (lastDragOverTabBar) return false;
  const tabBarEl = document.querySelector('.tab-bar');
  if (!tabBarEl) return false;
  const r = tabBarEl.getBoundingClientRect();
  return lastDragClientY > r.bottom + TAB_DETACH_Y_THRESHOLD ||
         lastDragClientY < -20 || lastDragClientX < -20 ||
         lastDragClientX > window.innerWidth + 20;
}

// Reorders the `tabs` array, then FLIP-animates the tab chrome (capture old
// positions, move the DOM, transform back from old->new, then transition
// to identity) so the row settles into place over ~200ms instead of
// snapping.
function reorderTabs(sourceId, beforeId) {
  const fromIdx = tabs.findIndex((t) => t.id === sourceId);
  if (fromIdx === -1) return;
  const [moved] = tabs.splice(fromIdx, 1);
  if (beforeId) {
    const toIdx = tabs.findIndex((t) => t.id === beforeId);
    tabs.splice(toIdx === -1 ? tabs.length : toIdx, 0, moved);
  } else {
    tabs.push(moved);
  }

  const oldRects = new Map();
  for (const t of tabs) oldRects.set(t.id, t.tabEl.getBoundingClientRect());

  for (const t of tabs) tabsEl.insertBefore(t.tabEl, newTabBtn);

  for (const t of tabs) {
    const oldRect = oldRects.get(t.id);
    const newRect = t.tabEl.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    if (!dx) continue;
    t.tabEl.style.transition = 'none';
    t.tabEl.style.transform = `translateX(${dx}px)`;
    // eslint-disable-next-line no-unused-expressions
    t.tabEl.offsetHeight;
    requestAnimationFrame(() => {
      t.tabEl.style.transition = 'transform 200ms ease';
      t.tabEl.style.transform = '';
    });
  }
}

async function detachTab(tab, screenX, screenY) {
  if (!api || !api.window || !api.window.detachTab) return;
  let result;
  try {
    result = await api.window.detachTab({ url: tab.url, screenX, screenY });
  } catch (_) {
    return;
  }
  if (!result || result.error) return;
  // Reuses the exact same cleanup closeTab() already does for the
  // "last tab in the window" case — tabs.length hitting 0 there calls
  // window.close(), which is exactly the spec'd "close source window
  // instead of leaving it empty" behaviour, for free.
  closeTab(tab.id);
}

// Capture-phase so this sees dragover regardless of which element is
// under the cursor (a .tab, .tab__title, the new-tab button, the toolbar
// below the strip, …) — needed both to position the indicator and to know,
// at dragend time, whether the release point counted as "outside".
window.addEventListener('dragover', (e) => {
  if (!dragTabId) return;
  lastDragClientX = e.clientX;
  lastDragClientY = e.clientY;
  lastDragOverTabBar = !!(e.target && e.target.closest && e.target.closest('.tab-bar'));
  if (lastDragOverTabBar) {
    e.preventDefault();
    positionDragIndicator(e.clientX);
  } else {
    hideDragIndicator();
  }
}, true);

tabsEl.addEventListener('drop', (e) => {
  if (!dragTabId) return;
  e.preventDefault();
  const beforeId = positionDragIndicator(e.clientX);
  reorderTabs(dragTabId, beforeId);
  hideDragIndicator();
});

// ============ Toolbar / title ============

function updateNavButtons() {
  const tab = activeTab();
  if (!tab) { backBtn.disabled = true; forwardBtn.disabled = true; return; }
  try {
    backBtn.disabled    = !tab.webview.canGoBack();
    forwardBtn.disabled = !tab.webview.canGoForward();
  } catch (_) {
    backBtn.disabled = true; forwardBtn.disabled = true;
  }
}

function syncWindowTitle() {
  // Electron re-syncs the OS title bar from document.title on every
  // navigation, which would silently erase the "(Private)" suffix the
  // window was created with — so every branch here has to carry it.
  const suffix = IS_INCOGNITO ? 'Noorani Browser (Private)' : 'Noorani Browser';
  const tab = activeTab();
  if (!tab) { document.title = suffix; return; }
  if (tab.url && tab.url.startsWith('noorani:')) {
    document.title = suffix;
    return;
  }
  document.title = tab.title ? `${tab.title} - ${suffix}` : suffix;
}

async function syncStar() {
  const tab = activeTab();
  const url = tab && tab.url;
  const bookmarkable = !!url && !url.startsWith('noorani:') && !url.startsWith('about:');
  starBtn.disabled = !bookmarkable;

  if (!bookmarkable) {
    starBtn.classList.remove('active-star');
    starBtn.title = 'Bookmark this page';
    return;
  }
  try {
    const has = await window.nooraniAPI.bookmarks.has(url);
    starBtn.classList.toggle('active-star', has);
    starBtn.title = has ? 'Remove bookmark' : 'Bookmark this page';
  } catch (_) { /* swallow */ }
}

// ============ URL bar / nav buttons ============

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    navigate(urlInput.value);
    urlInput.blur();
  }
});
backBtn.addEventListener('click',    () => { const t = activeTab(); if (t && t.webview.canGoBack())    t.webview.goBack(); });
forwardBtn.addEventListener('click', () => { const t = activeTab(); if (t && t.webview.canGoForward()) t.webview.goForward(); });
reloadBtn.addEventListener('click',  () => { const t = activeTab(); if (t) t.webview.reload(); });
newTabBtn.addEventListener('click',  () => { createTab(); focusURLBar(); });
homeBtn.addEventListener('click',    () => goHome());
settingsBtn.addEventListener('click',() => openSettings());
if (quranBtn) quranBtn.addEventListener('click', () => openQuran());
if (duasBtn)  duasBtn.addEventListener('click',  () => openDuas());

// ============ Shortcut helpers ============

function focusURLBar() { urlInput.focus(); urlInput.select(); }

function closeActiveTab() {
  const tab = activeTab();
  if (!tab) return;
  if (tabs.length === 1) {
    createTab();
    closeTab(tab.id);
  } else {
    closeTab(tab.id);
  }
}
function cycleTab(delta) {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex(t => t.id === currentTabId);
  const next = ((idx + delta) % tabs.length + tabs.length) % tabs.length;
  switchToTab(tabs[next].id);
}
function switchToIndex(n) { const t = tabs[n - 1]; if (t) switchToTab(t.id); }
function backActive()    { const t = activeTab(); if (t && t.webview.canGoBack())    t.webview.goBack(); }
function forwardActive() { const t = activeTab(); if (t && t.webview.canGoForward()) t.webview.goForward(); }
function reloadActive()  { const t = activeTab(); if (t) t.webview.reload(); }
function goHome()        { const t = activeTab(); if (t) t.webview.loadURL(getHomepage()); }
function openSettings()  { const t = activeTab(); if (t) t.webview.loadURL(INTERNAL_SETTINGS); }
function openQuran()     { const t = activeTab(); if (t) t.webview.loadURL(INTERNAL_QURAN); }
function openDuas()      { const t = activeTab(); if (t) t.webview.loadURL(INTERNAL_DUAS); }

if (window.nooraniAPI && typeof window.nooraniAPI.onShortcut === 'function') {
  window.nooraniAPI.onShortcut((action, ...args) => {
    switch (action) {
      case 'new-tab':       createTab(); focusURLBar(); break;
      case 'close-tab':     closeActiveTab(); break;
      case 'next-tab':      cycleTab(+1); break;
      case 'prev-tab':      cycleTab(-1); break;
      case 'switch-tab':    switchToIndex(args[0]); break;
      case 'back':          backActive(); break;
      case 'forward':       forwardActive(); break;
      case 'reload':        reloadActive(); break;
      case 'focus-url':     focusURLBar(); break;
      case 'home':                 goHome(); break;
      case 'open-settings':        openSettings(); break;
      case 'toggle-bookmark-bar':  toggleBookmarkBarMode(); break;
      case 'zoom-in':              applyZoomDelta(+ZOOM_STEP); break;
      case 'zoom-out':             applyZoomDelta(-ZOOM_STEP); break;
      case 'zoom-reset':           resetZoom(); break;
      case 'open-tab-url':         createTab(args[0]); break;
      case 'confirm-close-private': handleConfirmClosePrivate(); break;
    }
  });
}

// ============ Private window close confirmation (Phase v1.0.1 Part E) ====
// Main intercepts the OS close for incognito windows and asks us first
// (only when "Ask before closing a private window with multiple tabs" is
// on and there's more than one tab) — see createSecondaryWindow() in
// main.js. We resolve by telling main to force-close for real.
async function handleConfirmClosePrivate() {
  if (!api || !api.window || !api.window.forceClose) return;
  if (tabs.length <= 1) {
    await api.window.forceClose();
    return;
  }
  const ok = await window.nooraniModal.confirm({
    title:       'Close private window?',
    message:     `This will close ${tabs.length} tabs in this private window. ` +
                 `Anything you were doing here will be forgotten.`,
    confirmText: 'Close Window',
    variant:     'danger'
  });
  if (ok) await api.window.forceClose();
}

// ============ Bookmark toggle (star) ============

starBtn.addEventListener('click', async () => {
  const tab = activeTab();
  if (!tab || !tab.url) return;
  if (tab.url.startsWith('noorani:') || tab.url.startsWith('about:')) return;

  const has = await window.nooraniAPI.bookmarks.has(tab.url);
  if (has) {
    await window.nooraniAPI.bookmarks.remove(tab.url);
  } else {
    await window.nooraniAPI.bookmarks.add({
      url:     tab.url,
      title:   tab.title || hostLabel(tab.url),
      favicon: tab.favicon
    });
  }
  await syncStar();
});

// ============ Side panel ============

function openPanel(which) {
  if (panelEl.dataset.current === which && !panelEl.hidden) {
    closePanel();
    return;
  }
  panelEl.hidden = false;
  panelEl.dataset.current = which;
  panelTitle.textContent = PANEL_TITLES[which] || '';
  for (const s of panelEl.querySelectorAll('.panel__section')) {
    s.classList.toggle('active', s.dataset.panel === which);
  }
  panelClear.hidden = which !== 'history';
  for (const [name, btn] of [
    ['bookmarks', bookmarksBtn],
    ['history',   historyBtn],
    ['downloads', downloadsBtn]
  ]) {
    btn.classList.toggle('panel-open', name === which);
  }
  if (which === 'bookmarks') renderBookmarksPanel();
  if (which === 'history')   renderHistoryPanel();
  if (which === 'downloads') renderDownloadsPanel();
}

function closePanel() {
  panelEl.hidden = true;
  delete panelEl.dataset.current;
  for (const btn of [bookmarksBtn, historyBtn, downloadsBtn]) {
    btn.classList.remove('panel-open');
  }
}

bookmarksBtn.addEventListener('click', () => openPanel('bookmarks'));
historyBtn.addEventListener  ('click', () => openPanel('history'));
downloadsBtn.addEventListener('click', () => openPanel('downloads'));
panelClose.addEventListener  ('click', closePanel);

panelClear.addEventListener('click', async () => {
  const confirmed = await window.nooraniModal.confirm({
    title:       'Clear History',
    message:     'This will permanently delete your entire browsing history.',
    confirmText: 'Clear History',
    variant:     'danger'
  });
  if (!confirmed) return;
  await window.nooraniAPI.history.clear();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !panelEl.hidden) closePanel();
});

// ============ Bookmarks panel ============

async function renderBookmarksPanel() {
  const bookmarks = await window.nooraniAPI.bookmarks.get();
  bookmarksList.textContent = '';
  if (!bookmarks.length) {
    bookmarksList.appendChild(emptyState(
      'bookmarks',
      'No bookmarks yet. Click the star on any page to save it.'
    ));
    return;
  }
  for (const b of bookmarks) {
    bookmarksList.appendChild(renderEntryRow({
      favicon: b.favicon,
      title:   b.title || hostLabel(b.url),
      url:     b.url,
      onOpen:  (ev) => openFromEntry(b.url, ev),
      actions: [{
        label: '×',
        title: 'Remove bookmark',
        onClick: async () => {
          await window.nooraniAPI.bookmarks.remove(b.url);
        }
      }]
    }));
  }
}

// ============ History panel ============

let _historyFilter = '';

async function renderHistoryPanel() {
  const all = await window.nooraniAPI.history.get();
  const sorted = all.slice().reverse();
  const q = _historyFilter.toLowerCase().trim();
  const filtered = q
    ? sorted.filter(h =>
        (h.title || '').toLowerCase().includes(q) ||
        (h.url   || '').toLowerCase().includes(q))
    : sorted;

  historyList.textContent = '';
  if (!filtered.length) {
    historyList.appendChild(emptyState(
      'history',
      q ? 'No history matches your search.'
        : 'Your browsing history will appear here.'
    ));
    return;
  }

  const now = new Date();
  const today = new Date(now); today.setHours(0,0,0,0);
  const yesterday = new Date(today.getTime() - 86400000);

  const groups = { today: [], yesterday: [], older: [] };
  for (const h of filtered) {
    const t = h.visitedAt || 0;
    if (t >= today.getTime())           groups.today.push(h);
    else if (t >= yesterday.getTime())  groups.yesterday.push(h);
    else                                groups.older.push(h);
  }

  const sections = [
    ['Today',     groups.today],
    ['Yesterday', groups.yesterday],
    ['Older',     groups.older]
  ];
  for (const [label, items] of sections) {
    if (!items.length) continue;
    historyList.appendChild(
      el('div', { className: 'panel__section-header', text: label }));
    for (const h of items) {
      historyList.appendChild(renderEntryRow({
        favicon: h.favicon,
        title:   h.title || hostLabel(h.url),
        url:     h.url,
        onOpen:  (ev) => openFromEntry(h.url, ev)
      }));
    }
  }
}

historySearch.addEventListener('input', () => {
  _historyFilter = historySearch.value;
  renderHistoryPanel();
});

// ============ Downloads panel ============

function renderDownloadsPanel() {
  downloadsListEl.textContent = '';
  if (!downloadsState.length) {
    downloadsListEl.appendChild(emptyState(
      'downloads',
      'No downloads yet.'
    ));
    return;
  }
  for (const d of downloadsState) {
    const pct = Math.round((d.progress || 0) * 100);
    const isActive = (d.state === 'progressing' || d.state === 'started');
    const stateLabel =
      d.state === 'completed'   ? 'Completed' :
      d.state === 'cancelled'   ? 'Cancelled' :
      d.state === 'interrupted' ? 'Failed' :
                                  pct + '%';

    const progress = isActive
      ? el('div', { className: 'progress' },
          el('div', { className: 'progress__bar' }))
      : null;

    const text = el('div', { className: 'entry__text' },
      el('div', { className: 'entry__title', text: d.filename || '(unnamed)' }),
      el('div', { className: 'entry__url',   text: stateLabel }),
      progress
    );
    if (progress) {
      progress.querySelector('.progress__bar').style.width = pct + '%';
    }

    const row = el('div', { className: 'entry download-entry' }, text);

    if (d.state === 'completed') {
      row.appendChild(el('button', {
        className: 'entry__action', title: 'Open file',
        onClick: () => window.nooraniAPI.downloads.openFile(d.id)
      }, 'Open'));
      row.appendChild(el('button', {
        className: 'entry__action', title: 'Show in folder',
        onClick: () => window.nooraniAPI.downloads.openFolder(d.id)
      }, 'Folder'));
    } else if (isActive) {
      row.appendChild(el('button', {
        className: 'entry__action',
        onClick: () => window.nooraniAPI.downloads.cancel(d.id)
      }, 'Cancel'));
    }
    downloadsListEl.appendChild(row);
  }
}

function updateDownloadsBadge() {
  const active = downloadsState.filter(
    d => d.state === 'progressing' || d.state === 'started'
  ).length;
  if (active > 0) {
    dlBadge.hidden = false;
    dlBadge.textContent = String(active);
  } else {
    dlBadge.hidden = true;
  }
}

// ============ Shared entry row ============

function renderEntryRow({ favicon, title, url, onOpen, actions }) {
  const row = el('button', {
    className: 'entry',
    type: 'button',
    onClick: (e) => {
      if (e.target.closest('.entry__remove') ||
          e.target.closest('.entry__action')) return;
      onOpen && onOpen(e);
    }
  });
  const fav = el('img', {
    className: 'entry__favicon',
    src: favicon || FALLBACK_FAVICON,
    alt: ''
  });
  fav.onerror = () => { fav.onerror = null; fav.src = FALLBACK_FAVICON; };

  const text = el('div', { className: 'entry__text' },
    el('div', { className: 'entry__title', text: title }),
    el('div', { className: 'entry__url',   text: url })
  );
  row.append(fav, text);

  if (actions && actions.length) {
    for (const a of actions) {
      row.appendChild(el('button', {
        className: 'entry__remove', title: a.title || '', type: 'button',
        onClick: (e) => { e.stopPropagation(); a.onClick && a.onClick(); }
      }, a.label));
    }
  }
  return row;
}

function openFromEntry(url, event) {
  if (event && (event.ctrlKey || event.metaKey)) {
    createTab(url);
  } else {
    const tab = activeTab();
    if (tab) tab.webview.loadURL(url);
    closePanel();
  }
}

// ============ Bookmark bar ============

const FALLBACK_FAV_URL = FALLBACK_FAVICON;
let bookmarkBarCache     = [];
let bookmarkBarFirst     = true;
let bookmarkBarKnownUrls = new Set();
let bookmarkBarOverflow  = [];   // bookmarks that didn't fit on the bar

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function bookmarkBarModeShouldShow() {
  const mode = (currentSettings.ui && currentSettings.ui.showBookmarkBar) || 'always';
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  // 'new-tab-only' — visible only on noorani://home.
  const tab = activeTab();
  const url = tab && tab.url;
  return !!url && url.startsWith(INTERNAL_HOMEPAGE);
}

function updateBookmarkBarVisibility() {
  if (!bookmarkBarEl) return;
  const show = bookmarkBarModeShouldShow();
  // Element starts with visibility: hidden + .is-hidden so we never
  // flash a 36px strip during bootstrap. Once we've decided, reveal it.
  bookmarkBarEl.style.visibility = '';
  bookmarkBarEl.classList.toggle('is-hidden', !show);
}

function buildBookmarkItemNode(b) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bookmark-item';
  btn.title = b.title || b.url;
  btn._bookmark = b;

  const img = document.createElement('img');
  img.className = 'bookmark-item__fav';
  img.alt = '';
  img.src = b.favicon || FALLBACK_FAV_URL;
  img.onerror = () => { img.onerror = null; img.src = FALLBACK_FAV_URL; };

  const span = document.createElement('span');
  span.className = 'bookmark-item__title';
  span.textContent = truncate(b.title || hostLabel(b.url) || b.url, 20);

  btn.append(img, span);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      createTab(b.url);
    } else {
      const tab = activeTab();
      if (tab) tab.webview.loadURL(b.url);
    }
  });
  btn.addEventListener('mousedown', (e) => {
    if (e.button === 1) {           // middle click → new tab
      e.preventDefault();
      createTab(b.url);
    }
  });
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showBookmarkContextMenu(b, btn, e.clientX, e.clientY);
  });

  return btn;
}

function renderBookmarkBar() {
  if (!bookmarkItemsEl) return;

  const items = bookmarkBarCache.slice().reverse(); // newest first
  bookmarkItemsEl.textContent = '';
  bookmarkBarOverflow = [];
  bookmarkOverflowBtn.classList.remove('is-visible');

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bookmark-bar__empty';
    empty.textContent = 'Bookmark a page to add it here';
    bookmarkItemsEl.appendChild(empty);
    bookmarkBarKnownUrls.clear();
    bookmarkBarFirst = false;
    return;
  }

  const nodes = items.map((b) => {
    const node = buildBookmarkItemNode(b);
    // Subtle fade-in only for bookmarks that are genuinely new (not the
    // initial render).
    if (!bookmarkBarFirst && !bookmarkBarKnownUrls.has(b.url)) {
      node.classList.add('is-entering');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => node.classList.remove('is-entering'));
      });
    }
    return node;
  });
  nodes.forEach(n => bookmarkItemsEl.appendChild(n));

  bookmarkBarKnownUrls = new Set(items.map(b => b.url));
  bookmarkBarFirst = false;

  // Measure overflow after layout. Any item whose right edge exceeds the
  // container (minus 36px reserved for the overflow button) is hidden
  // and added to the dropdown list.
  requestAnimationFrame(() => {
    const containerRight = bookmarkItemsEl.getBoundingClientRect().right;
    const threshold = containerRight - 36;
    for (let i = 0; i < nodes.length; i++) {
      const r = nodes[i].getBoundingClientRect();
      if (r.right > threshold) {
        nodes[i].style.display = 'none';
        bookmarkBarOverflow.push(items[i]);
      }
    }
    if (bookmarkBarOverflow.length > 0) {
      bookmarkOverflowBtn.classList.add('is-visible');
    }
  });
}

function showBookmarkContextMenu(bookmark, _node, x, y) {
  window.nooraniContextMenu.show({
    x, y,
    items: [
      { label: 'Open',            action: () => {
        const tab = activeTab();
        if (tab) tab.webview.loadURL(bookmark.url);
      }},
      { label: 'Open in New Tab', action: () => createTab(bookmark.url) },
      { divider: true },
      { label: 'Edit…',           action: () => editBookmark(bookmark) },
      { label: 'Delete',          action: () => deleteBookmark(bookmark.url) }
    ]
  });
}

async function editBookmark(bookmark) {
  const result = await window.nooraniModal.form({
    title:   'Edit Bookmark',
    fields: [
      {
        key:         'title',
        label:       'Title',
        value:       bookmark.title || '',
        placeholder: 'Bookmark title'
      },
      {
        key:         'url',
        label:       'URL',
        value:       bookmark.url || '',
        type:        'url',
        placeholder: 'https://example.com',
        validate:    (v) => /^(https?|noorani):\/\/\S+/i.test(v)
                              ? null
                              : 'Please enter a valid URL'
      }
    ],
    confirmText: 'Save'
  });
  if (!result) return;

  const changes = {};
  const nextTitle = (result.title || '').trim();
  const nextUrl   = (result.url   || '').trim();
  if (nextTitle && nextTitle !== bookmark.title) changes.title  = nextTitle;
  if (nextUrl   && nextUrl   !== bookmark.url)   changes.newUrl = nextUrl;
  if (Object.keys(changes).length === 0) return;
  await window.nooraniAPI.bookmarks.update(bookmark.url, changes);
}

async function deleteBookmark(url) {
  await window.nooraniAPI.bookmarks.remove(url);
}

function showOverflowDropdown() {
  if (bookmarkBarOverflow.length === 0) return;
  const rect = bookmarkOverflowBtn.getBoundingClientRect();
  const items = bookmarkBarOverflow.map((b) => ({
    label: truncate(b.title || hostLabel(b.url) || b.url, 36),
    icon:  `<img src="${b.favicon || FALLBACK_FAV_URL}" alt="" width="16" height="16" style="border-radius:2px;object-fit:contain">`,
    action: () => {
      const tab = activeTab();
      if (tab) tab.webview.loadURL(b.url);
    }
  }));
  window.nooraniContextMenu.show({
    x: rect.right - 220,
    y: rect.bottom + 4,
    items
  });
}

if (bookmarkOverflowBtn) {
  bookmarkOverflowBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showOverflowDropdown();
  });
}

async function toggleBookmarkBarMode() {
  const mode = (currentSettings.ui && currentSettings.ui.showBookmarkBar) || 'always';
  const next = (mode === 'always') ? 'never' : 'always';
  const nextUi = { ...(currentSettings.ui || {}), showBookmarkBar: next };
  await window.nooraniAPI.settings.update('ui', nextUi);
}

// ============ Webview context menu ============

function buildWebviewContextMenu(tab, params) {
  const items = [];
  const wv = tab.webview;
  const ef = params.editFlags || {};
  const selection = (params.selectionText || '').trim();

  // --- Top: navigation (always present) ---
  let canBack = false, canFwd = false;
  try { canBack = wv.canGoBack(); canFwd = wv.canGoForward(); } catch (_) {}
  items.push({ label: 'Back',    disabled: !canBack,
    action: () => { try { wv.goBack();    } catch (_) {} } });
  items.push({ label: 'Forward', disabled: !canFwd,
    action: () => { try { wv.goForward(); } catch (_) {} } });
  items.push({ label: 'Reload',
    action: () => { try { wv.reload(); } catch (_) {} } });
  items.push({ divider: true });

  // --- Context-specific: link ---
  if (params.linkURL) {
    const href = params.linkURL;
    items.push({ label: 'Open Link',            action: () => wv.loadURL(href) });
    items.push({ label: 'Open Link in New Tab', action: () => createTab(href) });
    items.push({ label: 'Open Link in Private Window',
      action: () => { if (api && api.window) api.window.openPrivateUrl(href); } });
    items.push({ divider: true });
    items.push({ label: 'Copy Link Address',
      action: () => navigator.clipboard.writeText(href).catch(() => {}) });
    items.push({ label: 'Save Link As…',
      action: () => { try { wv.downloadURL(href); } catch (_) {} } });
    items.push({ divider: true });
  }

  // --- Context-specific: image ---
  if ((params.mediaType === 'image' || params.hasImageContents) && params.srcURL) {
    const src = params.srcURL;
    items.push({ label: 'Open Image in New Tab', action: () => createTab(src) });
    items.push({ label: 'Save Image As…',
      action: () => { try { wv.downloadURL(src); } catch (_) {} } });
    items.push({ label: 'Copy Image',
      action: () => { try { wv.copyImageAt(params.x, params.y); } catch (_) {} } });
    items.push({ label: 'Copy Image Address',
      action: () => navigator.clipboard.writeText(src).catch(() => {}) });
    items.push({ divider: true });
  }

  // --- Context-specific: selection search ---
  if (selection) {
    const engineKey  = currentSettings.searchEngine || 'google';
    const engine     = SEARCH_ENGINES[engineKey] || SEARCH_ENGINES.google ||
                       { name: 'Google', search: 'https://www.google.com/search?q=' };
    const engineName = engine.name || 'Google';
    items.push({
      label: `Search "${truncate(selection, 30)}" with ${engineName}`,
      action: () => createTab(engine.search + encodeURIComponent(selection))
    });
    items.push({ divider: true });
  }

  // --- Worship: save to Dua Bookmarks (Phase 9 Batch 3) ---
  // Gated on the duaBookmarks feature so it doesn't appear for users who
  // don't use the feature. The entry adopts whatever context is available —
  // selected text becomes the translation/reference content, plus the page URL.
  const duaFeatureOn = !!(currentSettings.features &&
                          currentSettings.features.worship &&
                          currentSettings.features.worship.duaBookmarks);
  if (duaFeatureOn) {
    const label = selection
      ? `Save "${truncate(selection, 30)}" as Dua Reference`
      : 'Save as Dua Reference';
    items.push({
      label,
      action: async () => {
        try {
          const entry = {
            type:             'verse-link',
            reference:        selection || (params.pageURL || tab.url || ''),
            text_translation: selection || '',
            text_arabic:      '',
            url:              params.pageURL || tab.url || '',
            notes:            ''
          };
          await window.nooraniAPI.duas.add(entry);
        } catch (err) {
          console.error('[noorani] save-as-dua failed:', err);
        }
      }
    });
    items.push({ divider: true });
  }

  // --- Editing actions ---
  // Visibility rules (per spec):
  //   Cut:    only if the element is editable AND there's a selection
  //   Copy:   only if there's a selection (works on non-editable text too)
  //   Paste:  only if the element is editable
  //   Select All: always shown
  if (params.isEditable && selection) {
    items.push({ label: 'Cut',
      action: () => { try { wv.cut(); } catch (_) {} } });
  }
  if (selection) {
    items.push({ label: 'Copy',
      action: () => { try { wv.copy(); } catch (_) {} } });
  }
  if (params.isEditable) {
    items.push({ label: 'Paste',
      action: () => { try { wv.paste(); } catch (_) {} } });
  }
  items.push({ label: 'Select All',
    action: () => { try { wv.selectAll(); } catch (_) {} } });
  items.push({ divider: true });

  // --- Print ---
  items.push({ label: 'Print…',
    action: () => { try { wv.print(); } catch (_) {} } });
  items.push({ divider: true });

  // --- Developer ---
  items.push({
    label: 'View Page Source',
    action: () => createTab('view-source:' + (params.pageURL || tab.url))
  });
  items.push({
    label: 'Inspect Element',
    action: () => {
      try { wv.inspectElement(params.x | 0, params.y | 0); }
      catch (_) {
        try { wv.openDevTools(); } catch (__) {}
      }
    }
  });

  // Clean up dividers: drop leading/trailing, collapse consecutive.
  while (items.length && items[0].divider)               items.shift();
  while (items.length && items[items.length - 1].divider) items.pop();
  const deduped = [];
  for (const it of items) {
    if (it.divider && deduped.length && deduped[deduped.length - 1].divider) continue;
    deduped.push(it);
  }
  return deduped;
}

// ============ Tab / URL-bar helpers (for context menus) ============

function duplicateTab(id) {
  const tab = tabs.find(t => t.id === id);
  if (tab) createTab(tab.url);
}
function closeOtherTabs(keepId) {
  const others = tabs.filter(t => t.id !== keepId).map(t => t.id);
  for (const id of others) closeTab(id);
}
function closeTabsToRight(fromId) {
  const idx = tabs.findIndex(t => t.id === fromId);
  if (idx < 0) return;
  const toClose = tabs.slice(idx + 1).map(t => t.id);
  for (const id of toClose) closeTab(id);
}
function reloadTabById(id) {
  const tab = tabs.find(t => t.id === id);
  if (tab) tab.webview.reload();
}

function showTabContextMenu(tabId, x, y) {
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx < 0) return;
  const toRightCount = tabs.length - idx - 1;
  const otherCount   = tabs.length - 1;
  window.nooraniContextMenu.show({
    x, y,
    items: [
      { label: 'Reload Tab',      action: () => reloadTabById(tabId) },
      { label: 'Duplicate Tab',   action: () => duplicateTab(tabId) },
      { divider: true },
      { label: 'Close Tab',       action: () => closeTab(tabId) },
      { label: `Close ${otherCount} Other Tab${otherCount === 1 ? '' : 's'}`,
        disabled: otherCount === 0,
        action: () => closeOtherTabs(tabId) },
      { label: `Close ${toRightCount} Tab${toRightCount === 1 ? '' : 's'} to the Right`,
        disabled: toRightCount === 0,
        action: () => closeTabsToRight(tabId) }
    ]
  });
}

function hasSelection(input) {
  return input.selectionStart != null &&
         input.selectionEnd   != null &&
         input.selectionStart !== input.selectionEnd;
}
function deleteSelection(input) {
  const s = input.selectionStart, e = input.selectionEnd;
  if (s == null || s === e) return;
  input.value = input.value.slice(0, s) + input.value.slice(e);
  input.selectionStart = input.selectionEnd = s;
}

function showUrlBarContextMenu(x, y) {
  const sel = hasSelection(urlInput);
  const hasVal = urlInput.value.length > 0;
  window.nooraniContextMenu.show({
    x, y,
    items: [
      { label: 'Cut',           disabled: !sel,    action: () => {
        urlInput.focus();
        try { document.execCommand('cut'); } catch (_) {}
      }},
      { label: 'Copy',          disabled: !sel,    action: () => {
        const s = urlInput.selectionStart, e = urlInput.selectionEnd;
        const text = urlInput.value.slice(s, e);
        if (text) navigator.clipboard.writeText(text).catch(() => {});
      }},
      { label: 'Paste',         action: async () => {
        try {
          const text = await navigator.clipboard.readText();
          urlInput.focus();
          const s = urlInput.selectionStart || 0;
          const e = urlInput.selectionEnd   || 0;
          urlInput.value = urlInput.value.slice(0, s) + text + urlInput.value.slice(e);
          urlInput.selectionStart = urlInput.selectionEnd = s + text.length;
        } catch (_) {}
      }},
      { label: 'Paste and Go',  action: async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) navigate(text.trim());
        } catch (_) {}
      }},
      { divider: true },
      { label: 'Select All',    disabled: !hasVal, action: () => {
        urlInput.focus(); urlInput.select();
      }},
      { label: 'Delete',        disabled: !sel,    action: () => {
        deleteSelection(urlInput);
      }}
    ]
  });
}

urlInput.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showUrlBarContextMenu(e.clientX, e.clientY);
});

// Global fallback: kill the built-in browser context menu on the chrome.
// Specific handlers (URL bar, tabs, bookmarks, webview) have already
// fired by the time this listener runs; webview events fire inside the
// guest and are preventDefault()'d there separately.
document.addEventListener('contextmenu', (e) => e.preventDefault());

// Re-measure overflow on resize (debounced via rAF chain).
let _bookmarkResizeScheduled = false;
window.addEventListener('resize', () => {
  if (_bookmarkResizeScheduled) return;
  _bookmarkResizeScheduled = true;
  requestAnimationFrame(() => {
    _bookmarkResizeScheduled = false;
    renderBookmarkBar();
  });
});

// ============ Live data subscriptions ============

const api = window.nooraniAPI;

if (api && api.downloads) {
  api.downloads.onUpdate((list) => {
    downloadsState = list || [];
    updateDownloadsBadge();
    if (panelEl.dataset.current === 'downloads' && !panelEl.hidden) {
      renderDownloadsPanel();
    }
  });
  api.downloads.get().then((list) => {
    downloadsState = list || [];
    updateDownloadsBadge();
  });
}

if (api && api.bookmarks && api.bookmarks.onChange) {
  api.bookmarks.onChange((list) => {
    bookmarkBarCache = Array.isArray(list) ? list : [];
    renderBookmarkBar();
    syncStar();
    if (panelEl.dataset.current === 'bookmarks' && !panelEl.hidden) {
      renderBookmarksPanel();
    }
  });
}

if (api && api.history && api.history.onChange) {
  api.history.onChange(() => {
    if (panelEl.dataset.current === 'history' && !panelEl.hidden) {
      renderHistoryPanel();
    }
  });
}

if (api && api.settings && api.settings.onChange) {
  api.settings.onChange((next) => {
    currentSettings = { ...currentSettings, ...next };
    applyTheme(next._effectiveTheme || next.theme);
    updateBookmarkBarVisibility();
    // Worship toggle may have flipped — re-fetch/clear the pill.
    refreshPrayerSnapshot();
    renderWorshipToolbar();
    // Note: engine / homepage updates apply to next actions;
    // we don't retroactively change current tabs' URLs.
  });
}

// ============ Permission requests (Phase v1.0.1 Part B) ============
// Main asks us (the chrome renderer, never the guest webview) to show a
// nooraniModal prompt whenever a site requests camera/mic/location/etc and
// the origin has no remembered decision yet. We're just the UI here — all
// the "did they already answer this" logic lives in main.js.

const PERMISSION_COPY = {
  camera:           'use your camera',
  microphone:       'use your microphone',
  geolocation:      'know your location',
  notifications:    'show notifications',
  midi:             'access MIDI devices',
  pointerLock:      'lock your pointer',
  fullscreen:       'use fullscreen',
  openExternal:     'open external applications',
  'clipboard-read': 'read your clipboard'
};

function describePermissionTypes(types) {
  const labels = (types || []).map((t) => PERMISSION_COPY[t] || t);
  if (labels.length <= 1) return labels[0] || 'access this feature';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return labels.slice(0, -1).join(', ') + ', and ' + labels[labels.length - 1];
}

if (api && api.permissions && api.permissions.onRequest) {
  api.permissions.onRequest(async (req) => {
    if (!req || !req.requestId || !window.nooraniModal) return;
    const siteName = req.siteName || req.origin || 'This site';
    let result;
    try {
      result = await window.nooraniModal.permission({
        title:  `${siteName} wants to ${describePermissionTypes(req.types)}`,
        origin: req.origin || '',
        rememberDefault: true
      });
    } catch (_) {
      result = { action: 'deny', remember: false };
    }
    api.permissions.respond({
      requestId: req.requestId,
      action:    result.action,
      remember:  result.remember
    });
  });
}

// ============ Zoom (Phase v1.0.1 Part D) ============

const ZOOM_MIN = -3, ZOOM_MAX = 3, ZOOM_STEP = 0.5;
let zoomToastTimer = null;
let zoomToastEl = null;

// Electron's setZoomLevel uses the same base-1.2 curve Chromium's UI zoom
// does, so this reproduces the percentage the user actually sees rather
// than a hand-picked table.
function zoomPercentFor(level) {
  return Math.round(Math.pow(1.2, level) * 100);
}

function showZoomToast(percent) {
  if (!zoomToastEl) {
    zoomToastEl = document.createElement('div');
    zoomToastEl.className = 'zoom-toast';
    zoomToastEl.id = 'zoom-toast';
    contentEl.appendChild(zoomToastEl);
  }
  zoomToastEl.textContent = percent + '%';
  zoomToastEl.classList.remove('is-fading');
  // Force reflow so re-triggering the transition works if the toast was
  // already fading out.
  // eslint-disable-next-line no-unused-expressions
  zoomToastEl.offsetHeight;
  zoomToastEl.classList.add('is-visible');
  if (zoomToastTimer) clearTimeout(zoomToastTimer);
  zoomToastTimer = setTimeout(() => {
    zoomToastEl.classList.remove('is-visible');
    zoomToastEl.classList.add('is-fading');
  }, 1500);
}

function persistZoomForTab(tab, level) {
  if (!tab || !tab.url || tab.url.startsWith('noorani:')) return;
  const domain = hostLabel(tab.url);
  if (!domain || !api || !api.zoom) return;
  api.zoom.set(domain, level).catch(() => {});
}

function applyZoomDelta(delta) {
  const tab = activeTab();
  if (!tab) return;
  let level = 0;
  try { level = tab.webview.getZoomLevel() || 0; } catch (_) {}
  level = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level + delta));
  try { tab.webview.setZoomLevel(level); } catch (_) { return; }
  showZoomToast(zoomPercentFor(level));
  persistZoomForTab(tab, level);
}

function resetZoom() {
  const tab = activeTab();
  if (!tab) return;
  try { tab.webview.setZoomLevel(0); } catch (_) { return; }
  showZoomToast(100);
  persistZoomForTab(tab, 0);
}

// Applied silently (no toast) on navigation — restores whatever zoom the
// user last set for this domain. Runs on every did-navigate, same as real
// browsers: navigating within a domain keeps re-applying its saved level.
function applySavedZoom(tab, url) {
  if (!url || url.startsWith('noorani:') || !api || !api.zoom) return;
  const domain = hostLabel(url);
  if (!domain) return;
  api.zoom.get(domain).then((level) => {
    if (typeof level !== 'number' || !tab.webview) return;
    try {
      if (tab.webview.getZoomLevel() !== level) tab.webview.setZoomLevel(level);
    } catch (_) {}
  }).catch(() => {});
}

// ============ Prayer pill (Phase 9 Batch 1) ============

const prayerPillEl  = document.getElementById('prayer-pill');
const prayerPillTxt = document.getElementById('prayer-pill-text');
const prayerPopEl   = document.getElementById('prayer-pop');

let prayerTickTimer = null;
let prayerSnapshot  = null;  // { times, next, worship, location }

function formatClock(d) {
  if (!d) return '—';
  const date = (d instanceof Date) ? d : new Date(d);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function formatCountdown(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) minutes = 0;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function labelize(name) { return name.charAt(0).toUpperCase() + name.slice(1); }

function isPrayerFeatureOn() {
  return !!(currentSettings && currentSettings.features &&
            currentSettings.features.worship &&
            currentSettings.features.worship.prayerTimes);
}

function renderPrayerPill() {
  if (!prayerPillEl) return;
  if (!isPrayerFeatureOn() || !prayerSnapshot || !prayerSnapshot.next) {
    prayerPillEl.hidden = true;
    prayerPopEl.hidden = true;
    return;
  }
  // Recompute the countdown locally so it stays accurate between main-process
  // refreshes (which only fire on prayer-boundary crossings).
  const next = prayerSnapshot.next;
  const target = next.time ? new Date(next.time) : null;
  const mins = target
    ? Math.max(0, Math.round((target.getTime() - Date.now()) / 60000))
    : next.minutesUntil;
  prayerPillTxt.textContent = `${labelize(next.prayerName)} in ${formatCountdown(mins)}`;
  prayerPillEl.hidden = false;
}

function renderPrayerPop() {
  if (!prayerSnapshot || !prayerSnapshot.times) {
    prayerPopEl.innerHTML =
      '<div class="prayer-pop__meta">Set your location in Settings to see prayer times.</div>';
    return;
  }
  const t = prayerSnapshot.times;
  const now = Date.now();
  const next = prayerSnapshot.next;
  const nextName = next ? next.prayerName : null;
  const names = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  let html = '';
  for (const n of names) {
    const time = t[n] ? new Date(t[n]) : null;
    const passed = time && time.getTime() < now;
    const active = (n === nextName);
    const cls = 'prayer-pop__row' +
      (active ? ' prayer-pop__row--active' : '') +
      (passed ? ' prayer-pop__row--passed' : '');
    html += `<div class="${cls}">`
         +  `<span class="prayer-pop__name">${labelize(n)}</span>`
         +  `<span class="prayer-pop__time">${formatClock(time)}</span>`
         +  `</div>`;
  }
  html += '<div class="prayer-pop__divider"></div>'
       +  '<div class="prayer-pop__meta">'
       +    `Sunrise ${formatClock(t.sunrise)}`;
  const loc = prayerSnapshot.location || {};
  if (loc.city) html += ` · ${loc.city}`;
  html += '</div>';
  prayerPopEl.innerHTML = html;
}

if (prayerPillEl) {
  // Dismissal pattern mirrors Phase 7.9 nooraniContextMenu: listeners are
  // attached only while the dropdown is open and removed symmetrically when
  // it closes, so no stale handlers leak. Each of outside-click / Escape /
  // window blur / window resize independently triggers closeDropdown().
  let dismissers = null;

  function closePrayerDropdown() {
    prayerPopEl.hidden = true;
    if (dismissers) {
      document.removeEventListener('mousedown', dismissers.onMousedown, true);
      document.removeEventListener('keydown',   dismissers.onKey, true);
      window.removeEventListener('blur',        dismissers.onBlur);
      window.removeEventListener('resize',      dismissers.onResize);
      dismissers = null;
    }
  }

  function openPrayerDropdown() {
    renderPrayerPop();
    prayerPopEl.hidden = false;

    const onMousedown = (e) => {
      // Clicks on the pill itself are handled by the pill's own click
      // listener (toggle). Clicks inside the dropdown are routed to
      // individual prayer items below. Anything else closes.
      if (prayerPillEl.contains(e.target) || prayerPopEl.contains(e.target)) return;
      closePrayerDropdown();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closePrayerDropdown(); }
    };
    const onBlur   = () => closePrayerDropdown();
    const onResize = () => closePrayerDropdown();

    // Capture phase so we see the event before any deeper handler can
    // stopPropagation() on it.
    document.addEventListener('mousedown', onMousedown, true);
    document.addEventListener('keydown',   onKey, true);
    window.addEventListener('blur',        onBlur);
    window.addEventListener('resize',      onResize);
    dismissers = { onMousedown, onKey, onBlur, onResize };
  }

  prayerPillEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (prayerPopEl.hidden) openPrayerDropdown();
    else                    closePrayerDropdown();
  });

  // Clicks on individual prayer rows close the dropdown (they're
  // display-only today, so there's no action beyond the dismissal —
  // but keeping the close on click matches the spec for future actions).
  prayerPopEl.addEventListener('click', (e) => {
    const row = e.target.closest('.prayer-pop__row');
    if (row) closePrayerDropdown();
  });

  // Tab-switch within Noorani also dismisses — the switchToTab() path
  // already calls nooraniContextMenu.hide(); close the dropdown alongside.
  if (typeof window !== 'undefined') {
    window.__nooraniClosePrayerDropdown = closePrayerDropdown;
  }
}

async function refreshPrayerSnapshot() {
  if (!api || !api.prayer) return;
  try {
    prayerSnapshot = await api.prayer.getTimes();
  } catch (_) { prayerSnapshot = null; }
  renderPrayerPill();
  if (!prayerPopEl.hidden) renderPrayerPop();
}

// Gate the worship toolbar buttons (Quran, Duas) on their respective settings
// flags. Called at boot and whenever settings change.
function renderWorshipToolbar() {
  const w = (currentSettings && currentSettings.features && currentSettings.features.worship) || {};
  if (quranBtn) quranBtn.hidden = !w.quranQuickAccess;
  if (duasBtn)  duasBtn.hidden  = !w.duaBookmarks;
}

function startPrayerTicker() {
  if (prayerTickTimer) clearInterval(prayerTickTimer);
  prayerTickTimer = setInterval(() => {
    if (!isPrayerFeatureOn()) return;
    renderPrayerPill();
  }, 30 * 1000);
}

if (api && api.prayer && api.prayer.onUpdate) {
  api.prayer.onUpdate(() => refreshPrayerSnapshot());
}

// Play the user-chosen adhan audio when main fires an azan event.
if (api && api.prayer && api.prayer.onAzanPlay) {
  api.prayer.onAzanPlay(async (_payload) => {
    try {
      const url = await api.worship.getAdhanUrl();
      if (!url) return;
      const audio = new Audio(url);
      audio.play().catch(() => {});
    } catch (_) {}
  });
}

// ============ Startup ============

async function boot() {
  try {
    const [settings, engines] = await Promise.all([
      api ? api.settings.get()      : null,
      api ? api.search.getEngines() : null
    ]);
    if (engines) SEARCH_ENGINES = engines;
    if (settings) {
      currentSettings = settings;
      applyTheme(settings._effectiveTheme || settings.theme);
    }
  } catch (err) {
    console.error('[noorani] settings bootstrap failed:', err);
  }

  // Bookmarks load independently so any failure here doesn't knock out
  // the rest of the chrome.
  if (api && api.bookmarks) {
    api.bookmarks.get().then((list) => {
      bookmarkBarCache = Array.isArray(list) ? list : [];
      renderBookmarkBar();
    }).catch((err) => {
      console.error('[noorani] bookmarks load failed:', err);
    });
  }
  updateBookmarkBarVisibility();

  // Prayer pill fires and forgets — failure just leaves the pill hidden.
  refreshPrayerSnapshot();
  startPrayerTicker();
  renderWorshipToolbar();

  // A detached tab (Part C) or a private window opened from a specific
  // link (Part E's "Open Link in Private Window") arrives with its first
  // tab's URL already decided — skip onboarding/homepage entirely.
  if (BOOT_OPEN_URL) {
    createTab(BOOT_OPEN_URL);
    focusURLBar();
    return;
  }

  // First-run: open welcome instead of the homepage. Subsequent launches
  // take the normal path via getHomepage(). Incognito windows never see
  // onboarding — getHomepage() already routes them to the private landing
  // page instead.
  const needsOnboarding = !IS_INCOGNITO && !!(currentSettings.onboarding &&
                             !currentSettings.onboarding.complete);
  createTab(needsOnboarding ? INTERNAL_WELCOME : undefined);
  focusURLBar();
}

boot();
