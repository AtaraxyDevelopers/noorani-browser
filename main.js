const {
  app, BrowserWindow, Menu, ipcMain, session, shell, protocol,
  nativeTheme, webContents, screen, Notification, dialog, net
} = require('electron');
const path = require('path');
const fs   = require('fs');
const prayer = require('./lib/prayer-engine');
const blocklistEngine = require('./lib/blocklist-engine');
const quranData = require('./lib/quran-data');

let mainWindow = null;

// ============================================================================
// Constants
// ============================================================================

const SETTINGS_VERSION = 6;

// Per-category feature defaults. When new keys are added later, they flow in
// via the migration path in loadSettings() without wiping existing values.
const CALCULATION_METHODS = Object.freeze([
  'Karachi', 'MWL', 'Egyptian', 'UmmAlQura', 'ISNA', 'Tehran',
  'Jafari', 'MoonsightingCommittee'
]);
const ASR_METHODS = Object.freeze(['Shafi', 'Hanafi']);
const PRAYER_NAMES = Object.freeze(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);

const ADHAN_ENABLED_DEFAULTS = Object.freeze({
  fajr: true, dhuhr: true, asr: true, maghrib: true, isha: true
});
const PRAYER_OFFSETS_DEFAULTS = Object.freeze({
  fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0
});

const QURAN_TRANSLATIONS = Object.freeze(['sahih', 'pickthall', 'none']);

const RAMADAN_CATEGORIES_DEFAULTS = Object.freeze({
  foodDelivery:  true,
  recipes:       false,
  entertainment: false,
  social:        false
});

const RAMADAN_DEFAULTS = Object.freeze({
  userEnabled:              true,   // set during onboarding; toggles in settings
  currentlyActive:          false,  // computed daily from Hijri month
  categories:               RAMADAN_CATEGORIES_DEFAULTS,
  customDomains:            [],
  notificationShownForYear: 0       // Hijri year stamp, prevents re-notifying
});

const FEATURES_DEFAULTS = Object.freeze({
  worship: Object.freeze({
    // Display toggles — control whether UI elements render at all.
    prayerTimes:        false,
    azanNotifications:  false,
    qibla:              false,
    hijriCalendar:      false,
    quranQuickAccess:   false,
    duaBookmarks:       false,
    // Calculation config (Phase 9 Batch 1)
    calculationMethod:  'Karachi',
    asrMethod:          'Hanafi',
    adhanSound:         null,            // null = silent, else absolute path to audio
    adhanEnabled:       ADHAN_ENABLED_DEFAULTS,
    prayerOffsets:      PRAYER_OFFSETS_DEFAULTS,
    hijriAdjustment:    0,
    // Phase 9 Batch 3: Quran reader preference
    quranTranslation:   'sahih'          // 'sahih' | 'pickthall' | 'none'
  }),
  contentSafety: Object.freeze({
    halalFilter:        false,
    ramadanMode:        false,
    familySafeMode:     false,
    imageModesty:       false,
    // Phase 9 Batch 2: user-maintained allowlist that overrides the
    // bundled + downloaded blocklists. Domain strings; matches descend
    // down to any subdomain.
    allowlist:          []
  }),
  privacy: Object.freeze({
    blockAdTracking:    true,
    blockCryptoGambling: false,
    blockRibaAds:       false,
    localDataOnly:      true
  }),
  interface: Object.freeze({
    language:           'en',
    rtl:                false
  }),
  // Phase 9 Batch 3: Ramadan mode. Activation gated on
  //   userEnabled && currentlyActive && (now is between Fajr and Maghrib).
  // currentlyActive is recomputed daily from Hijri month — never set by hand.
  ramadan:              RAMADAN_DEFAULTS
});

const ONBOARDING_DEFAULTS = Object.freeze({
  complete:    false,
  completedAt: null
});

const LOCATION_DEFAULTS = Object.freeze({
  city:    null,
  country: null,
  lat:     null,
  lng:     null
});

const UI_DEFAULTS = Object.freeze({
  showBookmarkBar: 'always'   // 'always' | 'new-tab-only' | 'never'
});
const BOOKMARK_BAR_MODES = Object.freeze(['always', 'new-tab-only', 'never']);

const STATS_DEFAULTS = Object.freeze({
  blockedToday:        0,
  blockedAllTime:      0,
  blockedTodayResetAt: null
});

// Developer-only settings — exposed in the "Developer (for testing only)"
// section of settings. hijriMonthOverride forces the Hijri month to a specific
// value so Ramadan mode (month 9) can be exercised without waiting for Ramadan.
// null = auto (real Hijri date); integer 1..12 = forced month.
const DEVELOPER_DEFAULTS = Object.freeze({
  hijriMonthOverride: null
});

// Phase v1.0.1 Part E — incognito window behavior preferences.
const PRIVATE_BROWSING_DEFAULTS = Object.freeze({
  alwaysExternalLinks:  false,
  confirmCloseMultiTab: true
});

const SETTINGS_DEFAULTS = Object.freeze({
  theme:              'light',                   // 'light' | 'dark' | 'auto'
  searchEngine:       'google',
  homepage:           'noorani://home',
  useCustomHomepage:  false,
  version:            SETTINGS_VERSION,
  onboarding:         ONBOARDING_DEFAULTS,
  location:           LOCATION_DEFAULTS,
  features:           FEATURES_DEFAULTS,
  ui:                 UI_DEFAULTS,
  stats:              STATS_DEFAULTS,
  developer:          DEVELOPER_DEFAULTS,
  privateBrowsing:    PRIVATE_BROWSING_DEFAULTS
});

const SUPPORTED_LANGUAGES = Object.freeze(['en', 'ur', 'ar', 'id', 'tr', 'ms']);

const SEARCH_ENGINES = Object.freeze({
  google:     { name: 'Google',     search: 'https://www.google.com/search?q=' },
  bing:       { name: 'Bing',       search: 'https://www.bing.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', search: 'https://duckduckgo.com/?q=' },
  brave:      { name: 'Brave',      search: 'https://search.brave.com/search?q=' },
  ecosia:     { name: 'Ecosia',     search: 'https://www.ecosia.org/search?q=' }
});

// ============================================================================
// Storage layer
// ============================================================================

const dataDir = () => path.join(app.getPath('userData'), 'data');

function ensureDataDir() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJSON(filename, fallback) {
  ensureDataDir();
  const p = path.join(dataDir(), filename);
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf-8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error(`[noorani] load ${filename} failed:`, err);
    return fallback;
  }
}

