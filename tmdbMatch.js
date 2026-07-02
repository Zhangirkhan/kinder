import { containsCyrillic, transliterateRuToLatin } from './titleTransliterate.js';

export function normalizeTitle(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

export function titleSimilarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
}

function compactSimilarity(a, b) {
  const na = normalizeTitle(a).replace(/\s/g, '');
  const nb = normalizeTitle(b).replace(/\s/g, '');
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
}

export function scoreTmdbResult(query, result) {
  const normQuery = normalizeTitle(query);
  if (!normQuery) return 0;

  let score = 0;
  const candidates = [result.title, result.originalTitle].filter(Boolean);
  const latinQuery = containsCyrillic(query) ? transliterateRuToLatin(query) : null;
  const queryVariants = [query, normQuery];
  if (latinQuery) queryVariants.push(latinQuery);

  for (const queryVariant of queryVariants) {
    const normVariant = normalizeTitle(queryVariant);
    for (const candidate of candidates) {
      const normCandidate = normalizeTitle(candidate);
      if (normVariant && normCandidate && normVariant === normCandidate) {
        score = Math.max(score, 100);
        continue;
      }

      const sim = titleSimilarity(queryVariant, candidate);
      const compact = compactSimilarity(queryVariant, candidate);
      const blended = Math.max(sim, compact);

      if (blended >= 0.95) score = Math.max(score, 100);
      else if (blended >= 0.85) score = Math.max(score, 82 + blended * 15);
      else if (blended >= 0.75) score = Math.max(score, 70 + blended * 20);
      else if (blended >= 0.6) score = Math.max(score, 45 + blended * 30);
      else score = Math.max(score, blended * 55);
    }
  }

  if (latinQuery && result.originalTitle) {
    const origSim = Math.max(
      titleSimilarity(latinQuery, result.originalTitle),
      compactSimilarity(latinQuery, result.originalTitle)
    );
    if (origSim >= 0.85) score = Math.max(score, 75 + origSim * 20);
    else if (origSim >= 0.7) score = Math.max(score, 55 + origSim * 25);
  }

  const voteCount = result.voteCount || 0;
  score += Math.min(Math.log10(voteCount + 1) * 12, 40);

  if (voteCount < 30) score -= 25;
  else if (voteCount < 100) score -= 8;
  if (voteCount < 5) score -= 40;

  const voteAverage = result.voteAverage || 0;
  if (voteAverage >= 7 && voteCount >= 200) score += 6;
  else if (voteAverage >= 6 && voteCount >= 100) score += 3;

  const year = parseInt(result.year, 10);
  const currentYear = new Date().getFullYear();
  if (year > currentYear + 1) score -= 60;
  else if (year === currentYear + 1) score -= 20;

  if (normQuery.length <= 4 && voteCount < 500) score -= 15;
  if (normQuery.length >= 12 && score < 40 && voteCount > 1000) score += 10;

  return Math.round(score * 10) / 10;
}

export function pickBestTmdbResult(query, results, options = {}) {
  const minScore = options.minScore ?? 62;
  const minGap = options.minGap ?? 8;

  if (!results?.length) {
    return { best: null, autoPick: false, confidence: 0, scored: [] };
  }

  const scored = results
    .map((r) => ({ ...r, score: scoreTmdbResult(query, r) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  const gap = second ? best.score - second.score : best.score;
  const autoPick = best.score >= minScore && gap >= minGap;

  return {
    best,
    autoPick,
    confidence: best.score,
    gap,
    scored
  };
}
