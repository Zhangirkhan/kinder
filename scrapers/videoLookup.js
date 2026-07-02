/* ===================================================================
   scrapers/videoLookup.js — умный поиск iframe-плеера
   YouTube (Data API v3) → Rutube → VK → Dailymotion → HDRezka (резерв)
   С AI-валидацией кандидатов и приоритетом источников по отзывам.
   =================================================================== */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveHdrezkaMovie } from '../hdrezka.js';
import { validateVideoCandidate } from '../services/aiValidator.js';
import { getSourcePriorityOrder, getSourceRating } from '../services/videoFeedback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'video_cache.json');

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней
const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000; // сутки
const HEAD_TIMEOUT_MS = Number(process.env.VIDEO_LOOKUP_HEAD_TIMEOUT_MS) || 5000;

const YOUTUBE_API_KEY = (process.env.YOUTUBE_API_KEY || '').trim();

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
};

const SOURCE_LOOKUPS = {
  youtube: youtubeLookupCandidates,
  rutube: rutubeLookupCandidates,
  vk: vkLookupCandidates,
  dailymotion: dailymotionLookupCandidates,
  hdrezka: hdrezkaLookupCandidates
};

let cache = null;
let cacheLoaded = false;
let writing = false;
let cacheWriteQueued = false;

let maintenanceStarted = false;
const inFlight = new Map();

const ensureDataDirs = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CACHE_FILE)) fs.writeFileSync(CACHE_FILE, '{}');
};

const loadCache = () => {
  if (cacheLoaded) return cache;
  ensureDataDirs();
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    cache = JSON.parse(raw || '{}');
  } catch {
    cache = {};
  }
  cacheLoaded = true;
  return cache;
};

const writeCacheToDisk = () => {
  if (writing) {
    cacheWriteQueued = true;
    return;
  }
  writing = true;
  try {
    ensureDataDirs();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache || {}, null, 2));
  } finally {
    writing = false;
    if (cacheWriteQueued) {
      cacheWriteQueued = false;
      writeCacheToDisk();
    }
  }
};

const cacheGet = (tmdbId) => {
  const c = loadCache();
  const entry = c[String(tmdbId)] || null;
  if (!entry) return null;
  if (!entry.cachedAt || (Date.now() - entry.cachedAt) > TTL_MS) return null;
  if (entry.result) return entry.result;
  if (entry.error) return { error: entry.error };
  return null;
};

const cacheSetResult = (tmdbId, result) => {
  const c = loadCache();
  c[String(tmdbId)] = { cachedAt: Date.now(), result };
  writeCacheToDisk();
};

const cacheSetError = (tmdbId, error) => {
  const c = loadCache();
  c[String(tmdbId)] = { cachedAt: Date.now(), error };
  writeCacheToDisk();
};

const stripTitleExclusions = (title) => {
  const t = String(title || '');
  return t && !/(^|\W)(трейлер|обзор|реакция)(\W|$)/iu.test(t);
};

const parseIso8601DurationToSeconds = (iso) => {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  const total = h * 3600 + min * 60 + s;
  return Number.isFinite(total) && total > 0 ? total : null;
};

const parseDurationSeconds = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 100000) return Math.round(n / 1000);
  if (n > 10000) return Math.round(n);
  return Math.round(n);
};

const durationMatches = (durationSec, runtimeMinutes, type) => {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return false;
  if (!Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) return true;

  const runtimeSec = runtimeMinutes * 60;
  if (type === 'tv') {
    const tolSec = 5 * 60;
    return durationSec >= runtimeSec - tolSec && durationSec <= runtimeSec + tolSec;
  }

  const tol = runtimeSec * 0.1;
  return durationSec >= runtimeSec - tol && durationSec <= runtimeSec + tol;
};

const enrichResult = (candidate) => {
  const rating = getSourceRating(candidate.source);
  return {
    ...candidate,
    sourceRating: rating.percent,
    sourceScore: rating.score
  };
};

const pickValidatedCandidate = async (candidates, { type, req, username }) => {
  if (!candidates?.length) return null;
  for (const candidate of candidates) {
    const valid = await validateVideoCandidate({
      title: candidate.title,
      durationSec: candidate.duration,
      channelName: candidate.channelName || candidate.source,
      mediaType: type,
      req,
      username
    });
    if (valid) return enrichResult(candidate);
  }
  return null;
};

