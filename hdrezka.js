import { titleSimilarity } from './tmdbMatch.js';
import {
  getActiveMirror,
  invalidateMirror,
  rewriteMirrorUrl
} from './rezkaMirrors.js';



export const HDREZKA_BASE = (process.env.HDREZKA_BASE || 'https://hdrezka.name').replace(/\/$/, '');

let activeHdrezkaBase = null;

export const ensureHdrezkaBase = async (forceRefresh = false) => {
  activeHdrezkaBase = await getActiveMirror({ forceRefresh });
  return activeHdrezkaBase;
};

export const getHdrezkaBaseSync = () => activeHdrezkaBase || HDREZKA_BASE;

export const buildDefaultHeaders = (base = getHdrezkaBaseSync()) => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  Referer: `${base}/`,
  'X-Requested-With': 'XMLHttpRequest'
});

export const DEFAULT_HEADERS = buildDefaultHeaders(HDREZKA_BASE);



function decodeHtml(text) {

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



function parseVoteCount(text) {

  if (!text) return null;

  const num = Number(String(text).replace(/[^\d]/g, ''));

  return Number.isFinite(num) && num > 0 ? num : null;

}



function parseRating(text) {

  if (!text) return null;

  const cleaned = String(text).replace(',', '.').trim();

  const num = Number(cleaned);

  if (!Number.isFinite(num) || num <= 0) return null;

  const fraction = cleaned.split('.')[1] || '';

  const decimals = fraction.length >= 2 ? 2 : 1;

  return Number(num.toFixed(decimals));

}



function absolutizeUrl(url, base = getHdrezkaBaseSync()) {

  if (!url) return null;

  if (url.startsWith('http')) return rewriteMirrorUrl(url, base);

  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;

}



function decodeHelpLink(block) {

  const encoded = block.match(/href="\/help\/([^"/]+)/i)?.[1];

  if (!encoded) return null;

  try {

    return decodeURIComponent(atob(encoded));

  } catch {

    return null;

  }

}



export function parseHdrezkaDisplayTitle(entyTitle) {

  const fullTitle = decodeHtml(entyTitle);

  const parts = fullTitle.split(/\s*\/\s*/).map((part) => part.trim()).filter(Boolean);



  return {

    title: parts[0] || fullTitle,

    altTitle: parts.length > 1 ? parts.slice(1).join(' / ') : null,

    fullTitle

  };

}



function parseOriginalFromMeta(metaText) {
  const meta = decodeHtml(metaText || '');
  if (!meta) return { originalTitle: null, year: null };

  const year = meta.match(/\b(19|20)\d{2}\b/)?.[0] || null;
  let original = meta
    .replace(/,\s*сериал[\s\S]*$/i, '')
    .replace(/\s*-\s*\.\.\.\s*$/i, '')
    .trim();

  original = original.replace(/,\s*(19|20)\d{2}\b.*$/, '').trim();
  original = original.split(',')[0].trim();

  return {
    originalTitle: original || null,
    year
  };
}



function parseSearchRowMeta(row) {

  const metaText = row.match(/class="enty"[^>]*>[^<]+<\/span>\s*\(([^)]+)\)/i)?.[1]

    || row.replace(/<[^>]+>/g, ' ');

  return parseOriginalFromMeta(metaText);

}



const HDREZKA_TIMEOUT_MS = Number(process.env.HDREZKA_TIMEOUT_MS) || 3500;

