/* ===================================================================
   scrapers/videoLookup.js — умный поиск iframe-плеера
   YouTube (Data API v3) → Rutube → VK → Dailymotion → HDRezka (резерв)
   С AI-валидацией кандидатов и приоритетом источников по отзывам.
   =================================================================== */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateVideoCandidate } from '../services/aiValidator.js';
import { getSourcePriorityOrder, getSourceRating, getBlockedVideoUrls } from '../services/videoFeedback.js';
import { titleSimilarity } from '../tmdbMatch.js';
import { buildTmdbSearchQueries } from '../titleAliases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'video_cache.json');

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней
const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000; // сутки
const HEAD_TIMEOUT_MS = Number(process.env.VIDEO_LOOKUP_HEAD_TIMEOUT_MS) || 5000;
const LOOKUP_TIMEOUT_MS = Number(process.env.VIDEO_LOOKUP_TIMEOUT_MS) || 40000;

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
  dailymotion: dailymotionLookupCandidates
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
  return null;
};

const cacheSetResult = (tmdbId, result) => {
  const c = loadCache();
  c[String(tmdbId)] = { cachedAt: Date.now(), result };
  writeCacheToDisk();
};

const cacheSetError = () => {
  // Не кэшируем «not found» — иначе временный сбой блокирует фильм на недели.
};

const buildSearchQueries = ({ title, originalTitle, year }) => {
  const y = year ? String(year) : '';
  const out = [];
  const add = (value) => {
    const q = String(value || '').trim();
    if (!q) return;
    if (!out.includes(q)) out.push(q);
  };
  if (originalTitle && y) add(`${originalTitle} ${y}`);
  if (title && y) add(`${title} ${y}`);
  if (originalTitle) add(originalTitle);
  if (title) add(title);
  if (title) add(`${title} фильм`);
  if (originalTitle) add(`${originalTitle} full movie`);
  for (const base of [originalTitle, title].filter(Boolean)) {
    for (const variant of buildTmdbSearchQueries(base)) {
      if (y) add(`${variant} ${y}`);
      add(variant);
      add(`${variant} фильм`);
    }
  }
  return out.slice(0, 10);
};