async function youtubeLookupCandidates({ title, year, runtimeMinutes, type }) {
  if (!YOUTUBE_API_KEY) return [];

  const query = `${title} ${year} фильм`.trim();
  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.searchParams.set('part', 'snippet');
  searchUrl.searchParams.set('type', 'video');
  searchUrl.searchParams.set('maxResults', '5');
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('key', YOUTUBE_API_KEY);
  searchUrl.searchParams.set('videoDuration', 'long');

  const searchRes = await fetch(searchUrl.toString());
  if (!searchRes.ok) return [];
  const searchJson = await searchRes.json().catch(() => null);
  const items = Array.isArray(searchJson?.items) ? searchJson.items : [];
  if (!items.length) return [];

  const candidates = items
    .filter((it) => it?.id?.videoId && stripTitleExclusions(it?.snippet?.title))
    .slice(0, 5);
  if (!candidates.length) return [];

  const ids = [...new Set(candidates.map((c) => c.id.videoId))].slice(0, 10);
  const videosUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  videosUrl.searchParams.set('part', 'contentDetails,statistics,snippet');
  videosUrl.searchParams.set('id', ids.join(','));
  videosUrl.searchParams.set('key', YOUTUBE_API_KEY);

  const videosRes = await fetch(videosUrl.toString());
  if (!videosRes.ok) return [];
  const videosJson = await videosRes.json().catch(() => null);
  const videos = Array.isArray(videosJson?.items) ? videosJson.items : [];
  if (!videos.length) return [];

  const normalized = videos.map((v) => {
    const durationSec = parseIso8601DurationToSeconds(v?.contentDetails?.duration);
    const views = Number(v?.statistics?.viewCount || 0);
    const hasCaptions = v?.contentDetails?.caption === 'true';
    return {
      source: 'youtube',
      embedUrl: `https://www.youtube.com/embed/${v.id}`,
      title: v?.snippet?.title || title,
      duration: durationSec,
      views,
      channelName: v?.snippet?.channelTitle || '',
      hasCaptions,
      audioLang: hasCaptions ? 'multi' : null
    };
  }).filter((x) => x.duration && durationMatches(x.duration, runtimeMinutes, type));

  normalized.sort((a, b) => (b.views || 0) - (a.views || 0));
  return normalized;
}

async function rutubeLookupCandidates({ title, year, runtimeMinutes, type }) {
  const query = `${title} ${year}`.trim();
  const url = new URL('https://rutube.ru/api/video/');
  url.searchParams.set('query', query);

  const res = await fetch(url.toString(), { headers: { ...DEFAULT_HEADERS, Referer: 'https://rutube.ru/' } });
  if (!res.ok) return [];
  const json = await res.json().catch(() => null);
  const items = Array.isArray(json?.items)
    ? json.items
    : (Array.isArray(json?.videos) ? json.videos : (Array.isArray(json?.data?.items) ? json.data.items : []));

  const candidates = items.map((it) => {
    const durationSec = parseDurationSeconds(it?.duration || it?.duration_sec || it?.durationSeconds);
    const embedUrl = it?.embed_url || it?.embedUrl || it?.player_url || it?.playerUrl || null;
    const name = it?.title || it?.name || title;
    const views = Number(it?.views || it?.stats?.views || it?.totalViews || 0);
    const channelName = it?.author?.name || it?.channel?.title || it?.author_name || 'Rutube';
    return { source: 'rutube', embedUrl, title: name, duration: durationSec, views, channelName };
  }).filter((c) => c.embedUrl && c.duration && stripTitleExclusions(c.title) && durationMatches(c.duration, runtimeMinutes, type));

  candidates.sort((a, b) => (b.views || 0) - (a.views || 0));
  return candidates;
}

const parseVkDurationSecondsFromText = (text) => {
  const s = String(text || '');
  const time = s.match(/(\d{1,2}):(\d{2})/);
  if (time) {
    const mm = Number(time[1]);
    const ss = Number(time[2]);
    const total = mm * 60 + ss;
    return Number.isFinite(total) && total > 0 ? total : null;
  }
  const sec = s.match(/data-duration=["']?(\d+)/i)?.[1] || s.match(/duration["']?\s*[:=]\s*(\d+)/i)?.[1];
  if (sec) return parseDurationSeconds(sec);
  const m = s.match(/(\d+)\s*мин/i);
  if (m) return Math.round(Number(m[1]) * 60);
  return null;
};

async function vkLookupCandidates({ title, year, runtimeMinutes, type }) {
  const query = `${title} ${year}`.trim();
  const url = `https://vk.com/video?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { ...DEFAULT_HEADERS, Referer: 'https://vk.com/' } });
  if (!res.ok) return [];
  const html = await res.text();

  const matches = [...html.matchAll(/video_ext\.php\?oid=(\d+)&id=(\d+)&hash=([^"&]+)/g)];
  if (!matches.length) return [];

  const candidates = matches.map((m) => {
    const oid = m[1];
    const id = m[2];
    const hash = m[3];
    const embedUrl = `https://vk.com/video_ext.php?oid=${encodeURIComponent(oid)}&id=${encodeURIComponent(id)}&hash=${encodeURIComponent(hash)}`;
    const idx = m.index ?? 0;
    const snippet = html.slice(Math.max(0, idx - 420), Math.min(html.length, idx + 420));
    const durationSec = parseVkDurationSecondsFromText(snippet);
    return { source: 'vk', embedUrl, title, duration: durationSec, channelName: 'VK' };
  }).filter((c) => c.embedUrl && c.duration && durationMatches(c.duration, runtimeMinutes, type));

  if (!candidates.length) return [];

  if (Number.isFinite(runtimeMinutes) && runtimeMinutes > 0) {
    const target = runtimeMinutes * 60;
    candidates.sort((a, b) => Math.abs(a.duration - target) - Math.abs(b.duration - target));
  }
  return candidates;
}

