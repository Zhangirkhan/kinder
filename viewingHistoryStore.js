import fs from 'fs';
import path from 'path';

function defaultStore() {
  return { entries: {} };
}

export function getViewingHistoryPath(dataDir, username) {
  const dir = path.join(dataDir, 'viewing');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${username}.json`);
}

export function loadViewingHistory(dataDir, username) {
  const filePath = getViewingHistoryPath(dataDir, username);
  if (!fs.existsSync(filePath)) return defaultStore();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { entries: raw.entries && typeof raw.entries === 'object' ? raw.entries : {} };
  } catch {
    return defaultStore();
  }
}

export function saveViewingHistory(dataDir, username, store) {
  const filePath = getViewingHistoryPath(dataDir, username);
  const safe = { entries: store?.entries && typeof store.entries === 'object' ? store.entries : {} };
  fs.writeFileSync(filePath, JSON.stringify(safe, null, 2));
}

function mergeSessions(a = [], b = []) {
  const combined = [...a, ...b].sort((x, y) => new Date(x.at) - new Date(y.at));
  const out = [];
  for (const session of combined) {
    const prev = out[out.length - 1];
    if (
      prev
      && prev.season === session.season
      && prev.episode === session.episode
      && Math.abs(new Date(session.at) - new Date(prev.at)) < 2 * 60 * 60 * 1000
    ) {
      out[out.length - 1] = session;
    } else {
      out.push(session);
    }
  }
  return out.slice(-50);
}

export function mergeViewingEntry(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const newer = new Date(incoming.lastActionAt || 0) >= new Date(existing.lastActionAt || 0)
    ? incoming
    : existing;
  const older = newer === incoming ? existing : incoming;

  return {
    ...older,
    ...newer,
    title: newer.title || older.title,
    year: newer.year ?? older.year ?? null,
    poster: newer.poster || older.poster || null,
    genres: (newer.genres?.length ? newer.genres : older.genres) || [],
    originalLanguage: newer.originalLanguage ?? older.originalLanguage ?? null,
    progress: newer.progress || older.progress || null,
    season: newer.season ?? older.season ?? null,
    episode: newer.episode ?? older.episode ?? null,
    watchedAt: newer.watchedAt || older.watchedAt || null,
    sessions: mergeSessions(older.sessions, newer.sessions)
  };
}

export function mergeViewingStores(serverStore, guestStore) {
  const merged = { ...(serverStore?.entries || {}) };
  const guestEntries = guestStore?.entries || {};
  for (const [key, guestEntry] of Object.entries(guestEntries)) {
    merged[key] = mergeViewingEntry(merged[key], guestEntry);
  }
  return { entries: merged };
}

export function normalizeViewingEntry(raw) {
  if (!raw || raw.tmdbId == null) return null;
  const mediaType = raw.mediaType === 'tv' ? 'tv' : 'movie';
  const key = raw.key || `${mediaType}:${raw.tmdbId}`;
  const sessions = Array.isArray(raw.sessions) ? raw.sessions.slice(-50) : [];
  const viewingStatus = ['watched', 'watching', 'incomplete'].includes(raw.viewingStatus)
    ? raw.viewingStatus
    : 'incomplete';

  return {
    key,
    tmdbId: Number(raw.tmdbId),
    mediaType,
    title: String(raw.title || '').trim(),
    year: raw.year ?? null,
    poster: raw.poster || null,
    genres: Array.isArray(raw.genres) ? raw.genres : [],
    originalLanguage: raw.originalLanguage ?? null,
    viewingStatus,
    watchedAt: raw.watchedAt || null,
    lastActionAt: raw.lastActionAt || raw.watchedAt || new Date().toISOString(),
    progress: raw.progress || null,
    season: raw.season ?? null,
    episode: raw.episode ?? null,
    sessions
  };
}