const NON_FILM_TITLE_RE = /(^|\W)(трейлер|тизер|обзор|review|реакци|reaction|commentary|комментар|facts|разбор|analysis|анализ|explained|then\s+vs\s+now|акт[её]р|cast|soundtrack|саундтрек|main\s*theme|theme|тема|музык|music\s*video|\bost\b|саунд|score|смысл|скрыт|объяснен|целостн|documentary|документал|club\s+scene|scene|сцен[аы]|отрывок|clip|клип|фрагмент|нарезка|ремикс|mashup|караоке|karaoke|пародия|смешн|прикол|fan\s*edit|фан[\s-]?видео|asmr|косплей|ambient|soundscape|концерт|подкаст|аудиокниг|игрофильм|прохождени|walkthrough|gameplay|let'?s\s*play|видеоигр|игровой|enter\s+the|animatrix|гараев|гаряев|исцелен|регенерац|квантов|косино|легион|жуков|javascript|runaway|simulator|гулag|гулага|боевик|новинка|pretoria|hades|озвучк\s*jaskier|voice\s*over|дубляж\s*трек)(\W|$)/iu;

const stripTitleExclusions = (title) => {
  const t = String(title || '');
  return t && !NON_FILM_TITLE_RE.test(t);
};

const normalizeForMatch = (text) => String(text || '')
  .toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const SEQUEL_WORDS_RE = /\b(reloaded|revolutions?|resurrections?|reborn|awakening|awakens?|returns?|возвращени|пробужден|перезагрузк|революци|воскрешен|наследие|heritage|animatrix|воскрешени)\b/iu;

// Сиквел/другая часть франшизы: «Матрица 3», «Часть 2» — но не «Шоушенка 2» (ошибка нумерации на Rutube).
const isWrongInstallment = (candidateTitle, expectedTitles) => {
  const hay = normalizeForMatch(candidateTitle);
  if (!hay) return false;

  if (SEQUEL_WORDS_RE.test(hay)) {
    for (const expected of expectedTitles) {
      const needle = normalizeForMatch(expected);
      if (needle && needle.length >= 3 && hay.includes(needle) && !SEQUEL_WORDS_RE.test(needle)) {
        return true;
      }
    }
  }

  for (const expected of expectedTitles) {
    const needle = normalizeForMatch(expected);
    if (!needle || needle.length < 3 || !hay.includes(needle)) continue;

    const afterBase = hay.slice(hay.indexOf(needle) + needle.length).trim();
    if (!afterBase) continue;

    // «… 2» в конце — типичная ошибка Rutube, допускаем.
    if (/^\d$/.test(afterBase) && afterBase === '2') continue;

    // Номер части 3+ или «3.» сразу после названия.
    if (/^[\s.:,-]*([3-9]|\d{2,})\b/.test(afterBase)) return true;
    if (/\b(?:часть|part|сезон|season|эпизод|episode)\s*([2-9]|\d{2,})\b/iu.test(afterBase)) return true;
  }

  return false;
};

const isObviouslyWrongVideo = (candidateTitle, { title, originalTitle } = {}) => {
  if (!stripTitleExclusions(candidateTitle)) return true;
  const names = [title, originalTitle].filter(Boolean);
  if (names.length && isWrongInstallment(candidateTitle, names)) return true;
  return false;
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

const durationMatches = (durationSec, runtimeMinutes, type, { strongTitleMatch = false } = {}) => {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return false;
  const minMovieSec = type === 'tv' ? 15 * 60 : 50 * 60;
  if (!Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) {
    return durationSec >= minMovieSec;
  }

  const runtimeSec = runtimeMinutes * 60;
  if (type === 'tv') {
    const tolSec = 8 * 60;
    return durationSec >= runtimeSec - tolSec && durationSec <= runtimeSec + tolSec;
  }

  // Rutube/VK часто отдают неточную длительность — при сильном совпадении названия
  // допускаем шире (от 65% хронометража до +20%).
  const tol = strongTitleMatch ? runtimeSec * 0.35 : runtimeSec * 0.15;
  const minSec = strongTitleMatch ? Math.max(minMovieSec, runtimeSec * 0.65) : runtimeSec - tol;
  const maxSec = runtimeSec + tol;
  return durationSec >= minSec && durationSec <= maxSec;
};

const isEmbeddableUrl = (source, url) => {
  if (!url || typeof url !== 'string') return false;
  if (source === 'youtube') return /youtube\.com\/embed\//i.test(url);
  if (source === 'rutube') return /rutube\.ru\/play\/embed\//i.test(url);
  if (source === 'vk') return /vk\.com\/video_ext\.php/i.test(url);
  if (source === 'dailymotion') return /dailymotion\.com\/embed\//i.test(url);
  return false;
};

const enrichResult = (candidate) => {
  const rating = getSourceRating(candidate.source);
  return {
    ...candidate,
    sourceRating: rating.percent,
    sourceScore: rating.score
  };
};

export const invalidateVideoCache = (tmdbId) => {
  const c = loadCache();
  delete c[String(tmdbId)];
  writeCacheToDisk();
};

async function youtubeLookupCandidates({ title, originalTitle, year, runtimeMinutes, type }) {
  if (!YOUTUBE_API_KEY) return [];

  const queries = buildSearchQueries({ title, originalTitle, year });
  if (!queries.length) return [];

  // Пробуем до двух вариантов запроса (оригинальное и локализованное название с годом).
  const items = [];
  const seenIds = new Set();
  const suffix = type === 'tv' ? '' : ' фильм';
  for (const q of queries.slice(0, 2)) {
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('part', 'snippet');
    searchUrl.searchParams.set('type', 'video');
    searchUrl.searchParams.set('maxResults', '5');
    searchUrl.searchParams.set('q', `${q}${suffix}`.trim());
    searchUrl.searchParams.set('key', YOUTUBE_API_KEY);
    searchUrl.searchParams.set('videoDuration', 'long');

    const searchRes = await fetch(searchUrl.toString());
    if (!searchRes.ok) continue;
    const searchJson = await searchRes.json().catch(() => null);
    const batch = Array.isArray(searchJson?.items) ? searchJson.items : [];
    for (const it of batch) {
      const vid = it?.id?.videoId;
      if (!vid || seenIds.has(vid)) continue;
      seenIds.add(vid);
      items.push(it);
    }
  }
  if (!items.length) return [];

  const candidates = items
    .filter((it) => it?.id?.videoId && stripTitleExclusions(it?.snippet?.title))
    .slice(0, 10);
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
      title: v?.snippet?.title || '',
      duration: durationSec,
      views,
      channelName: v?.snippet?.channelTitle || '',
      hasCaptions,
      audioLang: hasCaptions ? 'multi' : null
    };
  }).filter((x) => x.title && x.duration && passesDuration(x, runtimeMinutes, type, { title, originalTitle, year }));

  normalized.sort((a, b) => scoreCandidate(b, { year, runtimeMinutes, title, originalTitle })
    - scoreCandidate(a, { year, runtimeMinutes, title, originalTitle }));
  return normalized.filter((c) => isRelevantCandidate(c, { title, originalTitle, year, runtimeMinutes }));
}

