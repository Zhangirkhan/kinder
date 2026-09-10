/* ===================================================================
   services/watchProviders.js — легальные стриминги из TMDB Watch Providers
   =================================================================== */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'providers_cache.json');
const TTL_MS = 24 * 60 * 60 * 1000;

let cache = null;
let cacheLoaded = false;

const ensureDataDir = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
};

const loadCache = () => {
  if (cacheLoaded) return cache;
  ensureDataDir();
  try {
    if (fs.existsSync(CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8') || '{}');
    } else {
      cache = {};
    }
  } catch {
    cache = {};
  }
  cacheLoaded = true;
  return cache;
};

const writeCache = () => {
  ensureDataDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache || {}, null, 2));
};

const cacheKey = (tmdbId, mediaType, region) => `${mediaType}:${tmdbId}:${region}`;

const cacheGet = (key) => {
  const c = loadCache();
  const entry = c[key];
  if (!entry?.cachedAt || (Date.now() - entry.cachedAt) > TTL_MS) return null;
  return entry.providers ?? null;
};

const cacheSet = (key, providers) => {
  const c = loadCache();
  c[key] = { cachedAt: Date.now(), providers };
  if (Object.keys(c).length > 500) {
    delete c[Object.keys(c)[0]];
  }
  writeCache();
};

const logoUrl = (logoPath) => {
  if (!logoPath) return null;
  return `https://image.tmdb.org/t/p/w92${logoPath}`;
};

const mergeProviderLists = (regionData) => {
  if (!regionData || typeof regionData !== 'object') return [];
  const types = ['flatrate', 'rent', 'buy', 'free', 'ads'];
  const seen = new Set();
  const out = [];
  for (const type of types) {
    const list = Array.isArray(regionData[type]) ? regionData[type] : [];
    for (const item of list) {
      const id = item?.provider_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(item);
    }
  }
  return out;
};

/**
 * fetchWatchProviders — загрузка провайдеров TMDB с кэшем на 24 часа.
 * @returns {Promise<Array<{provider_name:string, logo_url:string|null, link:string|null}>>}
 */
export async function fetchWatchProviders({
  tmdbId,
  mediaType = 'movie',
  region = 'RU',
  tmdbFetch
}) {
  const id = String(tmdbId || '').trim();
  if (!id || !tmdbFetch) return [];

  const reg = String(region || 'RU').toUpperCase();
  const key = cacheKey(id, mediaType, reg);
  const cached = cacheGet(key);
  if (cached) return cached;

  const endpoint = mediaType === 'tv' ? `/tv/${id}/watch/providers` : `/movie/${id}/watch/providers`;
  const json = await tmdbFetch(endpoint);
  if (!json?.results) {
    cacheSet(key, []);
    return [];
  }

  const regionData = json.results[reg] || json.results[reg.toLowerCase()] || null;
  const deepLink = regionData?.link || null;
  const rawProviders = mergeProviderLists(regionData);

  const providers = rawProviders.map((p) => ({
    provider_name: p.provider_name || 'Провайдер',
    logo_url: logoUrl(p.logo_path),
    link: deepLink
  }));

  cacheSet(key, providers);
  return providers;
}
