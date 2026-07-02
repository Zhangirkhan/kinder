/* ===================================================================
   rezkaMirrors.js — автоматический выбор рабочего зеркала HDRezka
   =================================================================== */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'rezka_mirror.json');

const STATIC_MIRRORS = [
  'hdrezka.name',
  'hdrezka.ag',
  'hdrezka.cm',
  'hdrezka.by',
  'hdrezka.co',
  'hdrezka.loan'
];

const MIRROR_TTL_MS = 4 * 60 * 60 * 1000;
const HEALTH_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 3000;
const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let remoteMirrors = [];
let lastRemoteFetchAt = 0;
let lastHealthCheckAt = 0;
let memoryCache = null;
let resolveInFlight = null;
let maintenanceStarted = false;

const normalizeHost = (host) => String(host || '')
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/.*$/, '')
  .toLowerCase();

const toBaseUrl = (host) => {
  const h = normalizeHost(host);
  return h ? `https://${h}` : null;
};

const parseEnvMirrors = () => String(process.env.HDREZKA_MIRRORS || '')
  .split(',')
  .map(normalizeHost)
  .filter(Boolean);

const preferredEnvBase = () => {
  const raw = String(process.env.HDREZKA_BASE || '').trim();
  return raw ? raw.replace(/\/$/, '') : null;
};

const ensureDataDir = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
};

const readDiskCache = () => {
  ensureDataDir();
  if (!fs.existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
};

const writeDiskCache = (mirror) => {
  ensureDataDir();
  const payload = {
    mirror,
    cachedAt: Date.now(),
    remoteMirrors: [...remoteMirrors]
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2));
  memoryCache = payload;
};

export const getMirrorHosts = () => {
  const hosts = new Set();
  const preferred = preferredEnvBase();
  if (preferred) hosts.add(normalizeHost(preferred));

  for (const host of STATIC_MIRRORS) hosts.add(normalizeHost(host));
  for (const host of parseEnvMirrors()) hosts.add(host);
  for (const host of remoteMirrors) hosts.add(normalizeHost(host));

  const ordered = [...hosts].filter(Boolean);
  if (preferred) {
    const prefHost = normalizeHost(preferred);
    return [prefHost, ...ordered.filter((h) => h !== prefHost)];
  }
  return ordered;
};

export const rewriteMirrorUrl = (url, activeBase) => {
  if (!url || !activeBase) return url;
  try {
    const target = new URL(activeBase);
    const parsed = new URL(url);
    const hosts = getMirrorHosts();
    const isMirrorHost = hosts.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
    if (!isMirrorHost) return url;
    parsed.protocol = target.protocol;
    parsed.hostname = target.hostname;
    return parsed.toString();
  } catch {
    return url;
  }
};

const probeMirror = async (base, method = 'GET') => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/`, {
      method,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow'
    });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const scanMirrors = async () => {
  const hosts = getMirrorHosts();
  const bases = hosts.map(toBaseUrl).filter(Boolean);
  if (!bases.length) {
    throw new Error('HDRezka: список зеркал пуст');
  }

  const probes = bases.map(async (base) => {
    const ok = await probeMirror(base, 'GET');
    if (!ok) throw new Error(`unavailable: ${base}`);
    return base;
  });

  try {
    const mirror = await Promise.any(probes);
    console.log(`[hdrezka] active mirror: ${mirror}`);
    writeDiskCache(mirror);
    lastHealthCheckAt = Date.now();
    return mirror;
  } catch (err) {
    if (err instanceof AggregateError) {
      throw new Error('HDRezka: ни одно зеркало не доступно');
    }
    throw err;
  }
};

const isCacheFresh = (cachedAt) => Number.isFinite(cachedAt) && (Date.now() - cachedAt) < MIRROR_TTL_MS;

const loadCachedMirror = () => {
  if (memoryCache?.mirror && isCacheFresh(memoryCache.cachedAt)) {
    return memoryCache;
  }
  const disk = readDiskCache();
  if (disk?.mirror && isCacheFresh(disk.cachedAt)) {
    memoryCache = disk;
    if (Array.isArray(disk.remoteMirrors)) {
      remoteMirrors = disk.remoteMirrors.map(normalizeHost).filter(Boolean);
    }
    return disk;
  }
  return null;
};

const verifyCachedMirror = async (mirror) => {
  const ok = await probeMirror(mirror, 'HEAD');
  lastHealthCheckAt = Date.now();
  return ok;
};

export const invalidateMirror = async () => {
  memoryCache = null;
  lastHealthCheckAt = 0;
  ensureDataDir();
  try {
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
  } catch { /* ignore */ }
};

export const getActiveMirror = async ({ forceRefresh = false } = {}) => {
  if (!forceRefresh) {
    const cached = loadCachedMirror();
    if (cached?.mirror) {
      const healthDue = (Date.now() - lastHealthCheckAt) >= HEALTH_CHECK_INTERVAL_MS;
      if (!healthDue) {
        return cached.mirror;
      }
      const alive = await verifyCachedMirror(cached.mirror);
      if (alive) {
        return cached.mirror;
      }
      await invalidateMirror();
    }
  } else {
    await invalidateMirror();
  }

  if (resolveInFlight) return resolveInFlight;

  resolveInFlight = scanMirrors().finally(() => {
    resolveInFlight = null;
  });

  return resolveInFlight;
};

const parseRemoteMirrorsPayload = (json) => {
  if (Array.isArray(json)) {
    return json.map(normalizeHost).filter(Boolean);
  }
  if (Array.isArray(json?.mirrors)) {
    return json.mirrors.map(normalizeHost).filter(Boolean);
  }
  if (Array.isArray(json?.domains)) {
    return json.domains.map(normalizeHost).filter(Boolean);
  }
  return [];
};

export const refreshRemoteMirrors = async () => {
  const url = String(process.env.HDREZKA_MIRRORS_URL || '').trim();
  if (!url) return remoteMirrors;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
    });
    if (!res.ok) return remoteMirrors;

    const json = await res.json().catch(() => null);
    const parsed = parseRemoteMirrorsPayload(json);
    if (parsed.length) {
      remoteMirrors = [...new Set(parsed)];
      lastRemoteFetchAt = Date.now();
      console.log(`[hdrezka] remote mirrors loaded: ${remoteMirrors.join(', ')}`);
      const cached = loadCachedMirror();
      if (cached?.mirror) {
        writeDiskCache(cached.mirror);
      }
    }
  } catch (err) {
    console.warn('[hdrezka] remote mirrors fetch failed:', err?.message || err);
  } finally {
    clearTimeout(timer);
  }

  return remoteMirrors;
};

export const startMirrorMaintenance = () => {
  if (maintenanceStarted) return;
  maintenanceStarted = true;

  refreshRemoteMirrors().catch(() => null);

  setInterval(() => {
    refreshRemoteMirrors().catch(() => null);
  }, DAILY_REFRESH_MS).unref();
};

startMirrorMaintenance();