const titleYearMatches = (title, year) => {
  if (!year) return false;
  return new RegExp(`\\b${String(year)}\\b`).test(String(title || ''));
};

const extractYearFromTitle = (title) => {
  const m = String(title || '').match(/\((\d{4})\)|\b(19\d{2}|20\d{2})\b/);
  return m ? Number(m[1] || m[2]) : null;
};

const hasSequelMismatch = (candidateTitle, expectedTitles) =>
  isWrongInstallment(candidateTitle, expectedTitles);

const SPINOFF_PREFIX = /\b(enter\s+the|animatrix|видеоигр|игрофильм)\b/iu;

const isSpinoffTitle = (candidateTitle, expectedTitles) => {
  const hay = normalizeForMatch(candidateTitle);
  if (!SPINOFF_PREFIX.test(hay)) return false;
  return expectedTitles.some((n) => normalizeForMatch(n).includes('matrix'));
};

const yearMismatch = (candidateTitle, expectedYear) => {
  if (!expectedYear) return false;
  const candidateYear = extractYearFromTitle(candidateTitle);
  if (!candidateYear) return false;
  return Math.abs(candidateYear - expectedYear) > 1;
};

const titleKeywords = (title, originalTitle) => {
  const words = new Set();
  for (const src of [title, originalTitle]) {
    String(src || '').toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4)
      .forEach((w) => words.add(w));
  }
  return [...words];
};

const titleRelevanceScore = (candidateTitle, { title, originalTitle }) => {
  const hay = String(candidateTitle || '').toLowerCase();
  const keywords = titleKeywords(title, originalTitle);
  if (!keywords.length) return 0;
  let hits = 0;
  for (const kw of keywords) {
    if (hay.includes(kw)) hits += 1;
  }
  return hits / keywords.length;
};

// Название кандидата содержит ожидаемое название как целую фразу
// (по границам слов), а не как подстроку внутри другого слова.
const containsTitlePhrase = (candidateTitle, expectedTitle) => {
  const hay = ` ${normalizeForMatch(candidateTitle)} `;
  const needle = normalizeForMatch(expectedTitle);
  if (!needle || needle.length < 3) return false;
  if (hay.includes(` ${needle} `)) return true;
  // «Побег из Шоушенка 2» на Rutube — часто полный фильм с ошибочным номером в названии.
  const numbered = new RegExp(` ${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d+ `);
  return numbered.test(hay);
};

const runtimeCloseMatch = (durationSec, runtimeMinutes) => {
  if (!Number.isFinite(durationSec) || !Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) {
    return false;
  }
  const target = runtimeMinutes * 60;
  const tol = target * 0.12;
  return durationSec >= target - tol && durationSec <= target + tol;
};

const bestTitleSimilarity = (candidateTitle, names) => {
  let best = 0;
  for (const name of names) {
    best = Math.max(best, titleSimilarity(name, candidateTitle));
  }
  return best;
};

const isLatinTitle = (text) => {
  const s = String(text || '').trim();
  if (!s) return false;
  return !/[\p{Script=Cyrillic}]/u.test(s);
};

// Короткий русский перевод («Матрица», «Интерстеллар») даёт много ложных совпадений.
const needsStrictOriginalMatch = (title, originalTitle) => {
  if (!title || !originalTitle || !isLatinTitle(originalTitle) || isLatinTitle(title)) return false;
  const words = normalizeForMatch(title).split(/\s+/).filter(Boolean);
  return words.length <= 1 || normalizeForMatch(title).length <= 12;
};

