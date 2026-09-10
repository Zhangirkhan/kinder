/* ===================================================================
   scrapers/torrentSearch.js — поиск раздач и проксирование .torrent-файлов.

   Основной источник — Rutor (https://rutor.info): открытый, без регистрации.
   Опционально поддержан Rutracker (если в .env заданы RUTRACKER_BASE и
   RUTRACKER_COOKIE), но по умолчанию используется Rutor.

   Экспортируем:
     • searchTorrents(query, type)   → массив { title, size, seeds, leechs, magnet, torrentUrl, source }
     • downloadTorrentFile(url)      → { buffer, contentType, filename }

   Результаты поиска кэшируются в памяти (Map, TTL 15 минут), чтобы не дёргать
   источник на каждый запрос и не словить бан по IP. Любая ошибка → [].
   =================================================================== */

import { titleSimilarity } from '../tmdbMatch.js';
import parseTorrent from 'parse-torrent';

const RUTOR_BASE = (process.env.RUTOR_BASE || 'https://rutor.info').replace(/\/$/, '');
const RUTRACKER_COOKIE = (process.env.RUTRACKER_COOKIE || '').trim();
const RUTRACKER_BASE = (process.env.RUTRACKER_BASE || (RUTRACKER_COOKIE ? 'https://rutracker.org' : '')).replace(/\/$/, '');

const TORRENT_TIMEOUT_MS = Number(process.env.TORRENT_TIMEOUT_MS) || 6000;
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000; // 15 минут
const MAX_RESULTS = 40;

// Спуфинг заголовков «как обычный браузер» — снижает риск блокировок.
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
};

const TORRENT_PROBE_LIMIT = Number(process.env.TORRENT_PROBE_LIMIT) || 12;
const TORRENT_PROBE_CONCURRENCY = Number(process.env.TORRENT_PROBE_CONCURRENCY) || 4;
const PROBE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STREAMABLE_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v']);
const VIDEO_FILE_RE = /\.(mkv|mp4|webm|mov|avi|wmv|m4v)$/i;

// ── Кэш поиска в памяти ──
const searchCache = new Map(); // key → { at, data }
const probeCache = new Map(); // torrentUrl → { at, data }

function cacheGet(key) {
  const entry = searchCache.get(key);
  if (entry && Date.now() - entry.at < SEARCH_CACHE_TTL_MS) return entry.data;
  return undefined;
}

function cacheSet(key, data) {
  searchCache.set(key, { at: Date.now(), data });
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '));
}