function saveJSON(filename, data) {
  ensureDataDir();
  const p = path.join(dataDir(), filename);
  try {
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[noorani] save ${filename} failed:`, err);
  }
}

// Shallow-merge a single feature category so per-category updates don't wipe
// keys the user hasn't explicitly set. Called during schema migration and
// during onboarding:complete.
function mergeCategory(defaults, existing) {
  const out = { ...defaults };
  if (existing && typeof existing === 'object') {
    for (const [k, v] of Object.entries(existing)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

// Migrate a raw settings object to the current schema (v2). Preserves any
// existing user values; fills in missing keys from defaults. Pure function —
// doesn't touch disk.
function migrateSettings(raw) {
  if (!raw || typeof raw !== 'object') raw = {};
  const rawFeatures = (raw.features && typeof raw.features === 'object') ? raw.features : {};

  const merged = {
    theme:             raw.theme             !== undefined ? raw.theme             : SETTINGS_DEFAULTS.theme,
    searchEngine:      raw.searchEngine      !== undefined ? raw.searchEngine      : SETTINGS_DEFAULTS.searchEngine,
    homepage:          raw.homepage          !== undefined ? raw.homepage          : SETTINGS_DEFAULTS.homepage,
    useCustomHomepage: raw.useCustomHomepage !== undefined ? raw.useCustomHomepage : SETTINGS_DEFAULTS.useCustomHomepage,
    onboarding:        mergeCategory(ONBOARDING_DEFAULTS, raw.onboarding),
    location:          mergeCategory(LOCATION_DEFAULTS,   raw.location),
    features: {
      worship:       mergeCategory(FEATURES_DEFAULTS.worship,       rawFeatures.worship),
      contentSafety: mergeCategory(FEATURES_DEFAULTS.contentSafety, rawFeatures.contentSafety),
      privacy:       mergeCategory(FEATURES_DEFAULTS.privacy,       rawFeatures.privacy),
      interface:     mergeCategory(FEATURES_DEFAULTS.interface,     rawFeatures.interface),
      ramadan:       mergeCategory(FEATURES_DEFAULTS.ramadan,       rawFeatures.ramadan)
    },
    ui:              mergeCategory(UI_DEFAULTS,               raw.ui),
    stats:           mergeCategory(STATS_DEFAULTS,            raw.stats),
    developer:       mergeCategory(DEVELOPER_DEFAULTS,        raw.developer),
    privateBrowsing: mergeCategory(PRIVATE_BROWSING_DEFAULTS, raw.privateBrowsing),
    version:   SETTINGS_VERSION
  };

  // Validation for the flat fields
  if (!['light','dark','auto'].includes(merged.theme)) merged.theme = SETTINGS_DEFAULTS.theme;
  if (!SEARCH_ENGINES[merged.searchEngine])            merged.searchEngine = SETTINGS_DEFAULTS.searchEngine;
  if (typeof merged.useCustomHomepage !== 'boolean')   merged.useCustomHomepage = SETTINGS_DEFAULTS.useCustomHomepage;
  if (typeof merged.homepage !== 'string')             merged.homepage = SETTINGS_DEFAULTS.homepage;

  if (!SUPPORTED_LANGUAGES.includes(merged.features.interface.language)) {
    merged.features.interface.language = FEATURES_DEFAULTS.interface.language;
  }
  if (typeof merged.features.interface.rtl !== 'boolean') {
    merged.features.interface.rtl = FEATURES_DEFAULTS.interface.rtl;
  }
  if (!BOOKMARK_BAR_MODES.includes(merged.ui.showBookmarkBar)) {
    merged.ui.showBookmarkBar = UI_DEFAULTS.showBookmarkBar;
  }

  normalizeWorship(merged.features.worship);
  normalizeContentSafety(merged.features.contentSafety);
  normalizeRamadan(merged.features.ramadan);
  normalizeStats(merged.stats);
  normalizeDeveloper(merged.developer);
  merged.privateBrowsing.alwaysExternalLinks  = !!merged.privateBrowsing.alwaysExternalLinks;
  merged.privateBrowsing.confirmCloseMultiTab = !!merged.privateBrowsing.confirmCloseMultiTab;
  return merged;
}

// Ramadan category — shallow merge leaves nested `categories` and
// `customDomains` as frozen defaults. Deep-fill and coerce scalars.
function normalizeRamadan(r) {
  r.categories   = mergeCategory(RAMADAN_CATEGORIES_DEFAULTS, r.categories);
  for (const k of Object.keys(RAMADAN_CATEGORIES_DEFAULTS)) {
    r.categories[k] = !!r.categories[k];
  }
  r.userEnabled     = !!r.userEnabled;
  r.currentlyActive = !!r.currentlyActive;

  const raw = Array.isArray(r.customDomains) ? r.customDomains : [];
  const clean = new Set();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const h = cleanAllowlistEntry(entry);  // reuse hostname normalizer
    if (h) clean.add(h);
  }
  r.customDomains = [...clean].sort();

  const year = Number(r.notificationShownForYear);
  r.notificationShownForYear = Number.isFinite(year) && year >= 0
    ? Math.floor(year) : 0;
  return r;
}

function normalizeDeveloper(d) {
  if (!d || typeof d !== 'object') return;
  const m = d.hijriMonthOverride;
  if (m === null || m === undefined || m === 'auto' || m === '') {
    d.hijriMonthOverride = null;
  } else {
    const n = Number(m);
    d.hijriMonthOverride = Number.isFinite(n) && n >= 1 && n <= 12
      ? Math.floor(n) : null;
  }
}

// contentSafety.allowlist is a list of cleaned hostnames. Strip any
// scheme/path the user might paste, lowercase, and dedupe.
function normalizeContentSafety(c) {
  const raw = Array.isArray(c.allowlist) ? c.allowlist : [];
  const clean = new Set();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const h = cleanAllowlistEntry(entry);
    if (h) clean.add(h);
  }
  c.allowlist = [...clean].sort();
  return c;
}

function cleanAllowlistEntry(entry) {
  let s = String(entry || '').trim().toLowerCase();
  if (!s) return '';
  // Drop scheme/path — we only match on host.
  try {
    if (!/^[a-z]+:\/\//.test(s)) s = 'http://' + s;
    const u = new URL(s);
    s = u.hostname;
  } catch (_) {
    s = s.replace(/^[a-z]+:\/\//, '').split('/')[0];
  }
  if (s.startsWith('www.')) s = s.slice(4);
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (!/[a-z0-9.-]+/.test(s) || s.indexOf('.') < 0) return '';
  return s;
}

function normalizeStats(s) {
  if (!s || typeof s !== 'object') return;
  const today     = Number(s.blockedToday);
  const allTime   = Number(s.blockedAllTime);
  s.blockedToday   = Number.isFinite(today)   && today   >= 0 ? Math.floor(today)   : 0;
  s.blockedAllTime = Number.isFinite(allTime) && allTime >= 0 ? Math.floor(allTime) : 0;
  if (s.blockedTodayResetAt && typeof s.blockedTodayResetAt !== 'string') {
    s.blockedTodayResetAt = null;
  }
  // Daily rollover: if the last reset was on a different calendar day,
  // zero today's counter.
  if (s.blockedTodayResetAt) {
    const lastReset = new Date(s.blockedTodayResetAt);
    const now = new Date();
    if (Number.isNaN(lastReset.getTime()) ||
        lastReset.toDateString() !== now.toDateString()) {
      s.blockedToday = 0;
      s.blockedTodayResetAt = now.toISOString();
    }
  } else {
    s.blockedTodayResetAt = new Date().toISOString();
  }
}

// Post-mergeCategory hook for worship — the shallow merge doesn't descend
// into adhanEnabled / prayerOffsets, so users upgrading from a prior schema
// where those were absent would end up with frozen defaults they couldn't
// mutate later. Deep-fill and validate scalar fields here.
function normalizeWorship(w) {
  w.adhanEnabled  = mergeCategory(ADHAN_ENABLED_DEFAULTS,  w.adhanEnabled);
  w.prayerOffsets = mergeCategory(PRAYER_OFFSETS_DEFAULTS, w.prayerOffsets);

  if (!CALCULATION_METHODS.includes(w.calculationMethod)) {
    w.calculationMethod = FEATURES_DEFAULTS.worship.calculationMethod;
  }
  if (!ASR_METHODS.includes(w.asrMethod)) {
    w.asrMethod = FEATURES_DEFAULTS.worship.asrMethod;
  }
  if (!QURAN_TRANSLATIONS.includes(w.quranTranslation)) {
    w.quranTranslation = FEATURES_DEFAULTS.worship.quranTranslation;
  }
  if (typeof w.adhanSound !== 'string' || !w.adhanSound.length) {
    w.adhanSound = null;
  }
  // Clamp offsets and adhanEnabled into legal shapes.
  for (const name of PRAYER_NAMES) {
    const off = Number(w.prayerOffsets[name]);
    w.prayerOffsets[name] = Number.isFinite(off)
      ? Math.max(-30, Math.min(30, Math.round(off)))
      : 0;
    w.adhanEnabled[name] = !!w.adhanEnabled[name];
  }
  const adj = Number(w.hijriAdjustment);
  w.hijriAdjustment = Number.isFinite(adj)
    ? Math.max(-2, Math.min(2, Math.round(adj)))
    : 0;
  return w;
}

function loadSettings() {
  const raw = loadJSON('settings.json', null);
  const migrated = migrateSettings(raw);
  // Persist the migration once so the file on disk matches the current schema.
  const needsMigration = !raw || !raw.version || raw.version < SETTINGS_VERSION;
  if (needsMigration) saveJSON('settings.json', migrated);
  return migrated;
}

function saveSettings(settings) {
  saveJSON('settings.json', settings);
}

function getEffectiveTheme(settings) {
  if (settings.theme === 'auto') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }
  return settings.theme;
}

function getVersions() {
  return {
    app:      app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node:     process.versions.node
  };
}

// ============================================================================
// noorani:// protocol
// ============================================================================

protocol.registerSchemesAsPrivileged([{
  scheme: 'noorani',
  privileges: {
    standard: true, secure: true,
    supportFetchAPI: true, stream: true,
    bypassCSP: false, allowServiceWorkers: false
  }
}]);

function computeTopSites(limit = 6) {
  const history = loadJSON('history.json', []);
  const counts = new Map();
  for (const h of history) {
    if (!h || !h.url) continue;
    const ex = counts.get(h.url) ||
      { url: h.url, title: h.title, favicon: h.favicon, count: 0 };
    ex.count++;
    if (h.title)   ex.title   = h.title;
    if (h.favicon) ex.favicon = h.favicon;
    counts.set(h.url, ex);
  }
  const top = [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  if (top.length < limit) {
    const bookmarks = loadJSON('bookmarks.json', []);
    for (const b of bookmarks) {
      if (top.length >= limit) break;
      if (!top.some(t => t.url === b.url)) {
        top.push({ url: b.url, title: b.title, favicon: b.favicon, count: 0 });
      }
    }
  }
  return top;
}

function buildInternalHtml(pageName, search) {
  const templatePath = path.join(__dirname, `${pageName}.html`);
  if (!fs.existsSync(templatePath)) return null;
  const template = fs.readFileSync(templatePath, 'utf-8');
  const settings = loadSettings();
  // Query params reach the page via window.__NOORANI_DATA__.query — used
  // by blocked.html to show the offending host + category.
  const query = {};
  if (search) {
    try {
      const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
      for (const [k, v] of p.entries()) query[k] = v;
    } catch (_) {}
  }
  const data = {
    page:           pageName,
    topSites:       pageName === 'home' ? computeTopSites(6) : [],
    settings,
    effectiveTheme: getEffectiveTheme(settings),
    versions:       getVersions(),
    engines:        { ...SEARCH_ENGINES },
    query
  };
  const inject =
    `<script id="__noorani_data">` +
    `window.__NOORANI_DATA__ = ${JSON.stringify(data).replace(/</g, '\\u003c')};` +
    `</script>`;
  return template.replace('<!-- NOORANI_DATA -->', inject);
}

// Static asset files that noorani:// pages may request. Each is served with
// a fixed content-type from the app directory. Whitelisted explicitly so a
// malformed URL can never pull arbitrary files off disk.
const NOORANI_ASSETS = Object.freeze({
  '/modal.js':                              'text/javascript; charset=utf-8',
  '/css/typography.css':                    'text/css; charset=utf-8',
  '/contextmenu.js':                        'text/javascript; charset=utf-8',
  '/assets/fonts/AmiriQuran-Regular.ttf':   'font/ttf'
});

function registerNooraniProtocol() {
  protocol.handle('noorani', (request) => {
    try {
      const u = new URL(request.url);
      const page = u.hostname;
      const pathname = u.pathname || '/';

      // Static asset (modal.js etc.) served for any hostname.
      if (NOORANI_ASSETS[pathname]) {
        const filePath = path.join(__dirname, pathname.slice(1));
        if (!fs.existsSync(filePath)) {
          return new Response('Not Found', { status: 404 });
        }
        const body = fs.readFileSync(filePath);
        return new Response(body, {
          status: 200,
          headers: { 'content-type': NOORANI_ASSETS[pathname] }
        });
      }

      // Adhan audio — served from the user's data dir via the noorani://
      // scheme so the renderer CSP doesn't need a file: exception.
      if (page === 'adhan') {
        const s = loadSettings();
        const p = s.features && s.features.worship && s.features.worship.adhanSound;
        if (!p || !fs.existsSync(p)) {
          return new Response('Not Found', { status: 404 });
        }
        const ext = path.extname(p).toLowerCase();
        const ct = ext === '.mp3' ? 'audio/mpeg'
                 : ext === '.ogg' ? 'audio/ogg'
                 : ext === '.wav' ? 'audio/wav'
                 : ext === '.m4a' ? 'audio/mp4'
                 :                  'application/octet-stream';
        const body = fs.readFileSync(p);
        return new Response(body, {
          status: 200,
          headers: { 'content-type': ct, 'cache-control': 'no-store' }
        });
      }

      if (pathname !== '/' && pathname !== '') {
        return new Response('Not Found', { status: 404 });
      }
      if (page === 'home' || page === 'settings' || page === 'welcome' ||
          page === 'blocked' || page === 'quran' || page === 'duas' ||
          page === 'private') {
        const html = buildInternalHtml(page, u.search);
        if (!html) return new Response('Template missing', { status: 500 });
        return new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        });
      }
      return new Response('Not Found', { status: 404 });
    } catch (err) {
      return new Response('noorani:// handler error: ' + err.message,
        { status: 500 });
    }
  });
}

// ============================================================================
// Broadcasts — reach chrome renderer + every webview guest
// ============================================================================

function broadcastToAll(channel, payload) {
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) {
      try { wc.send(channel, payload); } catch (_) { /* swallow */ }
    }
  }
}

function broadcastSettings() {
  const s = loadSettings();
  broadcastToAll('settings:changed', {
    ...s,
    _effectiveTheme: getEffectiveTheme(s)
  });
}

// ============================================================================
// Content protection — blocklist + webRequest interception
// ============================================================================

// Hot-path state. loadedBlocklists holds the parsed blocklist data
// (read from disk at boot + on every refresh). combinedSet holds the
// union of enabled categories' domain Sets — this is what the per-request
// handler actually hits. allowlistSet holds the user's explicit overrides.
let loadedBlocklists = null;
let combinedSet      = new Set();
let allowlistSet     = new Set();

// Blocking stats accumulate in memory and flush to settings.stats every
// STATS_FLUSH_INTERVAL_MS, plus on app quit. Avoids a disk write on every
// blocked request (could easily be thousands per minute).
let pendingBlockedIncrement = 0;
let statsFlushTimer = null;
const STATS_FLUSH_INTERVAL_MS = 15 * 1000;

// A transient "temporary unblock" — a single allowance for a domain,
// used when the user clicks "Unblock this site temporarily" on the
// blocked page. Lives in memory only; resets on app relaunch.
const tempUnblocked = new Set();

function contentProtectionLoad() {
  loadedBlocklists = blocklistEngine.loadBlocklists(dataDir());
  rebuildCombinedSet();
  rebuildAllowlistSet();
}

function rebuildCombinedSet() {
  if (!loadedBlocklists) return;
  const s = loadSettings();
  const active = blocklistEngine.activeCategoriesFromSettings(s);

  // Ramadan gate (Phase 9 Batch 3). When on, populate the synthetic
  // `ramadan` category Set so categoryForHost can identify it on the
  // blocked page; otherwise clear it so it contributes nothing.
  const snap = computePrayerSnapshot();
  const ramadanDomains = computeRamadanBlockedDomains(s, snap);
  loadedBlocklists.categories.ramadan = ramadanDomains;
  if (ramadanDomains.size > 0) active.push('ramadan');

  combinedSet = blocklistEngine.buildCombinedSet(loadedBlocklists, active);
}

function rebuildAllowlistSet() {
  const s = loadSettings();
  const list = (s.features && s.features.contentSafety &&
                Array.isArray(s.features.contentSafety.allowlist))
    ? s.features.contentSafety.allowlist : [];
  allowlistSet = new Set(list.map(blocklistEngine.canonHost));
}

// Extracts the resource type (mainFrame vs subFrame vs asset) from the
// details an Electron webRequest handler receives. Main-frame blocks
// redirect to noorani://blocked; everything else is silently cancelled.
function handleRequest(details, callback) {
  const url = details.url;
  if (!url || !combinedSet.size) return callback({ cancel: false });

  // Temp unblock (in-memory, single session).
  try {
    const host = blocklistEngine.canonHost(new URL(url).hostname);
    for (const a of blocklistEngine.hostAncestors(host)) {
      if (tempUnblocked.has(a)) return callback({ cancel: false });
    }
  } catch (_) { /* fall through */ }

  const result = blocklistEngine.isRequestBlocked(
    url, combinedSet, loadedBlocklists, allowlistSet
  );
  if (!result.blocked) return callback({ cancel: false });

  incrementBlockedCounter();

  if (details.resourceType === 'mainFrame') {
    let host = '';
    try { host = new URL(url).hostname; } catch (_) {}
    const params = new URLSearchParams({
      host,
      category: result.category || 'blocked',
      url
    });
    return callback({
      redirectURL: 'noorani://blocked?' + params.toString()
    });
  }
  return callback({ cancel: true });
}

function registerWebRequestBlocker() {
  // We never filter by URL pattern here — the handler itself does the
  // category-sensitive lookup so settings changes take effect immediately
  // without re-registering the handler.
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    handleRequest
  );
}

// ============================================================================
// Site permissions (Phase v1.0.1 Part B) — camera / mic / location / etc.
// ============================================================================
// In-memory mirror of site-permissions.json, kept in sync by every write
// path (IPC remove/clear, and rememberDecision below) so the synchronous
// setPermissionCheckHandler never has to touch disk on the hot path.
let permissionsCache = {};

const HANDLED_PERMISSIONS = new Set([
  'media', 'geolocation', 'notifications', 'midi',
  'pointerLock', 'fullscreen', 'openExternal', 'clipboard-read'
]);

function normalizeOrigin(raw) {
  try { return new URL(raw).origin; } catch (_) { return String(raw || 'unknown'); }
}

// 'media' bundles camera+mic under one Electron permission string; split it
// into the per-capability keys the settings UI and storage schema use.
// details.mediaTypes (when Electron supplies it) tells us which of the two
// were actually requested — a mic-only call shouldn't need a camera grant.
function permissionTypesFor(permission, details) {
  if (permission === 'media') {
    const mt = (details && Array.isArray(details.mediaTypes) && details.mediaTypes.length)
      ? details.mediaTypes
      : ['audio', 'video'];
    return mt.map((t) => t === 'audio' ? 'microphone' : t === 'video' ? 'camera' : t);
  }
  return [permission];
}

function checkPermission(requestingOrigin, permission, details, store) {
  if (!HANDLED_PERMISSIONS.has(permission)) return false;
  const origin = normalizeOrigin(requestingOrigin);
  const types = permissionTypesFor(permission, details);
  const rec = store[origin];
  if (!rec) return false;
  return types.every((t) => rec[t] === 'allow');
}

let permissionRequestCounter = 0;
// requestId -> { callback, types, origin, getStore, persistStore, timeout }
const pendingPermissionRequests = new Map();

// installPermissionHandlers is called once for session.defaultSession (all
// normal windows share it) and once per incognito window on its own
// ephemeral session. isIncognito swaps disk-backed storage for an in-memory
// object that's garbage-collected with the session when the window closes —
// per spec, incognito "remembers" nothing across restarts and never touches
// site-permissions.json.
function installPermissionHandlers(sess, opts) {
  opts = opts || {};
  const isIncognito = !!opts.isIncognito;
  const memStore = isIncognito ? {} : null;

  function getStore() { return isIncognito ? memStore : permissionsCache; }
  function persistStore(store) {
    if (isIncognito) { Object.assign(memStore, store); return; }
    saveJSON('site-permissions.json', store);
    permissionsCache = store;
    broadcastToAll('permissions:changed', store);
  }

  sess.setPermissionRequestHandler((webContents, permission, callback, details) => {
    handlePermissionRequest(webContents, permission, callback, details, getStore, persistStore);
  });
  sess.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return checkPermission(requestingOrigin, permission, details, getStore());
  });
}

function handlePermissionRequest(webContents, permission, callback, details, getStore, persistStore) {
  if (!HANDLED_PERMISSIONS.has(permission)) { callback(false); return; }

  const origin = normalizeOrigin((details && details.requestingUrl) || webContents.getURL());
  const types  = permissionTypesFor(permission, details);
  const store  = getStore();
  const rec    = store[origin];

  // Fully remembered (every requested type has a stored decision) — resolve
  // without prompting. A single denied type sinks the whole request, same
  // as a real permission grant would (you can't half-allow "media").
  if (rec && types.every((t) => rec[t] !== undefined)) {
    callback(types.every((t) => rec[t] === 'allow'));
    return;
  }

  // Guest webContents (the <webview> the request came from) exposes
  // hostWebContents pointing back at the chrome window that embeds it.
  const hostWc = webContents.hostWebContents || webContents;
  const win = BrowserWindow.fromWebContents(hostWc) || BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win || win.isDestroyed()) { callback(false); return; }

  const requestId = 'perm_' + (++permissionRequestCounter) + '_' + Date.now();
  // Safety net: if the renderer never responds (window closed mid-prompt,
  // renderer crash), don't leave the site's getUserMedia() promise hanging
  // forever — deny after a minute.
  const timeout = setTimeout(() => {
    if (pendingPermissionRequests.has(requestId)) {
      pendingPermissionRequests.delete(requestId);
      callback(false);
    }
  }, 60000);

  pendingPermissionRequests.set(requestId, { callback, types, origin, getStore, persistStore, timeout });

  try {
    win.webContents.send('permission:request', {
      requestId, origin, types,
      siteName: origin.replace(/^https?:\/\//, '')
    });
  } catch (_) {
    clearTimeout(timeout);
    pendingPermissionRequests.delete(requestId);
    callback(false);
  }
}

// Called from the 'permissions:respond' IPC handler once the renderer's
// in-app modal resolves.
function respondToPermissionRequest(payload) {
  const requestId = payload && payload.requestId;
  const entry = requestId && pendingPermissionRequests.get(requestId);
  if (!entry) return;
  pendingPermissionRequests.delete(requestId);
  clearTimeout(entry.timeout);

  const allow = payload.action === 'allow';
  entry.callback(allow);

  if (payload.remember) {
    const store = entry.getStore();
    const rec = { ...(store[entry.origin] || {}) };
    for (const t of entry.types) rec[t] = allow ? 'allow' : 'deny';
    store[entry.origin] = rec;
    entry.persistStore(store);
  }
}

function incrementBlockedCounter() {
  pendingBlockedIncrement++;
  if (!statsFlushTimer) {
    statsFlushTimer = setTimeout(flushStats, STATS_FLUSH_INTERVAL_MS);
  }
}

function flushStats() {
  statsFlushTimer = null;
  if (pendingBlockedIncrement <= 0) return;
  const s = loadSettings();
  normalizeStats(s.stats);  // rolls over at midnight
  s.stats.blockedToday   += pendingBlockedIncrement;
  s.stats.blockedAllTime += pendingBlockedIncrement;
  pendingBlockedIncrement = 0;
  saveSettings(s);
  broadcastToAll('stats:changed', s.stats);
}

// Permanent allowlist management — single entry points so shape
// normalisation lives in one place.
function addToAllowlist(entry) {
  const host = cleanAllowlistEntry(entry);
  if (!host) return { error: 'invalid' };
  const s = loadSettings();
  const cs = s.features.contentSafety;
  if (!Array.isArray(cs.allowlist)) cs.allowlist = [];
  if (!cs.allowlist.includes(host)) {
    cs.allowlist.push(host);
    normalizeContentSafety(cs);
    saveSettings(s);
    rebuildAllowlistSet();
    broadcastSettings();
  }
  return { host, allowlist: cs.allowlist };
}

function removeFromAllowlist(entry) {
  const host = cleanAllowlistEntry(entry);
  if (!host) return { error: 'invalid' };
  const s = loadSettings();
  const cs = s.features.contentSafety;
  const next = (cs.allowlist || []).filter((h) => h !== host);
  cs.allowlist = next;
  saveSettings(s);
  rebuildAllowlistSet();
  broadcastSettings();
  return { host, allowlist: next };
}

// ============================================================================
// Downloads — session-only tracking
// ============================================================================

const downloads     = [];
const downloadItems = new Map();
let   dlCounter     = 0;

function broadcastDownloads() {
  broadcastToAll('downloads:update', downloads.slice());
}

function setupDownloads() {
  session.defaultSession.on('will-download', (_event, item) => {
    const id = 'dl-' + (++dlCounter);
    const info = {
      id,
      filename:      item.getFilename(),
      url:           item.getURL(),
      savedPath:     null,
      totalBytes:    item.getTotalBytes(),
      receivedBytes: 0,
      progress:      0,
      state:         'started',
      startedAt:     Date.now()
    };
    downloads.unshift(info);
    downloadItems.set(id, item);
    broadcastDownloads();

    item.on('updated', (_e, state) => {
      info.receivedBytes = item.getReceivedBytes();
      info.totalBytes    = item.getTotalBytes();
      info.progress      = info.totalBytes > 0
        ? info.receivedBytes / info.totalBytes
        : 0;
      info.state = state;
      broadcastDownloads();
    });

    item.once('done', (_e, state) => {
      info.state     = state;
      info.savedPath = item.getSavePath();
      if (state === 'completed') info.progress = 1;
      downloadItems.delete(id);
      broadcastDownloads();
    });
  });
}

// ============================================================================
// Worship / Prayer logic (Phase 9 Batch 1)
// ============================================================================

// Keeps the chain of setTimeouts we've installed for today's prayer
// notifications and for the next-prayer refresh broadcast. Cleared and
// re-armed on every call to onWorshipStateChanged().
let prayerRefreshTimer = null;
const azanTimers = [];

function clearAzanTimers() {
  while (azanTimers.length) clearTimeout(azanTimers.pop());
}
function clearPrayerRefreshTimer() {
  if (prayerRefreshTimer) {
    clearTimeout(prayerRefreshTimer);
    prayerRefreshTimer = null;
  }
}

// Returns { times, next, location, worship } or null if location not set.
function computePrayerSnapshot(date) {
  const s = loadSettings();
  const loc = s.location || {};
  const w = s.features.worship;
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) {
    return {
      location: loc,
      worship: w,
      times: null,
      next: null,
      error: 'no-coords'
    };
  }
  try {
    const times = prayer.calculatePrayerTimes(
      loc.lat, loc.lng, date || new Date(),
      w.calculationMethod, w.asrMethod, w.prayerOffsets
    );
    const next = prayer.getNextPrayer(
      loc.lat, loc.lng, w.calculationMethod, w.asrMethod, w.prayerOffsets
    );
    return { location: loc, worship: w, times, next, error: null };
  } catch (err) {
    console.error('[noorani] prayer compute failed:', err);
    return { location: loc, worship: w, times: null, next: null, error: err.message };
  }
}

function computeNextPrayer() {
  const snap = computePrayerSnapshot();
  return snap.next ? { ...snap.next, error: snap.error } : { next: null, error: snap.error };
}

function computeQibla() {
  const s = loadSettings();
  const loc = s.location || {};
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) {
    return { bearing: null, compass: null, error: 'no-coords' };
  }
  return { ...prayer.calculateQibla(loc.lat, loc.lng), error: null };
}

function computeHijri(isoDate) {
  const s = loadSettings();
  const adj = s.features.worship.hijriAdjustment || 0;
  const d = isoDate ? new Date(isoDate) : new Date();
  const real = prayer.getHijriDate(d, adj);

  // developer.hijriMonthOverride is a testing aid for the Ramadan mode
  // engine — when set to an integer 1..12, we rewrite the month on the
  // returned Hijri date. The underlying Gregorian→Hijri conversion still
  // runs so day-of-month stays sensible; only the month (and the derived
  // monthName) are substituted.
  const override = s.developer && s.developer.hijriMonthOverride;
  if (Number.isFinite(override) && override >= 1 && override <= 12) {
    return {
      ...real,
      month:     override,
      monthName: HIJRI_MONTH_NAMES[override - 1] || real.monthName,
      formatted: `${real.day} ${HIJRI_MONTH_NAMES[override - 1] || real.monthName} ${real.year} (simulated)`
    };
  }
  return real;
}

const HIJRI_MONTH_NAMES = Object.freeze([
  'Muharram', 'Safar', "Rabi' al-awwal", "Rabi' al-thani",
  'Jumada al-awwal', 'Jumada al-thani', 'Rajab', "Sha'ban",
  'Ramadan', 'Shawwal', "Dhu al-Qi'dah", "Dhu al-Hijjah"
]);

// ============================================================================
// Ramadan mode (Phase 9 Batch 3)
// ============================================================================
//
// The Ramadan gate has three independent conditions, all of which must be
// true before any Ramadan-category blocking applies:
//
//   1. User opted in           — settings.features.ramadan.userEnabled
//   2. It's actually Ramadan   — settings.features.ramadan.currentlyActive
//                                (computed daily from Hijri month; honors
//                                 developer.hijriMonthOverride)
//   3. We're in fasting hours  — local time is between Fajr and Maghrib
//                                from today's computed prayer snapshot
//
// When all three are true, we union the enabled subcategories' domains
// (foodDelivery, recipes, entertainment, social) plus the user's
// customDomains into combinedSet. When any condition is false, Ramadan
// contributes zero domains — the regular web is unblocked.

function isInFastingHours(snap) {
  const times = snap && snap.times;
  if (!times || !times.fajr || !times.maghrib) return false;
  const now = Date.now();
  return now >= times.fajr.getTime() && now < times.maghrib.getTime();
}

function isRamadanGateOn(settings, snap) {
  const r = settings && settings.features && settings.features.ramadan;
  if (!r || !r.userEnabled || !r.currentlyActive) return false;
  return isInFastingHours(snap);
}

// Given the current settings + prayer snapshot, returns a Set of domains
// that should be blocked under Ramadan mode right now. Empty if the gate
// is off. Exposed here (not in blocklist-engine) because it depends on
// prayer-time state that lives in main.
function computeRamadanBlockedDomains(settings, snap) {
  if (!isRamadanGateOn(settings, snap)) return new Set();
  return blocklistEngine.loadRamadanDomains(settings.features.ramadan);
}

// Read Hijri month *via computeHijri* so developer.hijriMonthOverride is
// respected everywhere it matters. Returns an integer 1..12 or null.
function currentHijriMonth() {
  try {
    const h = computeHijri();
    return Number.isFinite(h.month) ? h.month : null;
  } catch (_) { return null; }
}
function hijriForOffsetDays(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  try { return computeHijri(d.toISOString()); } catch (_) { return null; }
}

// Recomputes settings.features.ramadan.currentlyActive based on today's
// effective Hijri month. Called at boot, on midnight rollover, and after
// any developer override change. Persists the flag; rebuilds the
// combined set; returns true if the flag flipped.
function updateRamadanActiveFlag() {
  const s = loadSettings();
  const month = currentHijriMonth();
  const shouldBeActive = (month === 9);
  const wasActive = !!(s.features.ramadan && s.features.ramadan.currentlyActive);
  if (wasActive !== shouldBeActive) {
    s.features.ramadan.currentlyActive = shouldBeActive;
    saveSettings(s);
    rebuildCombinedSet();
    broadcastToAll('settings:changed', s);
    return true;
  }
  return false;
}

let ramadanMidnightTimer = null;
function clearRamadanMidnightTimer() {
  if (ramadanMidnightTimer) { clearTimeout(ramadanMidnightTimer); ramadanMidnightTimer = null; }
}

// Every local midnight, re-check Ramadan status and fire any due
// notification. Chained via setTimeout so we don't drift across DST.
function scheduleRamadanMidnightCheck() {
  clearRamadanMidnightTimer();
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 10, 0);
  const delay = Math.max(1000, next.getTime() - now.getTime());
  ramadanMidnightTimer = setTimeout(() => {
    try {
      updateRamadanActiveFlag();
      checkAndFireRamadanNotifications();
    } finally {
      scheduleRamadanMidnightCheck();
    }
  }, delay);
}

// Checks today/tomorrow/yesterday Hijri dates and fires at most one
// "entering Ramadan" notification per Hijri year (locked by
// notificationShownForYear). The end-of-Ramadan notification is implicit:
// when we detect today=Ramadan AND tomorrow!=Ramadan, we fire an Eid
// notification (guarded in-memory to avoid duplicates on rapid restarts).
let lastEidFiredForYear = 0;

function checkAndFireRamadanNotifications() {
  const s = loadSettings();
  const today     = hijriForOffsetDays(0);
  const tomorrow  = hijriForOffsetDays(1);
  const in3days   = hijriForOffsetDays(3);
  const yesterday = hijriForOffsetDays(-1);
  if (!today) return;

  const thisYear = today.year;
  const lastShown = (s.features.ramadan && s.features.ramadan.notificationShownForYear) || 0;

  // --- Last day of Ramadan (fires even if a start notif was fired)
  if (today.month === 9 && tomorrow && tomorrow.month !== 9) {
    if (lastEidFiredForYear !== thisYear) {
      fireRamadanNotification(
        'Eid Mubarak',
        'Ramadan mode has ended. Taqabbal Allahu minna wa minkum.'
      );
      lastEidFiredForYear = thisYear;
    }
    return;
  }

  // Only one start-of-Ramadan notification per Hijri year.
  if (lastShown >= thisYear) return;

  let fired = false;
  const userEnabledLabel = s.features.ramadan.userEnabled ? 'enabled' : 'disabled';

  // Day 1 of Ramadan
  if (today.month === 9 && (!yesterday || yesterday.month !== 9)) {
    fireRamadanNotification(
      'Ramadan Mubarak',
      `Ramadan mode is now ${userEnabledLabel} during fasting hours.`
    );
    fired = true;
  }
  // 1 day before Ramadan
  else if (tomorrow && tomorrow.month === 9 && today.month !== 9) {
    fireRamadanNotification(
      'Ramadan starts tomorrow',
      `Your Ramadan mode is ${userEnabledLabel}.`
    );
    fired = true;
  }
  // 3 days before Ramadan
  else if (in3days && in3days.month === 9 && today.month !== 9) {
    fireRamadanNotification(
      'Ramadan begins in 3 days',
      'Review your Ramadan mode settings.'
    );
    fired = true;
  }

  if (fired) {
    s.features.ramadan.notificationShownForYear = thisYear;
    saveSettings(s);
  }
}

function fireRamadanNotification(title, body) {
  try {
    const n = new Notification({ title, body, silent: true });
    n.show();
    setTimeout(() => { try { n.close(); } catch (_) {} }, 60000);
  } catch (err) {
    console.error('[noorani] ramadan notification failed:', err);
  }
}

// Nominatim geocoder. Uses Electron's net module so we share Chromium's
// certificate store. One request, limit=1. Respects a polite User-Agent.
function geocodeLocation(city, country) {
  return new Promise((resolve) => {
    const q = [city, country].filter(Boolean).join(', ');
    const url = 'https://nominatim.openstreetmap.org/search?q=' +
                encodeURIComponent(q) + '&format=json&limit=1';
    const req = net.request({ method: 'GET', url });
    req.setHeader('User-Agent', 'NooraniBrowser/1.1 (https://nooraniBrowser.com)');
    req.setHeader('Accept', 'application/json');

    let body = '';
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    req.on('response', (res) => {
      res.on('data', (chunk) => { body += chunk.toString(); });
      res.on('end', () => {
        try {
          const arr = JSON.parse(body);
          if (!Array.isArray(arr) || !arr.length) {
            return done({ error: 'no-results' });
          }
          const lat = parseFloat(arr[0].lat);
          const lng = parseFloat(arr[0].lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return done({ error: 'bad-coords' });
          }
          done({ lat, lng, displayName: arr[0].display_name || null });
        } catch (err) {
          done({ error: 'parse-failed' });
        }
      });
    });
    req.on('error', (err) => done({ error: err.message || 'network' }));
    req.end();

    setTimeout(() => done({ error: 'timeout' }), 8000);
  });
}

// Schedules one setTimeout per prayer-time boundary for today so the UI
// can refresh at the moment a prayer ends and the next one is due.
// Re-armed whenever settings change or a day rolls over.
function schedulePrayerRefresh() {
  clearPrayerRefreshTimer();
  const snap = computePrayerSnapshot();
  if (!snap.times) {
    // No coordinates yet — retry every 5 min so geocoding, once done,
    // kicks in without an app restart.
    prayerRefreshTimer = setTimeout(schedulePrayerRefresh, 5 * 60 * 1000);
    return;
  }
  const now = Date.now();
  const upcoming = [];
  for (const t of [snap.times.fajr, snap.times.sunrise, snap.times.dhuhr,
                   snap.times.asr, snap.times.maghrib, snap.times.isha]) {
    if (t && t.getTime() > now) upcoming.push(t.getTime());
  }
  // Next-day Fajr as fallback anchor.
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowSnap = computePrayerSnapshot(tomorrow);
  if (tomorrowSnap.times) upcoming.push(tomorrowSnap.times.fajr.getTime());

  const earliest = Math.min(...upcoming);
  const delay = Math.max(1000, earliest - now + 1000);   // 1-sec cushion
  prayerRefreshTimer = setTimeout(() => {
    broadcastToAll('prayer:nextChanged', computeNextPrayer());
    // A prayer-time boundary just crossed. If that boundary was Fajr or
    // Maghrib, the Ramadan fasting-hours gate just changed — rebuild the
    // combined blocklist so the engine picks it up.
    rebuildCombinedSet();
    schedulePrayerRefresh();
  }, delay);
}

// Arms one system notification per enabled prayer for today.
function scheduleAzanNotifications() {
  clearAzanTimers();
  const s = loadSettings();
  const w = s.features.worship;
  if (!w.azanNotifications) return;

  const snap = computePrayerSnapshot();
  if (!snap.times) return;

  const now = Date.now();
  for (const name of PRAYER_NAMES) {
    if (!w.adhanEnabled[name]) continue;
    const when = snap.times[name];
    if (!when || when.getTime() <= now) continue;
    const delay = when.getTime() - now;
    const timer = setTimeout(() => fireAzanNotification(name, when), delay);
    azanTimers.push(timer);
  }
}

function fireAzanNotification(prayerName, when) {
  const label = prayer.PRAYER_LABELS[prayerName] || prayerName;
  const timeStr = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  try {
    const n = new Notification({
      title:  `${label} time`,
      body:   `It is time for ${label} prayer. ${timeStr}`,
      silent: true   // we handle audio ourselves via the renderer
    });
    n.show();
    setTimeout(() => { try { n.close(); } catch (_) {} }, 30000);
  } catch (err) {
    console.error('[noorani] notification failed:', err);
  }
  // Ask the renderer to play the user's selected adhan audio (if any).
  const s = loadSettings();
  if (s.features.worship.adhanSound) {
    broadcastToAll('azan:play', { prayerName, soundPath: s.features.worship.adhanSound });
  }
}

// Single entry point called whenever worship-relevant state changes
// (location, settings, day rollover). Re-arms all schedules and
// refreshes the Ramadan active flag + combined blocklist so the gate
// picks up changes immediately.
function onWorshipStateChanged() {
  schedulePrayerRefresh();
  scheduleAzanNotifications();
  updateRamadanActiveFlag();
  // rebuildCombinedSet may already have run inside updateRamadanActiveFlag
  // if the flag flipped; but we always run it here to pick up fasting-hour
  // transitions (Fajr→Maghrib window change) that don't flip currentlyActive.
  rebuildCombinedSet();
}

// ============================================================================
// IPC handlers
// ============================================================================

function registerIpc() {
  // Bookmarks ---------------------------------------------------------------
  ipcMain.handle('bookmarks:get', () => loadJSON('bookmarks.json', []));
  ipcMain.handle('bookmarks:has', (_e, url) => {
    const list = loadJSON('bookmarks.json', []);
    return list.some(b => b.url === url);
  });
  ipcMain.handle('bookmarks:add', (_e, entry) => {
    if (!entry || !entry.url) return loadJSON('bookmarks.json', []);
    const list = loadJSON('bookmarks.json', []);
    if (!list.some(b => b.url === entry.url)) {
      list.push({
        url:     entry.url,
        title:   entry.title   || entry.url,
        favicon: entry.favicon || null,
        addedAt: Date.now()
      });
      saveJSON('bookmarks.json', list);
      broadcastToAll('bookmarks:changed', list);
    }
    return list;
  });
  ipcMain.handle('bookmarks:remove', (_e, url) => {
    const list = loadJSON('bookmarks.json', []).filter(b => b.url !== url);
    saveJSON('bookmarks.json', list);
    broadcastToAll('bookmarks:changed', list);
    return list;
  });
  // Supports renaming the title AND changing the URL. Changing the URL
  // clears the favicon so the new origin re-fetches one on next visit.
  // Refuses the URL change if another bookmark already uses the new URL.
  ipcMain.handle('bookmarks:update', (_e, payload) => {
    if (!payload || !payload.url) return loadJSON('bookmarks.json', []);
    const list = loadJSON('bookmarks.json', []);
    const idx = list.findIndex(b => b.url === payload.url);
    if (idx < 0) return list;
    const entry = list[idx];

    if (typeof payload.title === 'string' && payload.title.trim()) {
      entry.title = payload.title.trim();
    }
    if (typeof payload.newUrl === 'string' && payload.newUrl.trim()) {
      const newUrl = payload.newUrl.trim();
      if (newUrl !== entry.url) {
        const dup = list.findIndex((b, i) => i !== idx && b.url === newUrl);
        if (dup < 0) {
          entry.url = newUrl;
          entry.favicon = null;
        }
      }
    }

    saveJSON('bookmarks.json', list);
    broadcastToAll('bookmarks:changed', list);
    return list;
  });

  // History -----------------------------------------------------------------
  ipcMain.handle('history:get', () => loadJSON('history.json', []));
  ipcMain.handle('history:add', (_e, entry) => {
    if (!entry || !entry.url) return;
    const url = entry.url;
    if (url.startsWith('noorani:')     ||
        url === 'about:blank'          ||
        url.startsWith('about:')       ||
        url.startsWith('chrome-error:')) return;
    const list = loadJSON('history.json', []);
    list.push({
      url,
      title:     entry.title   || url,
      favicon:   entry.favicon || null,
      visitedAt: entry.visitedAt || Date.now()
    });
    if (list.length > 5000) list.splice(0, list.length - 5000);
    saveJSON('history.json', list);
  });
  ipcMain.handle('history:clear', () => {
    saveJSON('history.json', []);
    broadcastToAll('history:changed', []);
    return [];
  });

  // Downloads ---------------------------------------------------------------
  ipcMain.handle('downloads:get', () => downloads.slice());
  ipcMain.handle('downloads:open-file', async (_e, id) => {
    const d = downloads.find(x => x.id === id);
    if (d && d.savedPath && d.state === 'completed') {
      return shell.openPath(d.savedPath);
    }
  });
  ipcMain.handle('downloads:open-folder', async (_e, id) => {
    const d = downloads.find(x => x.id === id);
    if (d && d.savedPath) shell.showItemInFolder(d.savedPath);
  });
  ipcMain.handle('downloads:cancel', (_e, id) => {
    const item = downloadItems.get(id);
    if (item) item.cancel();
  });

  // Settings ----------------------------------------------------------------
  ipcMain.handle('settings:get', () => {
    const s = loadSettings();
    return { ...s, _effectiveTheme: getEffectiveTheme(s) };
  });
  ipcMain.handle('settings:update', (_e, payload) => {
    if (!payload || typeof payload.key !== 'string') return null;
    const s = loadSettings();
    s[payload.key] = payload.value;
    // Any top-level write could touch features — re-normalize worship to
    // keep shapes legal (cheap, idempotent).
    if (s.features && s.features.worship) normalizeWorship(s.features.worship);
    if (s.features && s.features.contentSafety) {
      normalizeContentSafety(s.features.contentSafety);
    }
    saveSettings(s);
    broadcastSettings();
    onWorshipStateChanged();
    rebuildCombinedSet();
    rebuildAllowlistSet();
    return { ...s, _effectiveTheme: getEffectiveTheme(s) };
  });

  // Clear browsing data -----------------------------------------------------
  // Confirmation lives in the renderer (nooraniModal). This handler trusts
  // the renderer and just performs the deletion.
  ipcMain.handle('browsing-data:clear', async (_e, options) => {
    options = options || {};
    const selected = Object.keys(options).filter(k => options[k]);
    if (selected.length === 0) return { cleared: [] };

    if (options.history)   saveJSON('history.json',   []);
    if (options.bookmarks) saveJSON('bookmarks.json', []);
    if (options.downloads) { downloads.length = 0; broadcastDownloads(); }
    if (options.settings)  saveSettings({ ...SETTINGS_DEFAULTS });

    if (options.history)   broadcastToAll('history:changed',   []);
    if (options.bookmarks) broadcastToAll('bookmarks:changed', []);
    if (options.settings)  broadcastSettings();

    return { cleared: selected };
  });

  // Onboarding --------------------------------------------------------------
  // The welcome flow collects features + location in the renderer, then
  // commits everything in one shot so settings.json transitions atomically
  // from "onboarding incomplete" to "onboarding complete with these choices".
  ipcMain.handle('onboarding:complete', (_e, payload) => {
    const s = loadSettings();
    const p = (payload && typeof payload === 'object') ? payload : {};

    if (p.features && typeof p.features === 'object') {
      for (const cat of Object.keys(FEATURES_DEFAULTS)) {
        if (p.features[cat]) {
          s.features[cat] = mergeCategory(s.features[cat], p.features[cat]);
        }
      }
      // Re-validate interface fields in case the renderer sent bad values.
      if (!SUPPORTED_LANGUAGES.includes(s.features.interface.language)) {
        s.features.interface.language = FEATURES_DEFAULTS.interface.language;
      }
      if (typeof s.features.interface.rtl !== 'boolean') {
        s.features.interface.rtl = FEATURES_DEFAULTS.interface.rtl;
      }
      normalizeWorship(s.features.worship);
      normalizeContentSafety(s.features.contentSafety);
    }
    if (p.location && typeof p.location === 'object') {
      s.location = mergeCategory(s.location, p.location);
    }
    s.onboarding = { complete: true, completedAt: new Date().toISOString() };

    saveSettings(s);
    broadcastSettings();
    onWorshipStateChanged();
    rebuildCombinedSet();
    rebuildAllowlistSet();
    return { ...s, _effectiveTheme: getEffectiveTheme(s) };
  });

  ipcMain.handle('onboarding:reset', () => {
    const s = loadSettings();
    s.onboarding = { complete: false, completedAt: null };
    saveSettings(s);
    broadcastSettings();
    return { ...s, _effectiveTheme: getEffectiveTheme(s) };
  });

  // Search engines / versions / misc ---------------------------------------
  ipcMain.handle('search:engines', () => ({ ...SEARCH_ENGINES }));
  ipcMain.handle('app:versions',   () => getVersions());
  ipcMain.handle('app:data-dir',   () => dataDir());
  ipcMain.handle('home:top-sites', () => computeTopSites(6));

  // Worship / Prayer (Phase 9 Batch 1) --------------------------------------
  // All of these are safe to call even when the user's location hasn't been
  // geocoded yet — they return null/empty so the UI can show a sensible
  // "set your location" state.
  ipcMain.handle('prayer:getTimes', () => computePrayerSnapshot());
  ipcMain.handle('prayer:getNext',  () => computeNextPrayer());
  ipcMain.handle('prayer:refresh',  () => {
    schedulePrayerRefresh();
    scheduleAzanNotifications();
    broadcastToAll('prayer:nextChanged', computeNextPrayer());
    return computePrayerSnapshot();
  });
  ipcMain.handle('qibla:get', () => computeQibla());
  ipcMain.handle('hijri:get', (_e, isoDate) => computeHijri(isoDate));

  // Location management ----------------------------------------------------
  ipcMain.handle('location:update', (_e, payload) => {
    if (!payload || typeof payload !== 'object') return loadSettings().location;
    const s = loadSettings();
    const next = { ...s.location };
    if (typeof payload.city    === 'string') next.city    = payload.city.trim() || null;
    if (typeof payload.country === 'string') next.country = payload.country.trim() || null;
    if (Number.isFinite(Number(payload.lat))) next.lat = Number(payload.lat);
    else if (payload.lat === null)            next.lat = null;
    if (Number.isFinite(Number(payload.lng))) next.lng = Number(payload.lng);
    else if (payload.lng === null)            next.lng = null;
    s.location = next;
    saveSettings(s);
    broadcastSettings();
    onWorshipStateChanged();
    return s.location;
  });
  ipcMain.handle('location:geocode', async (_e, payload) => {
    const city    = payload && payload.city    ? String(payload.city).trim()    : '';
    const country = payload && payload.country ? String(payload.country).trim() : '';
    if (!city && !country) return { error: 'Need a city or country' };
    const result = await geocodeLocation(city, country);
    if (result.error) return result;
    // Persist on success.
    const s = loadSettings();
    s.location = { ...s.location, city: city || s.location.city,
                   country: country || s.location.country,
                   lat: result.lat, lng: result.lng };
    saveSettings(s);
    broadcastSettings();
    onWorshipStateChanged();
    return result;
  });

  // Worship partial update — shallow-merges a partial worship object into
  // features.worship. Single entry point from the settings page so the
  // renderer never has to reconstruct the full object.
  ipcMain.handle('worship:update', (_e, partial) => {
    if (!partial || typeof partial !== 'object') return loadSettings();
    const s = loadSettings();
    const w = s.features.worship;
    // Shallow merge but deep-merge the two known sub-objects.
    for (const [k, v] of Object.entries(partial)) {
      if (v === undefined) continue;
      if (k === 'adhanEnabled' && v && typeof v === 'object') {
        w.adhanEnabled = { ...w.adhanEnabled, ...v };
      } else if (k === 'prayerOffsets' && v && typeof v === 'object') {
        w.prayerOffsets = { ...w.prayerOffsets, ...v };
      } else {
        w[k] = v;
      }
    }
    normalizeWorship(w);
    saveSettings(s);
    broadcastSettings();
    onWorshipStateChanged();
    return { ...s, _effectiveTheme: getEffectiveTheme(s) };
  });

  // Ramadan: partial update of features.ramadan (Phase 9 Batch 3).
  // Deep-merges `categories` so a single subcategory toggle doesn't wipe
  // the others. `customDomains` is replaced wholesale; the caller is
  // responsible for add/remove semantics.
  ipcMain.handle('ramadan:update', (_e, partial) => {
    if (!partial || typeof partial !== 'object') return loadSettings();
    const s = loadSettings();
    const r = s.features.ramadan;
    for (const [k, v] of Object.entries(partial)) {
      if (v === undefined) continue;
      if (k === 'categories' && v && typeof v === 'object') {
        r.categories = { ...r.categories, ...v };
      } else {
        r[k] = v;
      }
    }
    normalizeRamadan(r);
    saveSettings(s);
    broadcastSettings();
    // Any ramadan settings change may flip whether the gate is on; rebuild.
    rebuildCombinedSet();
    return { ...s, _effectiveTheme: getEffectiveTheme(s) };
  });
  ipcMain.handle('ramadan:customAdd', (_e, raw) => {
    const s = loadSettings();
    const host = cleanAllowlistEntry(raw);  // reuse hostname cleaner
    if (!host) return { error: 'invalid', list: s.features.ramadan.customDomains };
    const list = Array.isArray(s.features.ramadan.customDomains)
      ? s.features.ramadan.customDomains.slice() : [];
    if (!list.includes(host)) list.push(host);
    list.sort();
    s.features.ramadan.customDomains = list;
    normalizeRamadan(s.features.ramadan);
    saveSettings(s);
    broadcastSettings();
    rebuildCombinedSet();
    return { host, list: s.features.ramadan.customDomains };
  });
  ipcMain.handle('ramadan:customRemove', (_e, raw) => {
    const s = loadSettings();
    const host = cleanAllowlistEntry(raw);
    const list = (Array.isArray(s.features.ramadan.customDomains)
      ? s.features.ramadan.customDomains : []).filter((h) => h !== host);
    s.features.ramadan.customDomains = list;
    saveSettings(s);
    broadcastSettings();
    rebuildCombinedSet();
    return { list };
  });
  ipcMain.handle('ramadan:preview', () => {
    const s = loadSettings();
    const domains = blocklistEngine.loadRamadanDomains(s.features.ramadan);
    return {
      count: domains.size,
      domains: [...domains].sort()
    };
  });

  // Developer settings (Phase 9 Batch 3) — testing-only affordances.
  ipcMain.handle('developer:update', (_e, partial) => {
    if (!partial || typeof partial !== 'object') return loadSettings();
    const s = loadSettings();
    s.developer = { ...s.developer, ...partial };
    normalizeDeveloper(s.developer);
    saveSettings(s);
    broadcastSettings();
    // Hijri override may flip Ramadan.currentlyActive — re-check now.
    updateRamadanActiveFlag();
    return { ...s, _effectiveTheme: getEffectiveTheme(s) };
  });

  // Adhan audio: pick a file → copy to userData/data/adhan/ → return path.
  // Intentionally limited to MP3/OGG/WAV to keep the Notification sound
  // subsystem happy across platforms.
  ipcMain.handle('adhan:pick-file', async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const res = await dialog.showOpenDialog(win, {
      title: 'Select an adhan audio file',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'ogg', 'wav', 'm4a'] }]
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const src = res.filePaths[0];
    const adhanDir = path.join(dataDir(), 'adhan');
    if (!fs.existsSync(adhanDir)) fs.mkdirSync(adhanDir, { recursive: true });
    const ext = path.extname(src) || '.mp3';
    const dst = path.join(adhanDir, 'user-adhan' + ext);
    try { fs.copyFileSync(src, dst); }
    catch (err) { return { error: err.message }; }

    const s = loadSettings();
    s.features.worship.adhanSound = dst;
    normalizeWorship(s.features.worship);
    saveSettings(s);
    broadcastSettings();
    onWorshipStateChanged();
    return { path: dst };
  });
  ipcMain.handle('adhan:clear-file', () => {
    const s = loadSettings();
    s.features.worship.adhanSound = null;
    saveSettings(s);
    broadcastSettings();
    onWorshipStateChanged();
    return { path: null };
  });
  ipcMain.handle('adhan:get-sound-url', () => {
    const s = loadSettings();
    const p = s.features.worship.adhanSound;
    if (!p || !fs.existsSync(p)) return null;
    // Served through the noorani:// protocol handler so renderer CSP is happy.
    // Cache-busting timestamp so picking a new file takes effect immediately.
    return 'noorani://adhan/file?v=' + Date.now();
  });

  // Content protection (Phase 9 Batch 2) -----------------------------------
  ipcMain.handle('blocklist:info', () => {
    const loaded = loadedBlocklists || blocklistEngine.loadBlocklists(dataDir());
    const s = loadSettings();
    return {
      perCategory:     loaded.perCategory,
      totalDomains:    loaded.totalDomains,
      activeCategories: blocklistEngine.activeCategoriesFromSettings(s),
      activeDomains:   combinedSet.size,
      stevenblack:     loaded.stevenblack,
      allowlist:       s.features.contentSafety.allowlist || []
    };
  });
  ipcMain.handle('blocklist:refresh', async () => {
    const r = await blocklistEngine.downloadStevenBlackList(dataDir());
    if (!r.error) {
      contentProtectionLoad();
      broadcastToAll('blocklist:changed', null);
    }
    return r;
  });

  ipcMain.handle('allowlist:add',    (_e, entry) => addToAllowlist(entry));
  ipcMain.handle('allowlist:remove', (_e, entry) => removeFromAllowlist(entry));
  ipcMain.handle('allowlist:temp',   (_e, host)  => {
    // Temp unblock: user clicked "Unblock this site temporarily" on the
    // blocked page. Good until app restart.
    const h = blocklistEngine.canonHost(String(host || ''));
    if (!h) return { error: 'invalid' };
    tempUnblocked.add(h);
    return { host: h };
  });

  ipcMain.handle('stats:get', () => {
    // Flush any in-flight increments first so UI reads live values.
    if (pendingBlockedIncrement > 0) flushStats();
    const s = loadSettings();
    normalizeStats(s.stats);
    return s.stats;
  });
  ipcMain.handle('stats:reset', () => {
    const s = loadSettings();
    s.stats = { ...STATS_DEFAULTS, blockedTodayResetAt: new Date().toISOString() };
    pendingBlockedIncrement = 0;
    saveSettings(s);
    broadcastToAll('stats:changed', s.stats);
    return s.stats;
  });

  // Quran (Phase 9 Batch 3) -------------------------------------------------
  ipcMain.handle('quran:getSurahList', () => quranData.getSurahList());
  ipcMain.handle('quran:getSurah', (_e, num) => quranData.getSurah(num));
  ipcMain.handle('quran:getVerse', (_e, payload) => {
    const p = payload || {};
    return quranData.getVerse(p.surah, p.verse);
  });
  ipcMain.handle('quran:getTranslation', (_e, payload) => {
    const p = payload || {};
    return quranData.getTranslation(p.lang, p.surah);
  });
  ipcMain.handle('quran:getDailyVerses', () => quranData.getDailyVerseRefs());

  // Dua bookmarks (Phase 9 Batch 3) -----------------------------------------
  // Separate storage from regular bookmarks — dua-bookmarks.json. Entries are
  // ayahs, user-authored supplications, or verse-link references from the web.
  ipcMain.handle('duas:list', () => loadJSON('dua-bookmarks.json', []));
  ipcMain.handle('duas:add', (_e, entry) => {
    const list = loadJSON('dua-bookmarks.json', []);
    const clean = normalizeDua(entry);
    if (!clean) return list;
    // Deduplicate ayah-type entries on reference to avoid double-bookmarking.
    if (clean.type === 'ayah' && clean.reference) {
      const dup = list.find((d) => d.type === 'ayah' && d.reference === clean.reference);
      if (dup) return list;
    }
    list.push(clean);
    saveJSON('dua-bookmarks.json', list);
    broadcastToAll('duas:changed', list);
    return list;
  });
  ipcMain.handle('duas:remove', (_e, id) => {
    const list = loadJSON('dua-bookmarks.json', []).filter((d) => d.id !== id);
    saveJSON('dua-bookmarks.json', list);
    broadcastToAll('duas:changed', list);
    return list;
  });
  ipcMain.handle('duas:update', (_e, payload) => {
    if (!payload || !payload.id) return loadJSON('dua-bookmarks.json', []);
    const list = loadJSON('dua-bookmarks.json', []);
    const idx = list.findIndex((d) => d.id === payload.id);
    if (idx < 0) return list;
    const changes = payload.changes || {};
    // Only allow mutating a safe subset — never re-key id/savedAt/type.
    if (typeof changes.notes === 'string') list[idx].notes = changes.notes;
    if (typeof changes.reference === 'string') list[idx].reference = changes.reference.trim();
    saveJSON('dua-bookmarks.json', list);
    broadcastToAll('duas:changed', list);
    return list;
  });

  // Zoom (Phase v1.0.1 Part D) ----------------------------------------------
  // Per-domain zoom level, keyed on hostname (with "www." stripped by the
  // renderer before it ever reaches us). 0 (= 100%, the default) is never
  // stored — an absent key and a stored 0 mean the same thing, so pruning
  // keeps the file from growing unbounded as the user visits sites at the
  // default zoom.
  ipcMain.handle('zoom:get', (_e, domain) => {
    const d = String(domain || '').trim().toLowerCase();
    if (!d) return 0;
    const zooms = loadJSON('zoom-levels.json', {});
    const level = zooms[d];
    return typeof level === 'number' && Number.isFinite(level) ? level : 0;
  });
  ipcMain.handle('zoom:set', (_e, payload) => {
    const d = String((payload && payload.domain) || '').trim().toLowerCase();
    if (!d) return { error: 'no-domain' };
    const level = Number(payload && payload.level);
    if (!Number.isFinite(level)) return { error: 'bad-level' };
    const clamped = Math.max(-3, Math.min(3, level));
    const zooms = loadJSON('zoom-levels.json', {});
    if (clamped === 0) delete zooms[d];
    else zooms[d] = clamped;
    saveJSON('zoom-levels.json', zooms);
    return { ok: true };
  });

  // Site permissions (Phase v1.0.1 Part B) -----------------------------------
  ipcMain.handle('permissions:list', () => loadJSON('site-permissions.json', {}));
  ipcMain.handle('permissions:remove', (_e, origin) => {
    const o = String(origin || '');
    const perms = loadJSON('site-permissions.json', {});
    delete perms[o];
    saveJSON('site-permissions.json', perms);
    permissionsCache = perms;
    broadcastToAll('permissions:changed', perms);
    return perms;
  });
  ipcMain.handle('permissions:clear', () => {
    saveJSON('site-permissions.json', {});
    permissionsCache = {};
    broadcastToAll('permissions:changed', {});
    return {};
  });
  ipcMain.handle('permissions:respond', (_e, payload) => {
    respondToPermissionRequest(payload || {});
  });

  // Language interest capture (Phase v1.0.1 Part H) --------------------------
  ipcMain.handle('language:interest', (_e, payload) => {
    const email = String((payload && payload.email) || '').trim();
    const language = String((payload && payload.language) || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !language) {
      return { error: 'invalid' };
    }
    const list = loadJSON('language-interest.json', []);
    list.push({ email, language, submittedAt: new Date().toISOString() });
    saveJSON('language-interest.json', list);
    return { ok: true };
  });

  // Tab detach (Phase v1.0.1 Part C) -----------------------------------------
  // The renderer has already decided (via its own dragover tracking) that
  // the user dragged a tab out of the tab strip. We just need to figure out
  // where it lands: onto another Noorani window under the cursor, or into
  // a fresh one.
  ipcMain.handle('tab:detach', (event, payload) => {
    payload = payload || {};
    const url = String(payload.url || '').trim();
    if (!url) return { error: 'no-url' };
    const sourceWin = BrowserWindow.fromWebContents(event.sender);

    if (Number.isFinite(payload.screenX) && Number.isFinite(payload.screenY)) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win === sourceWin || win.isDestroyed() || !win.isVisible()) continue;
        const b = win.getBounds();
        if (payload.screenX >= b.x && payload.screenX <= b.x + b.width &&
            payload.screenY >= b.y && payload.screenY <= b.y + b.height) {
          try { win.webContents.send('shortcut', 'open-tab-url', url); } catch (_) {}
          win.focus();
          return { droppedInto: true };
        }
      }
    }

    createSecondaryWindow({ openUrl: url });
    return { droppedInto: false };
  });

  // Private windows (Phase v1.0.1 Part E) ------------------------------------
  // "New Private Window" itself is a File-menu item and runs entirely in
  // main (click => createIncognitoWindow() directly) — this handler exists
  // for the one path that has to originate in a renderer: the webview
  // context menu's "Open Link in Private Window".
  ipcMain.handle('window:open-private-url', (_e, url) => {
    createIncognitoWindow(String(url || '').trim() || null);
    return { ok: true };
  });
  ipcMain.handle('window:force-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.__nooraniAllowClose = true;
      win.close();
    }
  });
}

// Coerce a raw dua payload into the canonical schema. Rejects if it has no
// meaningful content (no arabic, translation, reference, or notes).
function normalizeDua(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const type = ['ayah', 'dua', 'verse-link'].includes(entry.type) ? entry.type : 'dua';
  const out = {
    id:                entry.id || `dua_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    reference:         typeof entry.reference        === 'string' ? entry.reference.trim()        : '',
    text_arabic:       typeof entry.text_arabic      === 'string' ? entry.text_arabic             : '',
    text_translation:  typeof entry.text_translation === 'string' ? entry.text_translation        : '',
    translation_lang:  typeof entry.translation_lang === 'string' ? entry.translation_lang        : 'en',
    notes:             typeof entry.notes            === 'string' ? entry.notes                   : '',
    url:               typeof entry.url              === 'string' ? entry.url                     : '',
    savedAt:           Date.now()
  };
  const hasContent = out.text_arabic || out.text_translation || out.reference || out.notes || out.url;
  return hasContent ? out : null;
}

