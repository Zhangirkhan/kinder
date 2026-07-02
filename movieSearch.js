import { normalizeTitle, scoreTmdbResult } from './tmdbMatch.js';

const ANIMATION_GENRE_ID = 16;
const MIN_YEAR = 1900;

function hasKeyword(text, words) {
  const lower = String(text || '').toLowerCase();
  return words.some((word) => {
    const re = new RegExp(`(?:^|[\\s,.:;!?\\-])${word}(?:[\\s,.:;!?\\-]|$)`, 'i');
    return re.test(lower);
  });
}

function stripKeywords(text, words) {
  let out = String(text || '');
  for (const word of words) {
    const re = new RegExp(`(?:^|[\\s,.:;!?\\-])${word}(?=[\\s,.:;!?\\-]|$)`, 'gi');
    out = out.replace(re, ' ').replace(/\s+/g, ' ').trim();
  }
  return out;
}

/** Разбор запроса: название, год, подсказка типа (фильм/сериал/аниме/мульт). */
export function parseSearchQuery(raw) {
  let text = String(raw || '').trim();
  let year = null;
  let mediaHint = null;

  const yearParen = text.match(/^(.+?)\s*[\(\[](\d{4})[\)\]]\s*$/);
  if (yearParen) {
    const y = parseInt(yearParen[2], 10);
    if (y >= MIN_YEAR && y <= new Date().getFullYear() + 2) {
      year = y;
      text = yearParen[1].trim();
    }
  }

  if (!year) {
    const yearEnd = text.match(/^(.+?)\s+(\d{4})\s*$/);
    if (yearEnd) {
      const y = parseInt(yearEnd[2], 10);
      if (y >= MIN_YEAR && y <= new Date().getFullYear() + 2) {
        year = y;
        text = yearEnd[1].trim();
      }
    }
  }

  if (!year) {
    const yearStart = text.match(/^(\d{4})\s+(.+)$/);
    if (yearStart) {
      const y = parseInt(yearStart[1], 10);
      if (y >= MIN_YEAR && y <= new Date().getFullYear() + 2) {
        year = y;
        text = yearStart[2].trim();
      }
    }
  }

  if (hasKeyword(text, ['аниме', 'anime'])) {
    mediaHint = 'anime';
    text = stripKeywords(text, ['аниме', 'anime']);
  } else if (hasKeyword(text, ['мультфильм', 'мультик', 'cartoon', 'animated', 'animation'])) {
    mediaHint = 'animation';
    text = stripKeywords(text, ['мультфильм', 'мультик', 'cartoon', 'animated', 'animation']);
  } else if (hasKeyword(text, ['сериал', 'series', 'шоу', 'сезон']) || /\btv\s*show\b/i.test(text)) {
    mediaHint = 'tv';
    text = stripKeywords(text, ['сериал', 'series', 'шоу', 'сезон']);
    text = text.replace(/\btv\s*show\b/gi, ' ').replace(/\s+/g, ' ').trim();
  } else if (hasKeyword(text, ['фильм', 'movie', 'кино'])) {
    mediaHint = 'movie';
    text = stripKeywords(text, ['фильм', 'movie', 'кино']);
  }

  return {
    query: text || String(raw || '').trim(),
    year,
    mediaHint,
    raw: String(raw || '').trim()
  };
}

export function isAnimationResult(result) {
  return (result?.genreIds || []).includes(ANIMATION_GENRE_ID);
}

export function detectContentType(result, mediaHint = null) {
  if (mediaHint === 'anime' || (result?.mediaType === 'tv' && isAnimationResult(result))) {
    return 'anime';
  }
  if (mediaHint === 'animation' || isAnimationResult(result)) {
    return 'animation';
  }
  return result?.mediaType === 'tv' ? 'tv' : 'movie';
}

/** Дополнительный скоринг для каталожного поиска поверх tmdbMatch. */
export function scoreSearchResult(query, result, options = {}) {
  let score = scoreTmdbResult(query, result);
  const yearHint = options.year;

  if (yearHint && result.year) {
    const resultYear = parseInt(result.year, 10);
    if (resultYear === yearHint) score += 28;
    else if (Math.abs(resultYear - yearHint) === 1) score += 10;
    else score -= 14;
  }

  const mediaHint = options.mediaHint;
  const animated = isAnimationResult(result);

  if (mediaHint === 'anime') {
    if (result.mediaType === 'tv' && animated) score += 22;
    else if (animated) score += 8;
    else score -= 12;
  } else if (mediaHint === 'animation') {
    if (animated) score += 20;
    else score -= 10;
  } else if (mediaHint === 'tv') {
    if (result.mediaType === 'tv') score += 14;
    else score -= 16;
  } else if (mediaHint === 'movie') {
    if (result.mediaType === 'movie') score += 14;
    else score -= 16;
  }

  const popularity = result.popularity || 0;
  score += Math.min(Math.log10(popularity + 1) * 7, 22);

  const rating = result.voteAverage || 0;
  const votes = result.voteCount || 0;
  if (rating >= 7.5 && votes >= 500) score += 10;
  else if (rating >= 6.5 && votes >= 200) score += 5;

  if (votes >= 5000) score += 6;
  else if (votes >= 1000) score += 3;

  return Math.round(score * 10) / 10;
}

export function rankSearchResults(query, results, options = {}) {
  const parsed = options.parsed || parseSearchQuery(query);
  const searchQuery = parsed.query || query;
  const minScore = options.minScore ?? 18;

  const items = (results || [])
    .map((r) => ({
      ...r,
      score: scoreSearchResult(searchQuery, r, {
        year: parsed.year,
        mediaHint: parsed.mediaHint
      }),
      contentType: detectContentType(r, parsed.mediaHint)
    }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const voteDiff = (b.voteCount || 0) - (a.voteCount || 0);
      if (voteDiff !== 0) return voteDiff;
      return (b.popularity || 0) - (a.popularity || 0);
    });

  return { items, parsed };
}

export function markResultsInUserList(items, userMovies = []) {
  const keys = new Set(
    userMovies
      .filter((m) => m.tmdbId)
      .map((m) => `${m.mediaType || 'movie'}:${m.tmdbId}`)
  );
  return items.map((item) => ({
    ...item,
    inUserList: keys.has(`${item.mediaType || 'movie'}:${item.tmdbId}`)
  }));
}

/** LRU-кеш частых поисковых запросов. */
export class SearchCache {
  constructor(maxSize = 250, ttlMs = 10 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  key(query, filter, lang) {
    return `${lang}|${filter}|${normalizeTitle(query)}`;
  }

  get(query, filter, lang) {
    const entry = this.map.get(this.key(query, filter, lang));
    if (!entry) return null;
    if (Date.now() - entry.at > this.ttlMs) {
      this.map.delete(this.key(query, filter, lang));
      return null;
    }
    return entry.value;
  }

  set(query, filter, lang, value) {
    const k = this.key(query, filter, lang);
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(k, { at: Date.now(), value });
  }
}