function absolutize(base, url) {
  if (!url) return null;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http')) return url;
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

async function fetchHtml(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TORRENT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { ...DEFAULT_HEADERS, ...headers }
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Парсинг одной строки таблицы результатов Rutor ──
function parseRutorRow(row) {
  const magnet = decodeEntities(row.match(/href=["'](magnet:\?[^"']+)["']/i)?.[1] || '') || null;

  // Прямая ссылка на .torrent: //d.rutor.info/download/<id> либо /download/<id>.
  const rawDownload = row.match(/href=["']([^"']*\/download\/[^"']+)["']/i)?.[1] || null;
  const torrentUrl = rawDownload ? absolutize(RUTOR_BASE, rawDownload) : null;

  if (!magnet && !torrentUrl) return null;

  // Название — ссылка на страницу раздачи /torrent/<id>/<slug>.
  const titleRaw = row.match(/href=["']\/torrent\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i)?.[1];
  const title = decodeEntities(titleRaw ? titleRaw.replace(/<[^>]+>/g, '') : '');
  if (!title) return null;

  // Размер — ячейка с GB/MB/TB.
  const sizeMatch = row.match(/>\s*([\d.,]+)\s*(?:&nbsp;|\s)*\s*(TB|GB|MB|KB|ТБ|ГБ|МБ|КБ)\s*</i);
  const size = sizeMatch ? `${sizeMatch[1].replace(',', '.')} ${sizeMatch[2]}` : null;

  // Сиды (зелёный) и личи (красный).
  const seeds = Number((row.match(/class=["']green["'][^>]*>\D*(\d+)/i)?.[1]) || 0);
  const leechs = Number((row.match(/class=["']red["'][^>]*>\D*(\d+)/i)?.[1]) || 0);

  return { title, size, seeds, leechs, magnet, torrentUrl, source: 'rutor' };
}

// Разбор технической части названия раздачи Rutor.
export function parseTorrentMeta(title) {
  const raw = String(title || '').trim();
  let cleanTitle = raw;
  let year = null;
  let quality = null;
  let format = null;
  let audio = null;
  let subtitles = null;
  let audioLang = null;
  let dub = false;

  const yearMatch = raw.match(/\((\d{4})\)/);
  if (yearMatch) year = yearMatch[1];

  const qualityMatch = raw.match(/\b(2160p|1080p|720p|480p|360p|4K)\b/i);
  if (qualityMatch) quality = qualityMatch[1].toUpperCase().replace('4K', '2160p');

  const formatMatch = raw.match(/\b(WEB-DL|WEBRip|BDRip|HDRip|HDTV|BluRay|BDRemux|REMUX|WEB-DLRip|DVDRip)\b/i);
  if (formatMatch) format = formatMatch[1].toUpperCase();

  const audioPatterns = [
    /\b(Многоголосый(?:\s+закадровый)?|Дубляж|Любительский|Оригинал(?:\s*\(\+субтитры\))?|NewStudio|LostFilm|AlexFilm|Gears Media|Jaskier|HDRezka Studio|Синема УС|BaibaKo|Anilibria|AniDUB|AniFilm)\b/gi,
    /\b(MVO|DVO|VO|DUB)\b/gi,
    /\|\s*D\b/gi
  ];
  const audioHits = new Set();
  for (const re of audioPatterns) {
    let m;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(raw)) !== null) {
      const val = (m[1] || 'Дубляж').trim();
      if (val !== 'D') audioHits.add(val);
    }
  }
  if (audioHits.size) audio = [...audioHits].join(', ');

  if (/\b(субтитр|subtitle|sub|субтитры)\b/i.test(raw) || /\+субтитры/i.test(raw)) {
    subtitles = true;
  }

  const hasRu = /(русский|русская|дубляж|многоголосый|озвучка\s*ru|\bmvo\b|\bdvo\b)/i.test(raw);
  const hasEn = /(english|английский|original|оригинал)/i.test(raw);
  dub = /(дубляж|\bdub\b|\bdvo\b)/i.test(raw);
  if (hasRu && hasEn) audioLang = 'multi';
  else if (hasRu) audioLang = 'ru';
  else if (hasEn) audioLang = 'en';

  const techIdx = raw.search(/\b(WEB-DL|WEBRip|BDRip|HDRip|1080p|720p|2160p|480p)\b/i);
  if (techIdx > 10) {
    cleanTitle = raw.slice(0, techIdx).replace(/\(\d{4}\)\s*$/, '').trim();
  }
  cleanTitle = cleanTitle.replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ').trim();
  if (!cleanTitle) cleanTitle = raw;

  return { raw, cleanTitle, year, quality, format, audio, subtitles, audioLang, dub };
}

function extractLanguage(title) {
  const raw = String(title || '');
  if (/(русский|русская|дубляж|многоголосый|озвучка\s*ru|\bmvo\b|\bdvo\b|\|\s*d\s*\|)/i.test(raw)) return 'Русский';
  if (/(english|английский|original|оригинал|\|\s*o\s*\|)/i.test(raw)) return 'English';
  if (/(казах|қазақ|kazakh)/i.test(raw)) return 'Қазақша';
  if (/(украин|україн)/i.test(raw)) return 'Українська';
  return '—';
}

function formatFromFileName(name) {
  const m = String(name || '').match(VIDEO_FILE_RE);
  return m ? m[1].toLowerCase() : null;
}

function pickFormatFromTorrentFiles(files) {
  const vids = (files || [])
    .map((f) => ({ name: f.path || f.name || '', length: f.length || 0 }))
    .filter((f) => VIDEO_FILE_RE.test(f.name));
  if (!vids.length) return null;
  vids.sort((a, b) => {
    const aMp4 = /\.mp4$/i.test(a.name) ? 1 : 0;
    const bMp4 = /\.mp4$/i.test(b.name) ? 1 : 0;
    if (aMp4 !== bMp4) return bMp4 - aMp4;
    return b.length - a.length;
  });
  const ext = formatFromFileName(vids[0].name);
  if (!ext) return null;
  return {
    videoFormat: ext,
    streamable: STREAMABLE_EXTS.has(ext)
  };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Читает .torrent и определяет реальный контейнер видео (mp4/mkv/…). */
export async function probeTorrentItem(item) {
  if (!item?.torrentUrl) return item;
  const cached = probeCache.get(item.torrentUrl);
  if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) {
    return { ...item, ...cached.data };
  }
  try {
    const { buffer } = await downloadTorrentFile(item.torrentUrl);
    const meta = await parseTorrent(buffer);
    const picked = pickFormatFromTorrentFiles(meta.files);
    if (!picked) return item;
    const data = { videoFormat: picked.videoFormat, streamable: picked.streamable, probed: true };
    probeCache.set(item.torrentUrl, { at: Date.now(), data });
    if (probeCache.size > 500) probeCache.delete(probeCache.keys().next().value);
    return { ...item, ...data };
  } catch {
    return item;
  }
}

/** Уточняет формат у топовых раздач по содержимому .torrent-файла. */
export async function enrichTorrentsWithProbe(items, opts = {}) {
  if (!Array.isArray(items) || !items.length) return items;
  const limit = opts.limit ?? TORRENT_PROBE_LIMIT;
  const concurrency = opts.concurrency ?? TORRENT_PROBE_CONCURRENCY;
  const slice = items.slice(0, limit);
  const probed = await mapPool(slice, concurrency, (item) => probeTorrentItem(item));
  const byKey = new Map();
  slice.forEach((item, i) => {
    byKey.set(item.torrentUrl || item.title, probed[i]);
  });
  return items.map((item) => byKey.get(item.torrentUrl || item.title) || item);
}

const NON_STREAMABLE_RE = /(?:\.|\b)(mkv|avi|wmv|flv|vob|ts)\b/i;
const STREAMABLE_RE = /(?:\.|\b)(mp4|webm|mov|m4v)\b/i;
const VIDEO_FORMAT_RE = /(?:\.|\b)(mkv|mp4|webm|mov|avi|wmv|m4v)\b/i;

/** Онлайн-стриминг только если в названии явно указан mp4/webm/mov/m4v. */
export function isTorrentStreamable(title) {
  return STREAMABLE_RE.test(String(title || ''));
}

/** Контейнер из названия; если не указан — считаем MKV (типично для Rutor). */
export function extractVideoFormat(title) {
  const raw = String(title || '');
  const m = raw.match(VIDEO_FORMAT_RE);
  if (m) return m[1].toLowerCase();
  return 'mkv';
}

function enrichTorrent(item) {
  const meta = parseTorrentMeta(item.title);
  const streamable = isTorrentStreamable(item.title);
  const videoFormat = extractVideoFormat(item.title);
  return {
    ...item,
    meta,
    language: extractLanguage(item.title),
    streamable,
    videoFormat
  };
}

function parseRutorResults(html) {
  if (!html) return [];
  const results = [];
  // Строки результатов Rutor имеют классы gai/tum.
  const rows = html.match(/<tr class=["'](?:gai|tum)["'][\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const parsed = parseRutorRow(row);
    if (parsed) results.push(enrichTorrent(parsed));
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

async function searchRutor(query) {
  // Rutor использует path-based поиск: /search/{page}/{category}/{type}/{sort}/{query}.
  // Вариант с ?q=… отдаёт пустую страницу, поэтому строго путь.
  const url = `${RUTOR_BASE}/search/0/0/000/0/${encodeURIComponent(query)}`;
  const html = await fetchHtml(url, { Referer: `${RUTOR_BASE}/` });
  return parseRutorResults(html);
}

// ── Rutracker (опционально, по кукам) ──
function parseRutrackerResults(html) {
  if (!html) return [];
  const results = [];
  const rows = html.match(/<tr[^>]*class=["'][^"']*tCenter[^"']*["'][\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const topicId = row.match(/dl\.php\?t=(\d+)/i)?.[1]
      || row.match(/viewtopic\.php\?t=(\d+)/i)?.[1];
    const titleRaw = row.match(/class=["']tt-text["'][^>]*>([\s\S]*?)<\/a>/i)?.[1]
      || row.match(/class=["']torTopic[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1];
    const title = decodeEntities(titleRaw ? titleRaw.replace(/<[^>]+>/g, '') : '');
    if (!topicId || !title) continue;

    const sizeMatch = stripTags(row).match(/([\d.,]+)\s*(TB|GB|MB|KB|ТБ|ГБ|МБ|КБ)/i);
    const seeds = Number(row.match(/class=["'][^"']*seedmed[^"']*["'][^>]*>\D*(\d+)/i)?.[1] || 0);
    const leechs = Number(row.match(/class=["']leechmed["'][^>]*>\D*(\d+)/i)?.[1] || 0);

    results.push(enrichTorrent({
      title,
      size: sizeMatch ? `${sizeMatch[1].replace(',', '.')} ${sizeMatch[2]}` : null,
      seeds,
      leechs,
      magnet: null,
      torrentUrl: `${RUTRACKER_BASE}/forum/dl.php?t=${topicId}`,
      source: 'rutracker'
    }));
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

async function searchRutracker(query) {
  if (!RUTRACKER_BASE || !RUTRACKER_COOKIE) return [];
  const url = `${RUTRACKER_BASE}/forum/tracker.php?nm=${encodeURIComponent(query)}`;
  const html = await fetchHtml(url, {
    Referer: `${RUTRACKER_BASE}/forum/index.php`,
    Cookie: RUTRACKER_COOKIE
  });
  return parseRutrackerResults(html);
}

const torrentTitleTexts = (item) => {
  const meta = item?.meta || {};
  return [item?.title, meta.cleanTitle, meta.raw].filter(Boolean);
};

const parseSizeGb = (sizeLabel) => {
  const m = String(sizeLabel || '').match(/([\d.,]+)\s*(TB|GB|MB|ТБ|ГБ|МБ)/i);
  if (!m) return 0;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return 0;
  const unit = m[2].toUpperCase();
  if (unit.startsWith('T') || unit === 'ТБ') return n * 1024;
  if (unit.startsWith('G') || unit === 'ГБ') return n;
  if (unit.startsWith('M') || unit === 'МБ') return n / 1024;
  return 0;
};

const scoreTorrentMatch = (item, { title, originalTitle, year }) => {
  const names = [title, originalTitle].filter(Boolean);
  const texts = torrentTitleTexts(item);
  if (!names.length || !texts.length) return { sim: 0, score: item?.seeds || 0 };

  let sim = 0;
  for (const name of names) {
    for (const text of texts) {
      sim = Math.max(sim, titleSimilarity(name, text));
    }
  }

  let score = sim * 1_000_000;
  const yearNum = year != null && year !== '' ? Number(year) : null;
  const itemYear = item?.meta?.year ? Number(item.meta.year) : null;
  if (yearNum && itemYear === yearNum) score += 250_000;
  else if (yearNum && itemYear && Math.abs(itemYear - yearNum) <= 1) score += 80_000;
  else if (yearNum && itemYear && Math.abs(itemYear - yearNum) > 1) score -= 400_000;

  score += Math.min((item.seeds || 0) * 1200, 120_000);

  const sizeGb = parseSizeGb(item?.size);
  const raw = String(item?.title || '');
  if (/web-?dl|webrip|hdrrip|hdtv/i.test(raw) && sizeGb > 0 && sizeGb <= 4.5) score += 180_000;
  if (/hdrrip.*exkino|exkinoray/i.test(raw) && sizeGb > 0 && sizeGb <= 2.5) score += 260_000;
  if (/\.mp4|\bmp4\b/i.test(raw)) score += 90_000;
  if (/remux|bdremux|2160p|4k/i.test(raw)) score -= 220_000;
  if (/\.mkv|\bmkv\b/i.test(raw)) score -= 50_000;
  if (/\.mkv|\bmkv\b/i.test(raw) && sizeGb > 8) score -= 180_000;

  return { sim, score };
};

/**
 * filterAndRankTorrents — отсекает раздачи, не относящиеся к фильму,
 * и ранжирует оставшиеся по совпадению названия/года и числу сидов.
 */
export function filterAndRankTorrents(results, context = {}) {
  if (!Array.isArray(results) || !results.length) return [];

  const { title, originalTitle, year } = context;
  if (!title && !originalTitle) {
    return [...results].sort((a, b) => (b.seeds || 0) - (a.seeds || 0));
  }

  const scored = results.map((item) => {
    const { sim, score } = scoreTorrentMatch(item, context);
    return { item, sim, score };
  }).filter(({ sim, item }) => {
    if (sim >= 0.55) return true;
    const yearNum = year != null && year !== '' ? Number(year) : null;
    const itemYear = item?.meta?.year ? Number(item.meta.year) : null;
    if (yearNum && itemYear === yearNum && sim >= 0.42) return true;
    return false;
  });

  if (!scored.length) {
    return [...results]
      .map((item) => ({ item, ...scoreTorrentMatch(item, context) }))
      .filter(({ sim }) => sim >= 0.35)
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ item }) => item);
}

/**
 * searchTorrents — поиск раздач по Rutor и (если настроен) Rutracker параллельно.
 * Результаты объединяются, фильтруются по контексту фильма и кэшируются.
 */
export async function searchTorrents(query, type = 'movie', context = {}) {
  const cleaned = String(query || '').trim();
  if (!cleaned) return [];

  const cacheKey = `${type}:${cleaned.toLowerCase()}`;
  const cached = cacheGet(cacheKey);

  let results = cached;
  if (!results) {
    try {
      const rutrackerEnabled = Boolean(RUTRACKER_BASE && RUTRACKER_COOKIE);
      const [rutorResults, rutrackerResults] = await Promise.all([
        searchRutor(cleaned),
        rutrackerEnabled ? searchRutracker(cleaned) : Promise.resolve([])
      ]);
      results = [...rutorResults, ...rutrackerResults];
      results.sort((a, b) => (b.seeds || 0) - (a.seeds || 0));
      if (results.length) cacheSet(cacheKey, results);
    } catch {
      results = [];
    }
  }

  return enrichTorrentsWithProbe(
    filterAndRankTorrents(results || [], { ...context, type })
  );
}

function filenameFromContentDisposition(header) {
  if (!header) return null;
  const star = header.match(/filename\*=(?:UTF-8'')?["']?([^"';]+)/i)?.[1];
  if (star) {
    try { return decodeURIComponent(star); } catch { return star; }
  }
  return header.match(/filename=["']?([^"';]+)/i)?.[1] || null;
}

function filenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').filter(Boolean).pop() || 'download';
    return /\.torrent$/i.test(last) ? last : `${last}.torrent`;
  } catch {
    return 'download.torrent';
  }
}

/**
 * downloadTorrentFile — проксированное скачивание .torrent от имени сервера
 * (обход CORS и проверки Referer). Возвращает буфер и метаданные файла.
 * Разрешаем только http(s)-ссылки, чтобы эндпоинт нельзя было использовать
 * как универсальный прокси к внутренним ресурсам.
 */
export async function downloadTorrentFile(torrentUrl) {
  if (!torrentUrl || !/^https?:\/\//i.test(torrentUrl)) {
    throw new Error('Некорректная ссылка на торрент');
  }

  const isRutracker = RUTRACKER_BASE && torrentUrl.startsWith(RUTRACKER_BASE);
  const headers = {
    Referer: isRutracker ? `${RUTRACKER_BASE}/` : `${RUTOR_BASE}/`
  };
  if (isRutracker && RUTRACKER_COOKIE) headers.Cookie = RUTRACKER_COOKIE;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TORRENT_TIMEOUT_MS);
  try {
    const response = await fetch(torrentUrl, {
      headers: { ...DEFAULT_HEADERS, ...headers },
      redirect: 'follow'
    });
    if (!response.ok) throw new Error(`Источник ответил ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const filename = filenameFromContentDisposition(response.headers.get('content-disposition'))
      || filenameFromUrl(torrentUrl);

    return {
      buffer,
      contentType: 'application/x-bittorrent',
      filename: /\.torrent$/i.test(filename) ? filename : `${filename}.torrent`
    };
  } finally {
    clearTimeout(timer);
  }
}
