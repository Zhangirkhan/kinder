/* ===================================================================
   viewingHistory.js — история просмотра (прогресс, сессии, статусы).
   Гости: localStorage. Авторизованные: /api/viewing-history.
   При входе merge() переносит гостевую историю в аккаунт.
   =================================================================== */
(function () {
  'use strict';

  const GUEST_KEY = 'mf_viewing_history_v1';
  let cache = null;
  let saveTimer = null;
  let dirty = false;
  let initPromise = null;

  function defaultStore() {
    return { entries: {} };
  }

  function entryKey(tmdbId, mediaType) {
    return `${mediaType === 'tv' ? 'tv' : 'movie'}:${Number(tmdbId)}`;
  }

  function isLoggedIn() {
    return typeof window.isLoggedIn === 'function' && window.isLoggedIn();
  }

  function readGuest() {
    try {
      const raw = localStorage.getItem(GUEST_KEY);
      if (!raw) return defaultStore();
      const parsed = JSON.parse(raw);
      return { entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {} };
    } catch {
      return defaultStore();
    }
  }

  function writeGuest(store) {
    try {
      localStorage.setItem(GUEST_KEY, JSON.stringify(store));
    } catch { /* quota */ }
  }

  function getStore() {
    if (!cache) cache = readGuest();
    return cache;
  }

  async function loadFromServer() {
    const headers = window.authHeaders?.() || {};
    const res = await fetch('/api/viewing-history', { headers, cache: 'no-store' });
    if (!res.ok) return defaultStore();
    const data = await res.json();
    return { entries: data.entries && typeof data.entries === 'object' ? data.entries : {} };
  }

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      if (isLoggedIn()) {
        cache = await loadFromServer();
      } else {
        cache = readGuest();
      }
      return cache;
    })();
    return initPromise;
  }

  async function reload() {
    initPromise = null;
    cache = null;
    return init();
  }

  function computePercent(position, duration) {
    if (!duration || duration <= 0) return 0;
    return Math.min(100, Math.round((position / duration) * 100));
  }

  function deriveViewingStatus(position, duration, ended) {
    if (ended) return 'watched';
    const pct = computePercent(position, duration);
    if (pct >= 92) return 'watched';
    if (position > 45) return 'incomplete';
    if (position > 0) return 'watching';
    return 'watching';
  }

  function upsertSession(sessions, session) {
    const list = Array.isArray(sessions) ? [...sessions] : [];
    const last = list[list.length - 1];
    const sameEpisode = last
      && last.season === session.season
      && last.episode === session.episode;
    const withinWindow = last
      && Math.abs(new Date(session.at) - new Date(last.at)) < 2 * 60 * 60 * 1000;

    if (last && sameEpisode && withinWindow) {
      list[list.length - 1] = session;
      return list;
    }
    list.push(session);
    return list.slice(-50);
  }

  function upsertEntry(payload) {
    if (!payload?.tmdbId) return null;

    const store = getStore();
    const mediaType = payload.mediaType === 'tv' ? 'tv' : 'movie';
    const key = entryKey(payload.tmdbId, mediaType);
    const existing = store.entries[key] || null;
    const now = new Date().toISOString();

    const position = Math.max(0, Number(payload.position) || 0);
    const duration = Math.max(0, Number(payload.duration) || 0);
    const viewingStatus = deriveViewingStatus(position, duration, Boolean(payload.ended));
    const progress = {
      positionSeconds: Math.round(position),
      durationSeconds: Math.round(duration),
      percent: computePercent(position, duration)
    };

    const session = {
      at: now,
      viewingStatus,
      progress,
      season: payload.season ?? null,
      episode: payload.episode ?? null
    };

    let sessions = upsertSession(existing?.sessions, session);

    if (
      existing?.viewingStatus === 'watched'
      && viewingStatus !== 'watched'
      && position < 120
    ) {
      sessions = [...(existing.sessions || []), session].slice(-50);
    }

    const entry = {
      key,
      tmdbId: Number(payload.tmdbId),
      mediaType,
      title: payload.title || existing?.title || '',
      year: payload.year ?? existing?.year ?? null,
      poster: payload.poster || existing?.poster || null,
      genres: payload.genres?.length ? payload.genres : (existing?.genres || []),
      originalLanguage: payload.originalLanguage ?? existing?.originalLanguage ?? null,
      viewingStatus,
      watchedAt: viewingStatus === 'watched'
        ? now
        : (existing?.watchedAt || now),
      lastActionAt: now,
      progress,
      season: payload.season ?? existing?.season ?? null,
      episode: payload.episode ?? existing?.episode ?? null,
      sessions
    };

    store.entries[key] = entry;
    cache = store;
    scheduleSave();
    window.dispatchEvent(new CustomEvent('viewing-history:change'));
    return entry;
  }

  function scheduleSave() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { flushSave(); }, 1200);
  }

  async function flushSave() {
    if (!dirty || !cache) return;
    dirty = false;
    if (isLoggedIn()) {
      try {
        await fetch('/api/viewing-history', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...(window.authHeaders?.() || {}) },
          body: JSON.stringify({ entries: cache.entries })
        });
      } catch { /* offline */ }
      return;
    }
    writeGuest(cache);
  }

  function getEntry(tmdbId, mediaType) {
    return getStore().entries[entryKey(tmdbId, mediaType)] || null;
  }

  function getResumePosition(tmdbId, mediaType, season, episode) {
    const entry = getEntry(tmdbId, mediaType);
    if (!entry?.progress?.positionSeconds) return 0;
    if (mediaType === 'tv') {
      if (entry.season === season && entry.episode === episode) {
        const pct = entry.progress.percent || 0;
        if (pct >= 92) return 0;
        return entry.progress.positionSeconds;
      }
      return 0;
    }
    const pct = entry.progress.percent || 0;
    if (pct >= 92) return 0;
    return entry.progress.positionSeconds;
  }

  function getContinueWatching(limit = 12) {
    return Object.values(getStore().entries)
      .filter((e) => e.viewingStatus === 'incomplete' || e.viewingStatus === 'watching')
      .filter((e) => {
        const pct = e.progress?.percent || 0;
        return pct > 2 && pct < 92;
      })
      .sort((a, b) => new Date(b.lastActionAt) - new Date(a.lastActionAt))
      .slice(0, limit);
  }

  function getAllHistory() {
    const movies = window.MovieApp?.getMovies?.() || [];
    return Object.values(getStore().entries)
      .map((entry) => {
        const listMovie = movies.find((m) =>
          m.tmdbId === entry.tmdbId && (m.mediaType || 'movie') === entry.mediaType
        );
        return {
          ...entry,
          rating: listMovie?.rating ?? null,
          listStatus: listMovie?.status || null
        };
      })
      .sort((a, b) => new Date(b.lastActionAt) - new Date(a.lastActionAt));
  }

  function getContentType(entry) {
    if (!entry) return 'movie';
    if (window.MediaCategories?.isAnimeContent?.(entry)) return 'anime';
    if (window.MediaCategories?.isAnimatedContent?.(entry)) return 'animation';
    return entry.mediaType === 'tv' ? 'tv' : 'movie';
  }

  function contentTypeLabel(type) {
    const map = {
      movie: window.t ? window.t('viewing.typeMovie') : 'Фильм',
      tv: window.t ? window.t('viewing.typeSeries') : 'Сериал',
      animation: window.t ? window.t('viewing.typeAnimation') : 'Мультфильм',
      anime: window.t ? window.t('viewing.typeAnime') : 'Аниме'
    };
    return map[type] || map.movie;
  }

  function viewingStatusLabel(status) {
    const map = {
      watched: window.t ? window.t('viewing.statusWatched') : 'Просмотрено',
      watching: window.t ? window.t('viewing.statusWatching') : 'Смотрит',
      incomplete: window.t ? window.t('viewing.statusIncomplete') : 'Недосмотрено'
    };
    return map[status] || status || '—';
  }

  function mergeEntry(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    const newer = new Date(incoming.lastActionAt || 0) >= new Date(existing.lastActionAt || 0)
      ? incoming
      : existing;
    const older = newer === incoming ? existing : incoming;
    const sessions = [...(older.sessions || []), ...(newer.sessions || [])]
      .sort((a, b) => new Date(a.at) - new Date(b.at));
    const deduped = [];
    for (const s of sessions) {
      const prev = deduped[deduped.length - 1];
      if (
        prev
        && prev.season === s.season
        && prev.episode === s.episode
        && Math.abs(new Date(s.at) - new Date(prev.at)) < 2 * 60 * 60 * 1000
      ) {
        deduped[deduped.length - 1] = s;
      } else {
        deduped.push(s);
      }
    }
    return {
      ...older,
      ...newer,
      title: newer.title || older.title,
      poster: newer.poster || older.poster,
      genres: newer.genres?.length ? newer.genres : (older.genres || []),
      sessions: deduped.slice(-50)
    };
  }

  async function merge() {
    const guest = readGuest();
    const guestKeys = Object.keys(guest.entries || {});
    if (!guestKeys.length) {
      try { localStorage.removeItem(GUEST_KEY); } catch { /* ignore */ }
      return;
    }
    if (!isLoggedIn()) return;

    try {
      const server = await loadFromServer();
      const merged = { ...server.entries };
      for (const key of guestKeys) {
        merged[key] = mergeEntry(merged[key], guest.entries[key]);
      }
      const res = await fetch('/api/viewing-history', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(window.authHeaders?.() || {}) },
        body: JSON.stringify({ entries: merged })
      });
      if (res.ok) {
        cache = { entries: merged };
        try { localStorage.removeItem(GUEST_KEY); } catch { /* ignore */ }
      }
    } catch { /* keep guest data */ }
  }

  function hasGuestData() {
    return Object.keys(readGuest().entries || {}).length > 0;
  }

  window.ViewingHistory = {
    init,
    reload,
    upsertEntry,
    getEntry,
    getResumePosition,
    getContinueWatching,
    getAllHistory,
    getContentType,
    contentTypeLabel,
    viewingStatusLabel,
    merge,
    flushSave,
    hasGuestData,
    entryKey
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init().catch(() => {}); });
  } else {
    init().catch(() => {});
  }
})();