const fetchHdrezkaHtmlOnce = async (pathOrUrl, options = {}, base) => {
  const url = pathOrUrl.startsWith('http')
    ? rewriteMirrorUrl(pathOrUrl, base)
    : `${base}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HDREZKA_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { ...buildDefaultHeaders(base), ...(options.headers || {}) }
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) return null;

  const html = await response.text();
  if (/подозрительную активность|ОШИБКА ДОСТУПА/i.test(html)) return null;
  return html;
};

export async function fetchHdrezkaHtml(pathOrUrl, options = {}, allowRetry = true) {
  let base;
  try {
    base = await ensureHdrezkaBase();
  } catch (err) {
    console.warn('[hdrezka] mirror resolve failed:', err?.message || err);
    return null;
  }

  const html = await fetchHdrezkaHtmlOnce(pathOrUrl, options, base);
  if (html || !allowRetry) return html;

  await invalidateMirror();
  try {
    base = await ensureHdrezkaBase(true);
  } catch (err) {
    console.warn('[hdrezka] mirror retry failed:', err?.message || err);
    return null;
  }

  return fetchHdrezkaHtmlOnce(pathOrUrl, options, base);
}



function detectRateName(block) {

  if (/b-post__info_rates\s+imdb|>IMDb/i.test(block)) return 'imdb';

  if (/b-post__info_rates\s+kp|>Кинопоиск/i.test(block)) return 'kinopoisk';

  if (/imdb/i.test(block)) return 'imdb';

  if (/кинопоиск/i.test(block)) return 'kinopoisk';

  return null;

}



function extractRateFromBlock(block) {

  const name = detectRateName(block);

  if (!name) return null;



  const rating = parseRating(

    block.match(/<span[^>]*class="bold"[^>]*>\s*([\d.,]+)\s*<\/span>/i)?.[1]

    || block.match(/<span[^>]*>\s*([\d.,]+)\s*<\/span>/i)?.[1]

    || block.match(/<b[^>]*>\s*([\d.,]+)\s*<\/b>/i)?.[1]

    || block.match(/>([\d.,]+)<\/i>/i)?.[1]

  );

  const votes = parseVoteCount(

    block.match(/<i[^>]*>\s*\(([^)]+)\)/i)?.[1]

    || block.match(/на основе\s+([\d\s]+)\s+голос/i)?.[1]

  );



  if (rating == null && votes == null) return null;



  return {

    name,

    rating,

    votes,

    url: decodeHelpLink(block)

  };

}



function parseRatingsHtml(html) {

  const result = { imdb: null, kinopoisk: null };



  const imdbBlock = html.match(/class="b-post__info_rates\s+imdb"[^>]*>([\s\S]*?)<\/span>\s*(?:<span class="b-post__info_rates\s+kp"|$)/i)?.[1];

  const kpBlock = html.match(/class="b-post__info_rates\s+kp"[^>]*>([\s\S]*?)<\/span>\s*<\/td>/i)?.[1];



  [imdbBlock, kpBlock].forEach((block, index) => {

    if (!block) return;

    const wrapped = `<span class="b-post__info_rates ${index === 0 ? 'imdb' : 'kp'}">${block}</span>`;

    const rate = extractRateFromBlock(wrapped);

    if (!rate?.rating) return;



    const entry = {

      rating: rate.rating,

      votes: rate.votes,

      url: rate.url,

      source: 'hdrezka'

    };



    if (rate.name === 'imdb') result.imdb = entry;

    if (rate.name === 'kinopoisk') result.kinopoisk = entry;

  });



  const bubbleSection = html.match(/class="b-content__bubble_rates"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '';

  const bubbleBlocks = bubbleSection.match(/<span[^>]*>[\s\S]*?<\/span>/gi) || [];



  bubbleBlocks.forEach((block) => {

    const rate = extractRateFromBlock(block);

    if (!rate?.rating) return;



    const entry = {

      rating: rate.rating,

      votes: rate.votes,

      url: rate.url,

      source: 'hdrezka'

    };



    if (rate.name === 'imdb' && !result.imdb) result.imdb = entry;

    if (rate.name === 'kinopoisk' && !result.kinopoisk) result.kinopoisk = entry;

  });



  return result;

}



function parseAjaxSearchItems(html) {

  const items = [];

  const rows = html.match(/<li>[\s\S]*?<\/li>/gi) || [];



  for (const row of rows) {

    const url = row.match(/<a[^>]+href="([^"]+)"/i)?.[1];

    const enty = row.match(/<span[^>]*class="enty"[^>]*>([^<]+)</i)?.[1];

    const { originalTitle, year } = parseSearchRowMeta(row);



    if (!url || !enty) continue;



    items.push({

      url: absolutizeUrl(url),

      title: decodeHtml(enty),

      originalTitle,

      year

    });

  }



  return items;

}



function parseAdvancedSearchItems(html) {

  const items = [];

  const chunks = html.split('b-content__inline_item');



  for (let i = 1; i < chunks.length; i++) {

    const chunk = chunks[i];

    const id = chunk.match(/data-id="(\d+)"/)?.[1];

    const url = chunk.match(/data-url="([^"]+)"/)?.[1];

    const enty = chunk.match(/b-content__inline_item-link[\s\S]*?<a[^>]*>([^<]+)</i)?.[1];

    const meta = chunk.match(/b-content__inline_item-link[\s\S]*?<div>([^<]+)</i)?.[1] || '';

    const { originalTitle, year: metaYear } = parseOriginalFromMeta(meta);



    if (!url || !enty) continue;



    items.push({

      id: id ? Number(id) : null,

      url: absolutizeUrl(url),

      title: decodeHtml(enty),

      originalTitle,

      year: metaYear

    });

  }



  return items;

}



export async function searchHdrezka(query) {

  const ajaxHtml = await fetchHdrezkaHtml('/engine/ajax/search.php', {

    method: 'POST',

    headers: {

      'Content-Type': 'application/x-www-form-urlencoded'

    },

    body: `q=${encodeURIComponent(query)}`

  });



  const ajaxItems = ajaxHtml ? parseAjaxSearchItems(ajaxHtml) : [];

  if (ajaxItems.length) return ajaxItems;



  const pageHtml = await fetchHdrezkaHtml(

    `/search/?do=search&subaction=search&q=${encodeURIComponent(query)}`,

    { headers: { 'X-Requested-With': undefined } }

  );



  return pageHtml ? parseAdvancedSearchItems(pageHtml) : [];

}



function pickBestSearchResult(query, year, items, originalTitle = null) {

  if (!items.length) return null;



  const yearNum = year ? Number(year) : null;

  let best = null;

  let bestScore = -1;



  for (const item of items) {

    let score = titleSimilarity(query, item.title) * 100;

    const itemYear = item.year ? Number(item.year) : null;



    if (originalTitle && item.originalTitle) {

      score += titleSimilarity(originalTitle, item.originalTitle) * 90;

    }



    if (yearNum && itemYear === yearNum) score += 40;

    else if (yearNum && itemYear && Math.abs(itemYear - yearNum) <= 1) score += 15;



    if (score > bestScore) {

      bestScore = score;

      best = item;

    }

  }



  return bestScore >= 35 ? best : items[0];

}



async function fetchPageRatings(movieUrl) {

  const html = await fetchHdrezkaHtml(movieUrl, {

    headers: { 'X-Requested-With': undefined }

  });

  if (!html) return null;



  const ratings = parseRatingsHtml(html);

  const hasAny = ratings.imdb?.rating || ratings.kinopoisk?.rating;

  if (!hasAny) return null;



  if (ratings.imdb && !ratings.imdb.url) ratings.imdb.url = movieUrl;

  if (ratings.kinopoisk && !ratings.kinopoisk.url) ratings.kinopoisk.url = movieUrl;



  return { ...ratings, hdrezkaUrl: movieUrl };

}



function buildHdrezkaResult(picked, ratings = null) {

  const parsed = parseHdrezkaDisplayTitle(picked.title);



  return {

    title: parsed.title,

    fullTitle: parsed.fullTitle,

    altTitle: parsed.altTitle,

    originalTitle: picked.originalTitle || null,

    year: picked.year || null,

    url: picked.url,

    imdb: ratings?.imdb || null,

    kinopoisk: ratings?.kinopoisk || null,

    hdrezkaUrl: ratings?.hdrezkaUrl || picked.url

  };

}



// Проверяем, что найденный на HDRezka результат — действительно тот фильм:
// сравниваем названия (с учётом оригинального) и год. Если совпадение слабое
// или год расходится больше чем на год — считаем, что фильма на сайте нет.
function isConfidentHdrezkaMatch({ title, originalTitle, matchedTitle, year }, picked) {
  if (!picked) return false;
  const parsed = parseHdrezkaDisplayTitle(picked.title || '');
  const refs = [originalTitle, matchedTitle, title].filter(Boolean);
  const cands = [picked.title, parsed.title, parsed.altTitle, picked.originalTitle].filter(Boolean);
  if (!refs.length || !cands.length) return false;

  let sim = 0;
  for (const r of refs) {
    for (const c of cands) sim = Math.max(sim, titleSimilarity(r, c));
  }
  if (sim < 0.6) return false;

  if (year && picked.year && Math.abs(Number(picked.year) - Number(year)) > 1) return false;
  return true;
}

export async function resolveHdrezkaMovie({ title, year, matchedTitle, originalTitle }) {

  const queries = [...new Set([originalTitle, title, matchedTitle].filter(Boolean))];

  if (!queries.length) return null;



  try {
    await ensureHdrezkaBase();

    let picked = null;



    for (const query of queries) {

      const items = await searchHdrezka(query);

      picked = pickBestSearchResult(

        originalTitle || matchedTitle || query,

        year,

        items,

        originalTitle

      );

      if (picked) break;

    }



    if (!picked?.url) return null;



    const confident = isConfidentHdrezkaMatch({ title, originalTitle, matchedTitle, year }, picked);

    const ratings = await fetchPageRatings(picked.url);

    return { ...buildHdrezkaResult(picked, ratings), confident };

  } catch {

    return null;

  }

}



/* ===================================================================
   Дополнительное обогащение страницы человека данными HDRezka.
   Источник вспомогательный (TMDB — основной). Возвращаем только то, чего
   обычно нет в TMDB: рост, иногда место рождения. Всё «best-effort»:
   любая ошибка/таймаут → null, страница человека не ломается.
   =================================================================== */
function stripTags(html) {
  return decodeHtml(String(html || '').replace(/<[^>]+>/g, ' '));
}

export async function fetchHdrezkaPersonInfo(name) {
  if (!name) return null;
  try {
    await ensureHdrezkaBase();
    // 1) Ищем человека через расширенный поиск (там бывает блок «Актёры»).
    const searchHtml = await fetchHdrezkaHtml(
      `/search/?do=search&subaction=search&q=${encodeURIComponent(name)}`,
      { headers: { 'X-Requested-With': undefined } }
    );
    if (!searchHtml) return null;

    const personUrl = (searchHtml.match(/href="([^"]*\/person\/[^"]+)"/i) || [])[1];
    if (!personUrl) return null;

    // 2) Открываем страницу персоны и аккуратно вытаскиваем поля.
    const html = await fetchHdrezkaHtml(absolutizeUrl(personUrl), {
      headers: { 'X-Requested-With': undefined }
    });
    if (!html) return null;

    const info = {};

    // Рост: «Рост: 1.85 м» или «Рост 185 см».
    const heightMatch = stripTags(html).match(/Рост[:\s]*([\d]+(?:[.,]\d+)?)\s*(см|м)\b/i);
    if (heightMatch) {
      info.height = `${heightMatch[1].replace(',', '.')} ${heightMatch[2]}`;
    }

    // Место рождения (если в TMDB пусто).
    const placeMatch = html.match(/Место рождения[\s\S]{0,260}?<(?:a|span|div|td)[^>]*>([^<]{2,120})</i);
    if (placeMatch) {
      const place = decodeHtml(placeMatch[1]);
      if (place && !/место рождения/i.test(place)) info.placeOfBirth = place;
    }

    info.url = absolutizeUrl(personUrl);
    return (info.height || info.placeOfBirth) ? info : null;
  } catch {
    return null;
  }
}

export async function fetchHdrezkaRatings({ title, year, matchedTitle, originalTitle }) {

  const result = await resolveHdrezkaMovie({ title, year, matchedTitle, originalTitle });

  if (!result) return null;



  return {

    title: result.title,

    fullTitle: result.fullTitle,

    altTitle: result.altTitle,

    originalTitle: result.originalTitle,

    imdb: result.imdb,

    kinopoisk: result.kinopoisk,

    hdrezkaUrl: result.hdrezkaUrl,

    hdrezkaConfident: result.confident === true

  };

}