const hasOriginalAnchor = (candidateTitle, { title, originalTitle, year, runtimeMinutes, duration }) => {
  if (originalTitle && containsTitlePhrase(candidateTitle, originalTitle)) return true;
  if (year && titleYearMatches(candidateTitle, year)) return true;
  if (originalTitle && bestTitleSimilarity(candidateTitle, [originalTitle]) >= 0.62) return true;
  if (title && containsTitlePhrase(candidateTitle, title) && !needsStrictOriginalMatch(title, originalTitle)) {
    return true;
  }
  if (Number.isFinite(duration) && runtimeCloseMatch(duration, runtimeMinutes)
    && originalTitle && bestTitleSimilarity(candidateTitle, [originalTitle]) >= 0.5) {
    return true;
  }
  return false;
};

const computeMatchConfidence = (candidate, { title, originalTitle, year, runtimeMinutes }) => {
  const names = [title, originalTitle].filter(Boolean);
  if (!names.length || isObviouslyWrongVideo(candidate.title, { title, originalTitle })) return 0;

  if (needsStrictOriginalMatch(title, originalTitle)
    && !hasOriginalAnchor(candidate.title, { title, originalTitle, year, runtimeMinutes, duration: candidate.duration })) {
    return 0;
  }

  let confidence = 0;
  if (originalTitle && containsTitlePhrase(candidate.title, originalTitle)) confidence += 0.42;
  else if (title && containsTitlePhrase(candidate.title, title)) confidence += 0.32;

  const sim = bestTitleSimilarity(candidate.title, names);
  confidence += sim * 0.28;

  if (year && titleYearMatches(candidate.title, year)) confidence += 0.12;
  else if (year) confidence -= 0.08;

  if (runtimeCloseMatch(candidate.duration, runtimeMinutes)) confidence += 0.1;
  else if (Number.isFinite(runtimeMinutes) && runtimeMinutes > 0) confidence -= 0.12;

  return Math.min(1, Math.max(0, Math.round(confidence * 1000) / 1000));
};

const MIN_MATCH_CONFIDENCE = 0.55;

const pickValidatedCandidate = async (candidates, { type, req, username, expectedTitle, expectedYear, title, originalTitle, runtimeMinutes }) => {
  if (!candidates?.length) return null;
  for (const candidate of candidates) {
    if (isObviouslyWrongVideo(candidate.title, { title, originalTitle })) continue;

    if (needsStrictOriginalMatch(title, originalTitle)
      && !hasOriginalAnchor(candidate.title, {
        title,
        originalTitle,
        year: expectedYear,
        runtimeMinutes,
        duration: candidate.duration
      })) {
      continue;
    }

    const confidence = computeMatchConfidence(candidate, {
      title,
      originalTitle,
      year: expectedYear,
      runtimeMinutes
    });
    if (confidence < MIN_MATCH_CONFIDENCE) continue;

    const valid = await validateVideoCandidate({
      title: candidate.title,
      durationSec: candidate.duration,
      channelName: candidate.channelName || candidate.source,
      mediaType: type,
      expectedTitle,
      expectedYear,
      req,
      username
    });
    if (valid) return enrichResult({ ...candidate, confidence });
  }
  return null;
};

const scoreCandidate = (candidate, { year, runtimeMinutes, title, originalTitle }) => {
  const names = [title, originalTitle].filter(Boolean);
  const phraseOriginal = originalTitle && containsTitlePhrase(candidate.title, originalTitle) ? 1 : 0;
  const phraseLocalized = title && containsTitlePhrase(candidate.title, title) ? 1 : 0;
  const simOriginal = originalTitle ? bestTitleSimilarity(candidate.title, [originalTitle]) : 0;
  const simLocalized = title ? bestTitleSimilarity(candidate.title, [title]) : 0;
  const sim = Math.max(simOriginal, simLocalized);
  const relevance = titleRelevanceScore(candidate.title, { title, originalTitle });
  let score = Math.max(phraseOriginal * 1.2, phraseLocalized, sim, relevance * 0.8) * 10_000_000;
  if (originalTitle && isLatinTitle(originalTitle)) score += simOriginal * 2_000_000;
  if (year && titleYearMatches(candidate.title, year)) score += 500_000;
  if (yearMismatch(candidate.title, year)) score -= 2_000_000;
  if (hasSequelMismatch(candidate.title, names)) score -= 3_000_000;
  // Просмотры — слабый сигнал: ограничиваем, чтобы популярный левый ролик
  // не перебивал точное совпадение названия.
  score += Math.min(Number(candidate.views) || 0, 300_000);
  if (Number.isFinite(runtimeMinutes) && runtimeMinutes > 0 && Number.isFinite(candidate.duration)) {
    const target = runtimeMinutes * 60;
    score += Math.max(0, 100_000 - Math.abs(candidate.duration - target));
    if (runtimeCloseMatch(candidate.duration, runtimeMinutes)) score += 400_000;
  }
  return score;
};

