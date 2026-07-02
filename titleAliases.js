import { normalizeTitle } from './tmdbMatch.js';
import { containsCyrillic, transliterateRuToLatin } from './titleTransliterate.js';

/** Плохие переводы / опечатки → запрос для поиска (англ. оригинал или известное название) */
const SEARCH_ALIASES = {
  'шоушенкский искупление': 'The Shawshank Redemption',
  'shawshank redemption': 'The Shawshank Redemption',
  'суперперцы': 'Superbad',
  'superbad': 'Superbad',
  'superперцы': 'Superbad',
  'гостя': 'Ghost',
  'ghost': 'Ghost',
  'призрак': 'Ghost',
  'мементо': 'Memento',
  'memento': 'Memento',
  'ривердейл': 'Riverdale',
  'riverdale': 'Riverdale',
  'джанго освобожденный': 'Django Unchained',
  'django освобожденный': 'Django Unchained',
  'django unchained': 'Django Unchained',
  'джанго': 'Django Unchained',
};

function latinSearchVariants(text) {
  const variants = new Set();
  const base = transliterateRuToLatin(text);
  if (!base) return [];

  variants.add(base);
  if (base.includes('dzh')) variants.add(base.replace(/dzh/g, 'dj'));
  if (base.includes('dj')) variants.add(base.replace(/dj/g, 'dzh'));
  if (base.includes('shch')) variants.add(base.replace(/shch/g, 'sch'));
  if (base.includes('kh')) variants.add(base.replace(/kh/g, 'h'));
  if (base.includes('yu')) variants.add(base.replace(/yu/g, 'u'));
  if (base.includes('ya')) variants.add(base.replace(/ya/g, 'a'));

  return [...variants].filter((item) => item.length >= 2);
}

export function resolveSearchQuery(title) {
  const resolved = SEARCH_ALIASES[normalizeTitle(title)];
  return resolved || String(title || '').trim();
}

/** Варианты запроса для TMDB: алиас, оригинал, транслит для кириллицы */
export function buildTmdbSearchQueries(title, extraQueries = []) {
  const trimmed = String(title || '').trim();
  if (!trimmed) return [];

  const queries = new Set();
  const alias = resolveSearchQuery(trimmed);
  queries.add(alias);
  if (trimmed !== alias) queries.add(trimmed);

  if (containsCyrillic(trimmed)) {
    for (const latin of latinSearchVariants(trimmed)) {
      queries.add(latin);
    }

    const words = trimmed.split(/\s+/).filter(Boolean);
    const firstWord = words[0];
    if (firstWord && firstWord.length >= 4 && words.length > 1) {
      const firstAlias = resolveSearchQuery(firstWord);
      queries.add(firstAlias);
      if (firstAlias !== firstWord) queries.add(firstWord);
      for (const latin of latinSearchVariants(firstWord)) {
        queries.add(latin);
      }
    }
  }

  for (const q of extraQueries) {
    const part = String(q || '').trim();
    if (part) queries.add(part);
  }

  return [...queries];
}

/** Варианты запроса для опечаток (короткий список, без лишних TMDB-вызовов). */
export function buildTypoSearchQueries(title) {
  const trimmed = String(title || '').trim();
  if (!trimmed || trimmed.length < 4) return [];

  const variants = new Set();
  const norm = normalizeTitle(trimmed);

  if (trimmed.length >= 5) variants.add(trimmed.slice(0, -1));
  if (trimmed.length >= 6) variants.add(trimmed.slice(1));

  for (let i = 0; i < trimmed.length - 1; i++) {
    const chars = [...trimmed];
    [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
    variants.add(chars.join(''));
  }

  const replacements = [
    ['ё', 'е'], ['ий', 'и'], ['ый', 'и'], ['тс', 'ц'], ['щ', 'ш'],
    ['е', 'и'], ['и', 'е'], ['о', 'а'], ['а', 'о']
  ];
  for (const [from, to] of replacements) {
    if (norm.includes(from)) variants.add(trimmed.replace(new RegExp(from, 'gi'), to));
  }

  return [...variants]
    .map((v) => v.trim())
    .filter((v) => v && v !== trimmed && v.length >= 3)
    .slice(0, 5);
}

/** @deprecated используйте resolveSearchQuery */
export function resolveMovieTitle(title) {
  return resolveSearchQuery(title);
}

export function isTitleCorrected(title) {
  return resolveSearchQuery(title) !== String(title || '').trim();
}