async function dailymotionLookupCandidates({ title, year, runtimeMinutes, type }) {
  const query = `${title} ${year}`.trim();
  const url = new URL('https://api.dailymotion.com/videos');
  url.searchParams.set('search', query);
  url.searchParams.set('limit', '5');

  const res = await fetch(url.toString(), { headers: { ...DEFAULT_HEADERS } });
  if (!res.ok) return [];
  const json = await res.json().catch(() => null);

  const items = Array.isArray(json?.list)
    ? json.list
    : (Array.isArray(json?.videos) ? json.videos : []);
  if (!items.length) return [];

  const candidates = items.map((it) => {
    const durationSec = parseDurationSeconds(it?.duration);
    const embedUrl = it?.embed_url || it?.embedUrl || null;
    const name = it?.title || it?.name || title;
    return { source: 'dailymotion', embedUrl, title: name, duration: durationSec, channelName: 'Dailymotion' };
  }).filter((c) => c.embedUrl && c.duration && stripTitleExclusions(c.title) && durationMatches(c.duration, runtimeMinutes, type));

  if (!candidates.length) return [];

  if (Number.isFinite(runtimeMinutes) && runtimeMinutes > 0) {
    const target = runtimeMinutes * 60;
    candidates.sort((a, b) => Math.abs(a.duration - target) - Math.abs(b.duration - target));
  }
  return candidates;
}

async function hdrezkaLookupCandidates({ title, year, runtimeMinutes, type }) {
  const resolved = await resolveHdrezkaMovie({
    title: title || '',
    year: year || null,
    matchedTitle: title || '',
    originalTitle: null
  }).catch(() => null);

  if (!resolved?.hdrezkaUrl) return [];
  return [{
    source: 'hdrezka',
    embedUrl: resolved.hdrezkaUrl || resolved.url,
    title: resolved.title || title,
    duration: Number.isFinite(runtimeMinutes) && runtimeMinutes > 0 ? runtimeMinutes * 60 : null,
    channelName: 'HDRezka',
    type
  }];
}

const refreshCacheValidity = async () => {
  const c = loadCache();
  const keys = Object.keys(c || {});
  if (!keys.length) return;

  let changed = false;
  for (const key of keys) {
    const entry = c[key];
    const embedUrl = entry?.result?.embedUrl || null;
    if (!embedUrl || typeof embedUrl !== 'string') continue;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
      const res = await fetch(embedUrl, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 404 || res.status === 410 || res.status >= 500 || (res.status >= 400 && res.status !== 401 && res.status !== 403)) {
        delete c[key];
        changed = true;
      }
    } catch {
      delete c[key];
      changed = true;
    }
  }

  if (changed) writeCacheToDisk();
};

const startMaintenance = () => {
  if (maintenanceStarted) return;
  maintenanceStarted = true;
  setInterval(() => {
    refreshCacheValidity().catch(() => null);
  }, DAILY_REFRESH_MS).unref();
};

startMaintenance();

/**
 * lookupVideo — основной метод.
 * @returns {Promise<{source:string, embedUrl:string, title:string, duration:number|null} | {error:'not found'}>}
 */
export const lookupVideo = async ({ tmdbId, type = 'movie', title = '', year = null, runtimeMinutes = null, req = null, username = null }) => {
  const idKey = String(tmdbId);
  if (!idKey || idKey === 'null') return { error: 'not found' };

  const cached = cacheGet(idKey);
  if (cached) return cached;

  if (inFlight.has(idKey)) return inFlight.get(idKey);

  const task = (async () => {
    try {
      const runtime = Number(runtimeMinutes);
      const yearNum = year != null ? Number(year) : null;
      const safeTitle = String(title || '').trim();
      const safeYear = yearNum && Number.isFinite(yearNum) ? yearNum : (yearNum === 0 ? 0 : '');

      const lookupArgs = { title: safeTitle, year: safeYear, runtimeMinutes: runtime, type };
      const sourceOrder = getSourcePriorityOrder();

      for (const sourceName of sourceOrder) {
        const lookupFn = SOURCE_LOOKUPS[sourceName];
        if (!lookupFn) continue;
        if (sourceName !== 'hdrezka' && (!safeTitle || safeYear === '')) continue;
        if (sourceName === 'hdrezka' && !safeTitle) continue;

        const candidates = await lookupFn(lookupArgs).catch(() => []);
        const picked = await pickValidatedCandidate(candidates, { type, req, username });
        if (picked?.embedUrl) {
          cacheSetResult(idKey, picked);
          return picked;
        }
      }

      cacheSetError(idKey, 'not found');
      return { error: 'not found' };
    } finally {
      inFlight.delete(idKey);
    }
  })();

  inFlight.set(idKey, task);
  return task;
};