// Строгая проверка: кандидат обязан содержать название фильма целой фразой
// либо быть очень похожим на него. Отсекаем сиквелы и неверный год.
// При наличии латинского originalTitle короткий русский перевод сам по себе
// недостаточен («Начало», «Матрица» и т.п. дают ложные совпадения).
const isRelevantCandidate = (candidate, { title, originalTitle, year, runtimeMinutes }) => {
  if (!candidate?.title || !stripTitleExclusions(candidate.title)) return false;

  const names = [title, originalTitle].filter(Boolean);
  if (!names.length) return false;

  if (hasSequelMismatch(candidate.title, names)) return false;
  if (isSpinoffTitle(candidate.title, names)) return false;
  if (yearMismatch(candidate.title, year)) return false;

  const simOriginal = originalTitle ? bestTitleSimilarity(candidate.title, [originalTitle]) : 0;
  const simLocalized = title ? bestTitleSimilarity(candidate.title, [title]) : 0;
  const sim = Math.max(simOriginal, simLocalized);
  const durationOk = runtimeCloseMatch(candidate.duration, runtimeMinutes);

  const accept = () => {
    if (!year || titleYearMatches(candidate.title, year)) return true;
    // Хронометраж совпал — год в названии ролика часто отсутствует (типично для Rutube).
    if (durationOk && sim >= 0.65) return true;
    return false;
  };

  if (originalTitle && containsTitlePhrase(candidate.title, originalTitle)) return accept();
  if (title && containsTitlePhrase(candidate.title, title)) {
    if (!originalTitle || !isLatinTitle(originalTitle)) return accept();
    if (simOriginal >= 0.5) return accept();
    if (year && titleYearMatches(candidate.title, year) && simOriginal >= 0.35) return accept();
    if (durationOk && simLocalized >= 0.65) return accept();
    // Короткий русский перевод («Матрица») без года и без близкой длительности — отсекаем разборы.
    return false;
  }

  if (sim >= 0.75) return accept();
  if (year && titleYearMatches(candidate.title, year) && sim >= 0.6) return true;
  if (originalTitle && isLatinTitle(originalTitle) && simOriginal >= 0.65) return accept();
  if (durationOk && sim >= 0.7) return accept();

  return false;
};

const isStrongTitleMatch = (candidate, { title, originalTitle, year }) => {
  const names = [title, originalTitle].filter(Boolean);
  if (!names.length) return false;
  if (names.some((name) => containsTitlePhrase(candidate.title, name))) return true;
  const sim = bestTitleSimilarity(candidate.title, names);
  return sim >= 0.8 || (year && titleYearMatches(candidate.title, year) && sim >= 0.7);
};

const passesDuration = (candidate, runtimeMinutes, type, titleCtx) =>
  durationMatches(candidate.duration, runtimeMinutes, type, {
    strongTitleMatch: isStrongTitleMatch(candidate, titleCtx)
  });

