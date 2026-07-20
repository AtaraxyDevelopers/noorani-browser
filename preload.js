// Noorani Browser — preload.js
//
// Runs in:
//   - the chrome renderer (file://.../index.html) — full API exposed
//   - any <webview> that sets preload=<this file> — API only exposed when
//     the document is on the noorani:// scheme, so random visited sites
//     never see window.nooraniAPI.

const { contextBridge, ipcRenderer } = require('electron');

const TRUSTED_PROTOCOLS = ['file:', 'noorani:'];
const isTrusted = TRUSTED_PROTOCOLS.includes(location.protocol);

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel) {
  return (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, ...args) => {
      try { callback(...args); } catch (_) { /* swallow */ }
    };
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

if (isTrusted) {
  contextBridge.exposeInMainWorld('nooraniAPI', {
    // Menu-accelerator shortcuts (chrome only uses these) -------------------
    onShortcut: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const handler = (_event, action, ...args) => {
        try { callback(action, ...args); } catch (_) {}
      };
      ipcRenderer.on('shortcut', handler);
      return () => ipcRenderer.removeListener('shortcut', handler);
    },

    bookmarks: {
      get:      ()      => invoke('bookmarks:get'),
      has:      (url)   => invoke('bookmarks:has', url),
      add:      (entry) => invoke('bookmarks:add', entry),
      remove:   (url)   => invoke('bookmarks:remove', url),
      // changes: { title?, newUrl? }  — or a plain string for legacy title-only updates.
      update:   (url, changes) => {
        const c = (typeof changes === 'string')
          ? { title: changes }
          : (changes || {});
        return invoke('bookmarks:update', { url, ...c });
      },
      onChange: subscribe('bookmarks:changed')
    },

    history: {
      get:      ()      => invoke('history:get'),
      add:      (entry) => invoke('history:add', entry),
      clear:    ()      => invoke('history:clear'),
      onChange: subscribe('history:changed')
    },

    downloads: {
      get:        ()   => invoke('downloads:get'),
      openFile:   (id) => invoke('downloads:open-file', id),
      openFolder: (id) => invoke('downloads:open-folder', id),
      cancel:     (id) => invoke('downloads:cancel', id),
      onUpdate:   subscribe('downloads:update')
    },

    settings: {
      get:      ()            => invoke('settings:get'),
      update:   (key, value)  => invoke('settings:update', { key, value }),
      onChange: subscribe('settings:changed')
    },

    prayer: {
      getTimes:  ()        => invoke('prayer:getTimes'),
      getNext:   ()        => invoke('prayer:getNext'),
      refresh:   ()        => invoke('prayer:refresh'),
      onUpdate:  subscribe('prayer:nextChanged'),
      onAzanPlay: subscribe('azan:play')
    },
    qibla: {
      get: () => invoke('qibla:get')
    },
    hijri: {
      get: (isoDate) => invoke('hijri:get', isoDate || null)
    },
    location: {
      update:  (payload) => invoke('location:update', payload),
      geocode: (payload) => invoke('location:geocode', payload)
    },
    worship: {
      update:       (partial) => invoke('worship:update', partial),
      pickAdhan:    ()        => invoke('adhan:pick-file'),
      clearAdhan:   ()        => invoke('adhan:clear-file'),
      getAdhanUrl:  ()        => invoke('adhan:get-sound-url')
    },
    ramadan: {
      update:       (partial) => invoke('ramadan:update', partial),
      customAdd:    (raw)     => invoke('ramadan:customAdd', raw),
      customRemove: (raw)     => invoke('ramadan:customRemove', raw),
      preview:      ()        => invoke('ramadan:preview')
    },
    developer: {
      update:       (partial) => invoke('developer:update', partial)
    },

    quran: {
      getSurahList:    ()        => invoke('quran:getSurahList'),
      getSurah:        (num)     => invoke('quran:getSurah', num),
      getVerse:        (s, v)    => invoke('quran:getVerse', { surah: s, verse: v }),
      getTranslation:  (lang, s) => invoke('quran:getTranslation', { lang, surah: s }),
      getDailyVerses:  ()        => invoke('quran:getDailyVerses')
    },
    duas: {
      list:     ()              => invoke('duas:list'),
      add:      (entry)         => invoke('duas:add', entry),
      remove:   (id)            => invoke('duas:remove', id),
      update:   (id, changes)   => invoke('duas:update', { id, changes }),
      onChange: subscribe('duas:changed')
    },

    blocklist: {
      info:     ()      => invoke('blocklist:info'),
      refresh:  ()      => invoke('blocklist:refresh'),
      onChange: subscribe('blocklist:changed')
    },
    allowlist: {
      add:    (entry) => invoke('allowlist:add',    entry),
      remove: (entry) => invoke('allowlist:remove', entry),
      temp:   (host)  => invoke('allowlist:temp',   host)
    },
    stats: {
      get:      ()      => invoke('stats:get'),
      reset:    ()      => invoke('stats:reset'),
      onChange: subscribe('stats:changed')
    },

    browsingData: {
      clear: (options) => invoke('browsing-data:clear', options)
    },

    zoom: {
      get: (domain)        => invoke('zoom:get', domain),
      set: (domain, level) => invoke('zoom:set', { domain, level })
    },

    permissions: {
      list:     ()         => invoke('permissions:list'),
      remove:   (origin)   => invoke('permissions:remove', origin),
      clear:    ()         => invoke('permissions:clear'),
      respond:  (payload)  => invoke('permissions:respond', payload),
      onRequest: subscribe('permission:request'),
      onChange:  subscribe('permissions:changed')
    },

    language: {
      reportInterest: (email, language) => invoke('language:interest', { email, language })
    },

    window: {
      detachTab:      (payload) => invoke('tab:detach', payload),
      openPrivateUrl: (url)     => invoke('window:open-private-url', url),
      forceClose:     ()        => invoke('window:force-close')
    },

    onboarding: {
      complete: (payload) => invoke('onboarding:complete', payload),
      reset:    ()        => invoke('onboarding:reset')
    },

    search: {
      getEngines: () => invoke('search:engines')
    },

    home: {
      getTopSites: () => invoke('home:top-sites')
    },

    app: {
      getDataDir:  () => invoke('app:data-dir'),
      getVersions: () => invoke('app:versions')
    }
  });
}