// ============================================================================
// Menu / accelerators
// ============================================================================

function sendShortcut(action, ...args) {
  // Route to whichever Noorani window is focused (v1.0.1: detached tab
  // windows and incognito windows mean mainWindow is no longer the only
  // window that can receive menu-accelerator actions), falling back to
  // mainWindow if nothing is focused (e.g. accelerator fired right as
  // focus was transitioning).
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send('shortcut', action, ...args);
  }
}

function buildMenu() {
  const tabSwitchItems = Array.from({ length: 9 }, (_, i) => ({
    label:       `Go to Tab ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click:       () => sendShortcut('switch-tab', i + 1)
  }));

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Private Window', accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createIncognitoWindow() }
      ]
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'New Tab',      accelerator: 'CmdOrCtrl+T',    click: () => sendShortcut('new-tab') },
        { label: 'Close Tab',    accelerator: 'CmdOrCtrl+W',    click: () => sendShortcut('close-tab') },
        { type: 'separator' },
        { label: 'Next Tab',     accelerator: 'Ctrl+Tab',       click: () => sendShortcut('next-tab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => sendShortcut('prev-tab') },
        { type: 'separator' },
        ...tabSwitchItems
      ]
    },
    {
      label: 'Navigation',
      submenu: [
        { label: 'Back',          accelerator: 'Alt+Left',    click: () => sendShortcut('back') },
        { label: 'Forward',       accelerator: 'Alt+Right',   click: () => sendShortcut('forward') },
        { label: 'Reload',        accelerator: 'CmdOrCtrl+R', click: () => sendShortcut('reload') },
        { label: 'Reload (F5)',   accelerator: 'F5',          click: () => sendShortcut('reload') },
        { label: 'Focus URL Bar', accelerator: 'CmdOrCtrl+L', click: () => sendShortcut('focus-url') },
        { label: 'Home',          accelerator: 'Alt+Home',    click: () => sendShortcut('home') },
        { type: 'separator' },
        { label: 'Settings',      accelerator: 'CmdOrCtrl+,', click: () => sendShortcut('open-settings') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Bookmark Bar', accelerator: 'CmdOrCtrl+Shift+B',
          click: () => sendShortcut('toggle-bookmark-bar') },
        { type: 'separator' },
        { label: 'Zoom In',    accelerator: 'CmdOrCtrl+=', click: () => sendShortcut('zoom-in') },
        { label: 'Zoom Out',   accelerator: 'CmdOrCtrl+-', click: () => sendShortcut('zoom-out') },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => sendShortcut('zoom-reset') },
        { type: 'separator' },
        { label: 'Toggle DevTools',     accelerator: 'CmdOrCtrl+Shift+I',
          role: 'toggleDevTools' }
      ]
    }
  ];

  return Menu.buildFromTemplate(template);
}

// ============================================================================
// Window state persistence
// ============================================================================

const WINDOW_STATE_FILE    = 'window-state.json';
const WINDOW_DEFAULT_WIDTH  = 1280;
const WINDOW_DEFAULT_HEIGHT = 800;
// Floor below which the chrome (tabs + toolbar + URL bar) visibly breaks.
// Matches Chrome/Brave/Edge desktop defaults; applied to every BrowserWindow.
const WINDOW_MIN_WIDTH      = 960;
const WINDOW_MIN_HEIGHT     = 600;
let   windowStateSaveTimer  = null;

// A saved position is only used if at least one connected display still
// contains (x, y) — otherwise the window could end up off-screen when a
// monitor was disconnected since last launch.
function boundsAreVisible(bounds) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number' ||
      typeof bounds.width !== 'number' || typeof bounds.height !== 'number') {
    return false;
  }
  const displays = screen.getAllDisplays();
  return displays.some((d) => {
    const a = d.workArea;
    return bounds.x < a.x + a.width &&
           bounds.x + bounds.width  > a.x &&
           bounds.y < a.y + a.height &&
           bounds.y + bounds.height > a.y;
  });
}

function loadWindowState() {
  return loadJSON(WINDOW_STATE_FILE, null);
}
function saveWindowState(state) {
  saveJSON(WINDOW_STATE_FILE, state);
}

function captureWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  // getNormalBounds() returns the non-maximized / non-fullscreen bounds, so
  // reopening after a maximize still restores the user's prior window size.
  const bounds = (typeof mainWindow.getNormalBounds === 'function')
    ? mainWindow.getNormalBounds()
    : mainWindow.getBounds();
  return {
    x:            bounds.x,
    y:            bounds.y,
    width:        bounds.width,
    height:       bounds.height,
    isMaximized:  mainWindow.isMaximized(),
    isFullScreen: mainWindow.isFullScreen()
  };
}

function scheduleWindowStateSave() {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    const state = captureWindowState();
    if (state) saveWindowState(state);
  }, 500);
}

function flushWindowStateSave() {
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = null;
  }
  const state = captureWindowState();
  if (state) saveWindowState(state);
}

// ============================================================================
// Window lifecycle
// ============================================================================

function createWindow() {
  const saved = loadWindowState();
  const useSaved = saved && boundsAreVisible(saved);

  const options = {
    width:           useSaved ? saved.width  : WINDOW_DEFAULT_WIDTH,
    height:          useSaved ? saved.height : WINDOW_DEFAULT_HEIGHT,
    minWidth:        WINDOW_MIN_WIDTH,
    minHeight:       WINDOW_MIN_HEIGHT,
    title:           'Noorani Browser',
    backgroundColor: '#faf7f2',
    autoHideMenuBar: true,
    icon:            path.join(__dirname, 'assets', 'icons', 'icon-256.png'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      webviewTag:       true
    }
  };
  if (useSaved) {
    options.x = saved.x;
    options.y = saved.y;
  }

  mainWindow = new BrowserWindow(options);

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // First launch (no saved state) OR saved state was off-screen — maximize.
  // If saved state explicitly said maximized/fullscreen, honour that.
  if (!saved || !useSaved) {
    mainWindow.maximize();
  } else {
    if (saved.isMaximized)  mainWindow.maximize();
    if (saved.isFullScreen) mainWindow.setFullScreen(true);
  }

  mainWindow.on('resize',            scheduleWindowStateSave);
  mainWindow.on('move',              scheduleWindowStateSave);
  mainWindow.on('maximize',          scheduleWindowStateSave);
  mainWindow.on('unmaximize',        scheduleWindowStateSave);
  mainWindow.on('enter-full-screen', scheduleWindowStateSave);
  mainWindow.on('leave-full-screen', scheduleWindowStateSave);
  mainWindow.on('close',             flushWindowStateSave);

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ============================================================================
// Secondary windows — detached tabs (Part C) + incognito (Part E)
// ============================================================================
// Deliberately NOT wired into the window-state persistence createWindow()
// uses for the original mainWindow: a detached-tab or incognito window's
// size/position should never overwrite the user's saved main-window layout,
// and closing one shouldn't touch window-state.json at all.
const secondaryWindows = new Set();

function createSecondaryWindow(opts) {
  opts = opts || {};
  const focused = BrowserWindow.getFocusedWindow();
  const baseBounds = (focused && !focused.isDestroyed()) ? focused.getBounds() : null;

  const options = {
    width:           WINDOW_DEFAULT_WIDTH,
    height:          WINDOW_DEFAULT_HEIGHT,
    minWidth:        WINDOW_MIN_WIDTH,
    minHeight:       WINDOW_MIN_HEIGHT,
    title:           opts.incognito ? 'Private Browsing — Noorani' : 'Noorani Browser',
    backgroundColor: opts.incognito ? '#151515' : '#faf7f2',
    autoHideMenuBar: true,
    icon:            path.join(__dirname, 'assets', 'icons', 'icon-256.png'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      webviewTag:       true
    }
  };
  // Cascade off whichever window was focused, so a new window never opens
  // in the exact same spot as the one it came from.
  if (baseBounds) {
    options.x = baseBounds.x + 32;
    options.y = baseBounds.y + 32;
  }

  const win = new BrowserWindow(options);
  win.setMenuBarVisibility(false);

  const params = new URLSearchParams();
  if (opts.openUrl) params.set('openUrl', opts.openUrl);
  if (opts.incognito) {
    params.set('incognito', '1');
    params.set('partition', opts.partition);
  }
  const query = params.toString();
  win.loadFile(path.join(__dirname, 'index.html'), query ? { search: query } : undefined);
  win.maximize();
  win.focus();

  // "Ask before closing a private window with multiple tabs" (Part E
  // setting) — intercept the close, hand it to the renderer's own tab
  // count + nooraniModal, and only actually close once it says go ahead
  // (via the window:force-close IPC handler, which sets this flag first).
  if (opts.incognito) {
    win.on('close', (e) => {
      if (win.__nooraniAllowClose) return;
      const s = loadSettings();
      if (!s.privateBrowsing || s.privateBrowsing.confirmCloseMultiTab === false) return;
      e.preventDefault();
      try { win.webContents.send('shortcut', 'confirm-close-private'); } catch (_) {}
    });
  }

  secondaryWindows.add(win);
  win.on('closed', () => secondaryWindows.delete(win));
  return win;
}

// ============================================================================
// Incognito / private windows (Phase v1.0.1 Part E)
// ============================================================================
let incognitoWindowCounter = 0;

// session.fromPartition('incognito:' + id) — WITHOUT a "persist:" prefix —
// is Electron's own ephemeral-session convention: it lives only in memory
// and is garbage-collected once nothing references it anymore (i.e. once
// the window closes), so cookies/cache/localStorage for that window simply
// cease to exist. A "persist:" prefix would have written it to disk, which
// is exactly what a private window must never do.
function createIncognitoWindow(openUrl) {
  const partitionName = 'incognito:' + Date.now() + '_' + (++incognitoWindowCounter);
  const sess = session.fromPartition(partitionName);

  normalizeUserAgent(sess);
  installPermissionHandlers(sess, { isIncognito: true });
  // Content filter (halal/riba/gambling/Ramadan) must still apply — the
  // filter's decision logic (handleRequest) reads from module-level state,
  // not session-specific state, so attaching it to this session too is
  // enough; no separate "incognito blocklist" needed.
  sess.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, handleRequest);

  return createSecondaryWindow({
    incognito: true,
    partition: partitionName,
    openUrl:   openUrl || undefined
  });
}

// ============================================================================
// User-Agent normalization (Phase v1.0.1 Part A)
// ============================================================================
// Electron's default UA embeds "Electron/x.y.z" (and would embed a
// "NooraniBrowser/x.y" token too, if one were ever added to it), which
// several sites — WhatsApp Web, Google Meet, some banking portals — sniff
// for and refuse to serve, showing an "unsupported browser" wall. Stripping
// those tokens leaves a standard Chrome UA string, which is all any of
// those sites actually check for.
function normalizeUserAgent(sess) {
  try {
    sess.setUserAgent(
      sess.getUserAgent()
        .replace(/Electron\/[\d.]+\s*/, '')
        .replace(/NooraniBrowser\/[\d.]+\s*/, '')
    );
  } catch (_) { /* swallow — session may already be gone */ }
}

// Windows taskbar grouping — must be set before the first window opens.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.noorani.browser');
}

app.whenReady().then(() => {
  ensureDataDir();
  // Verify bundled Quran data is intact (6236 verses across all three files)
  // before any renderer asks for it.
  quranData.assertIntegrity();

  // UA fix must land before any webview loads content — apply to the
  // default session immediately, and to every future webview's guest
  // WebContents (belt-and-suspenders: covers guests on sessions other than
  // defaultSession, e.g. incognito partitions, where we may forget to call
  // normalizeUserAgent() explicitly at session-creation time).
  normalizeUserAgent(session.defaultSession);
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'window') return;
    contents.on('did-attach-webview', (_e, webviewContents) => {
      try {
        webviewContents.setUserAgent(
          webviewContents.getUserAgent().replace(/Electron\/[\d.]+\s*/, '')
        );
      } catch (_) { /* swallow */ }
    });
  });

  registerNooraniProtocol();
  setupDownloads();
  registerIpc();
  // Content protection must be set up before any webview loads so the
  // first navigation is filtered. Blocklists load synchronously from
  // the bundled curated list; StevenBlack refresh is background async.
  contentProtectionLoad();
  registerWebRequestBlocker();

  permissionsCache = loadJSON('site-permissions.json', {});
  installPermissionHandlers(session.defaultSession, { isIncognito: false });
  Menu.setApplicationMenu(buildMenu());
  createWindow();

  // Background: refresh StevenBlack list if missing or stale (> 7 days).
  blocklistEngine.refreshBlocklistsIfStale(dataDir()).then((r) => {
    if (!r || r.skipped || r.error) return;
    contentProtectionLoad();
    broadcastToAll('blocklist:changed', null);
  }).catch(() => {});

  // Worship: arm schedulers as soon as the app is up. Safe even when the
  // user's location isn't geocoded yet — the scheduler retries in 5 min.
  onWorshipStateChanged();

  // Ramadan (Phase 9 Batch 3): daily Hijri re-check + boot-time notification
  // sweep. updateRamadanActiveFlag already ran inside onWorshipStateChanged;
  // the midnight timer keeps currentlyActive honest across day rollover.
  scheduleRamadanMidnightCheck();
  checkAndFireRamadanNotifications();

  // If onboarding left us with city+country but no coords, try to geocode
  // once in the background — the prayer engine then activates automatically
  // via the 5-minute retry inside schedulePrayerRefresh().
  (async () => {
    const s = loadSettings();
    const loc = s.location || {};
    const haveCoords = Number.isFinite(loc.lat) && Number.isFinite(loc.lng);
    if (!haveCoords && (loc.city || loc.country)) {
      const r = await geocodeLocation(loc.city || '', loc.country || '');
      if (!r.error) {
        const s2 = loadSettings();
        s2.location = { ...s2.location, lat: r.lat, lng: r.lng };
        saveSettings(s2);
        broadcastSettings();
        onWorshipStateChanged();
      }
    }
  })();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // "auto" theme follows the OS — re-broadcast when it flips
  nativeTheme.on('updated', () => {
    const s = loadSettings();
    if (s.theme === 'auto') broadcastSettings();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Final stats flush so the last batch of blocks isn't lost.
  if (pendingBlockedIncrement > 0) flushStats();
});