async function rutubeLookupCandidates({ title, originalTitle, year, runtimeMinutes, type }) {
  const queries = buildSearchQueries({ title, originalTitle, year });
  if (!queries.length) return [];

  const seen = new Set();
  const items = [];
  for (const query of queries) {
    const url = new URL('https://rutube.ru/api/search/video/');
    url.searchParams.set('query', query);
    url.searchParams.set('format', 'json');

    const res = await fetch(url.toString(), { headers: { ...DEFAULT_HEADERS, Referer: 'https://rutube.ru/' } });
    if (!res.ok) continue;
    const json = await res.json().catch(() => null);
    const batch = Array.isArray(json?.results)
      ? json.results
      : (Array.isArray(json?.items) ? json.items : (Array.isArray(json?.videos) ? json.videos : []));
    for (const it of batch) {
      const videoId = it?.id || it?.video_id || null;
      const key = String(videoId || it?.embed_url || it?.embedUrl || it?.title || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }
  }

  const candidates = items.map((it) => {
    const durationSec = parseDurationSeconds(it?.duration || it?.duration_sec || it?.video_duration || it?.durationSeconds);
    const videoId = it?.id || it?.video_id || null;
    const embedUrl = it?.embed_url || it?.embedUrl
      || (videoId ? `https://rutube.ru/play/embed/${videoId}` : null);
    // Название берём только из ответа Rutube — подставлять ожидаемое нельзя,
    // иначе левый ролик пройдёт проверку релевантности.
    const name = it?.title || it?.name || '';
    const views = Number(it?.hits || it?.views || it?.stats?.views || it?.totalViews || 0);
    const channelName = it?.author?.name || it?.channel?.title || it?.author_name || 'Rutube';
    return { source: 'rutube', embedUrl, title: name, duration: durationSec, views, channelName };
  }).filter((c) => c.embedUrl && c.title && c.duration && stripTitleExclusions(c.title)
    && passesDuration(c, runtimeMinutes, type, { title, originalTitle, year }));

  candidates.sort((a, b) => scoreCandidate(b, { year, runtimeMinutes, title, originalTitle })
    - scoreCandidate(a, { year, runtimeMinutes, title, originalTitle }));
  return candidates.filter((c) => isRelevantCandidate(c, { title, originalTitle, year, runtimeMinutes }));
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

async function vkLookupCandidates({ title, originalTitle, year, runtimeMinutes, type }) {
  const queries = buildSearchQueries({ title, originalTitle, year });
  if (!queries.length) return [];

  const seen = new Set();
  const candidates = [];
  for (const query of queries) {
    const url = `https://vk.com/video?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { ...DEFAULT_HEADERS, Referer: 'https://vk.com/' } });
    if (!res.ok) continue;
    const html = await res.text();

    const matches = [...html.matchAll(/video_ext\.php\?oid=(\d+)&id=(\d+)&hash=([^"&]+)/g)];
    for (const m of matches) {
      const key = `${m[1]}:${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const oid = m[1];
      const id = m[2];
      const hash = m[3];
      const embedUrl = `https://vk.com/video_ext.php?oid=${encodeURIComponent(oid)}&id=${encodeURIComponent(id)}&hash=${encodeURIComponent(hash)}`;
      const idx = m.index ?? 0;
      const snippet = html.slice(Math.max(0, idx - 420), Math.min(html.length, idx + 420));
      const durationSec = parseVkDurationSecondsFromText(snippet);
      const titleMatch = snippet.match(/title["']?\s*[:=]\s*["']([^"']+)/i)
        || snippet.match(/aria-label=["']([^"']+)/i);
      // Без реального названия ролика кандидат бесполезен: раньше сюда
      // подставлялось ожидаемое название, и любой левый ролик «совпадал».
      const name = titleMatch?.[1] || '';
      if (!name) continue;
      candidates.push({ source: 'vk', embedUrl, title: name, duration: durationSec, channelName: 'VK' });
    }
  }

  const filtered = candidates.filter((c) => c.embedUrl && c.duration
    && stripTitleExclusions(c.title)
    && passesDuration(c, runtimeMinutes, type, { title, originalTitle, year }));
  if (!filtered.length) return [];

  filtered.sort((a, b) => scoreCandidate(b, { year, runtimeMinutes, title, originalTitle })
    - scoreCandidate(a, { year, runtimeMinutes, title, originalTitle }));
  return filtered.filter((c) => isRelevantCandidate(c, { title, originalTitle, year, runtimeMinutes }));
}

async function dailymotionLookupCandidates({ title, originalTitle, year, runtimeMinutes, type }) {
  const queries = buildSearchQueries({ title, originalTitle, year });
  if (!queries.length) return [];

  const seen = new Set();
  const items = [];
  for (const query of queries) {
    const url = new URL('https://api.dailymotion.com/videos');
    url.searchParams.set('search', query);
    url.searchParams.set('limit', '8');

    const res = await fetch(url.toString(), { headers: { ...DEFAULT_HEADERS } });
    if (!res.ok) continue;
    const json = await res.json().catch(() => null);
    const batch = Array.isArray(json?.list)
      ? json.list
      : (Array.isArray(json?.videos) ? json.videos : []);
    for (const it of batch) {
      const key = String(it?.id || it?.embed_url || it?.title || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }
  }

  const candidates = items.map((it) => {
    const durationSec = parseDurationSeconds(it?.duration);
    const embedUrl = it?.embed_url || it?.embedUrl || null;
    const name = it?.title || it?.name || '';
    return { source: 'dailymotion', embedUrl, title: name, duration: durationSec, channelName: 'Dailymotion' };
  }).filter((c) => c.embedUrl && c.title && c.duration && stripTitleExclusions(c.title)
    && passesDuration(c, runtimeMinutes, type, { title, originalTitle, year }));

  if (!candidates.length) return [];

  candidates.sort((a, b) => scoreCandidate(b, { year, runtimeMinutes, title, originalTitle })
    - scoreCandidate(a, { year, runtimeMinutes, title, originalTitle }));
  return candidates.filter((c) => isRelevantCandidate(c, { title, originalTitle, year, runtimeMinutes }));
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
export const lookupVideo = async ({
  tmdbId,
  type = 'movie',
  title = '',
  originalTitle = null,
  year = null,
  runtimeMinutes = null,
  req = null,
  username = null,
  refresh = false
}) => {
  const idKey = String(tmdbId);
  if (!idKey || idKey === 'null') return { error: 'not found' };

  if (refresh) invalidateVideoCache(idKey);

  const cached = cacheGet(idKey);
  if (cached) {
    const blocked = getBlockedVideoUrls(idKey);
    if (!blocked.has(cached.embedUrl)) return cached;
    invalidateVideoCache(idKey);
  }

  if (inFlight.has(idKey)) return inFlight.get(idKey);

  const task = (async () => {
    const lookupTimeout = new Promise((resolve) => {
      setTimeout(() => resolve({ error: 'not found' }), LOOKUP_TIMEOUT_MS);
    });

    const lookupWork = (async () => {
      const runtime = Number(runtimeMinutes);
      const yearNum = year != null && year !== '' ? Number(year) : null;
      const safeTitle = String(title || '').trim();
      const safeOriginal = String(originalTitle || '').trim() || null;
      const safeYear = yearNum != null && Number.isFinite(yearNum) ? yearNum : null;

      if (!safeTitle && !safeOriginal) return { error: 'not found' };

      const lookupArgs = {
        title: safeTitle,
        originalTitle: safeOriginal,
        year: safeYear,
        runtimeMinutes: runtime,
        type
      };
      const sourceOrder = getSourcePriorityOrder().filter((name) => SOURCE_LOOKUPS[name]);
      const hasCyrillicTitle = /[\p{Script=Cyrillic}]/u.test(`${safeTitle} ${safeOriginal || ''}`);
      const orderedSources = hasCyrillicTitle
        ? ['rutube', ...sourceOrder.filter((n) => n !== 'rutube')]
        : sourceOrder;

      const mergeAndPick = async (candidates) => {
        const blocked = getBlockedVideoUrls(idKey);
        const merged = candidates
          .filter((c) => c?.embedUrl && isEmbeddableUrl(c.source, c.embedUrl))
          .filter((c) => !blocked.has(c.embedUrl))
          .filter((c) => isRelevantCandidate(c, {
            title: safeTitle,
            originalTitle: safeOriginal,
            year: safeYear,
            runtimeMinutes: runtime
          }));
        merged.sort((a, b) => scoreCandidate(b, {
          year: safeYear,
          runtimeMinutes: runtime,
          title: safeTitle,
          originalTitle: safeOriginal
        }) - scoreCandidate(a, {
          year: safeYear,
          runtimeMinutes: runtime,
          title: safeTitle,
          originalTitle: safeOriginal
        }));
        return pickValidatedCandidate(merged, {
          type,
          req,
          username,
          expectedTitle: [safeOriginal, safeTitle].filter(Boolean).join(' / '),
          expectedYear: safeYear,
          title: safeTitle,
          originalTitle: safeOriginal,
          runtimeMinutes: runtime
        });
      };

      const seenSources = new Set();
      let accumulated = [];
      for (const sourceName of orderedSources) {
        if (seenSources.has(sourceName)) continue;
        seenSources.add(sourceName);
        const batch = await SOURCE_LOOKUPS[sourceName](lookupArgs).catch(() => []);
        accumulated = accumulated.concat(batch);
        const picked = await mergeAndPick(accumulated);
        if (picked?.embedUrl && isEmbeddableUrl(picked.source, picked.embedUrl)) {
          cacheSetResult(idKey, picked);
          return picked;
        }
      }

      return { error: 'not found' };
    })();

    try {
      return await Promise.race([lookupWork, lookupTimeout]);
    } finally {
      inFlight.delete(idKey);
    }
  })();

  inFlight.set(idKey, task);
  return task;
};
