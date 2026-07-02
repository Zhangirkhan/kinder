/* ===================================================================
   services/aiValidator.js — AI-проверка кандидатов видео (трейлер vs фильм)
   OpenAI gpt-4o-mini, кэш 90 дней, rate limit через aiGovernance.
   =================================================================== */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createAiGovernance, AiGovernanceError, buildActor } from './aiGovernance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'ai_validation_cache.json');
const BACKUP_FILE = path.join(DATA_DIR, 'ai_validation_cache.json.bak');

const TTL_MS = 90 * 24 * 60 * 60 * 1000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS) || 30000;
const MAX_WORDS = 50;

const aiGov = createAiGovernance({ dataDir: DATA_DIR });

let cache = null;
let cacheLoaded = false;
let writing = false;
let writeQueued = false;

const ensureDataDirs = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CACHE_FILE)) fs.writeFileSync(CACHE_FILE, '{}');
};

const loadCache = () => {
  if (cacheLoaded) return cache;
  ensureDataDirs();
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8') || '{}');
  } catch {
    cache = {};
  }
  cacheLoaded = true;
  return cache;
};

const writeCacheToDisk = () => {
  if (writing) {
    writeQueued = true;
    return;
  }
  writing = true;
  try {
    ensureDataDirs();
    if (fs.existsSync(CACHE_FILE)) {
      try { fs.copyFileSync(CACHE_FILE, BACKUP_FILE); } catch { /* ignore */ }
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache || {}, null, 2));
  } finally {
    writing = false;
    if (writeQueued) {
      writeQueued = false;
      writeCacheToDisk();
    }
  }
};

const truncateWords = (text, maxWords = MAX_WORDS) => {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(' ');
};

const buildCacheKey = ({ title, durationSec, channelName }) => {
  const payload = `${String(title || '').toLowerCase()}|${durationSec || 0}|${String(channelName || '').toLowerCase()}`;
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 20);
};

const cacheGet = (key) => {
  const c = loadCache();
  const entry = c[key];
  if (!entry?.cachedAt) return null;
  if (Date.now() - entry.cachedAt > TTL_MS) return null;
  return entry.valid === true;
};

const cacheSet = (key, valid) => {
  const c = loadCache();
  c[key] = { cachedAt: Date.now(), valid: Boolean(valid) };
  writeCacheToDisk();
};

const isRateLimitError = (status, message) => {
  if (status === 429) return true;
  const m = String(message || '').toLowerCase();
  return m.includes('rate limit') || m.includes('quota') || m.includes('insufficient');
};

/**
 * Проверяет, является ли видео полным фильмом/серией (не трейлер/обзор).
 * При отсутствии ключа OpenAI или лимите — считает видео допустимым (true).
 * @returns {Promise<boolean>}
 */
export async function validateVideoCandidate({
  title = '',
  durationSec = null,
  channelName = '',
  mediaType = 'movie',
  req = null,
  username = null
} = {}) {
  const cacheKey = buildCacheKey({ title, durationSec, channelName });
  const cached = cacheGet(cacheKey);
  if (cached !== null) {
    aiGov.logEvent({
      actor: buildActor({ req, username }),
      feature: 'video_validation',
      endpoint: 'validateVideoCandidate',
      cacheKey,
      outcome: 'cache_hit',
      cached: true
    });
    return cached;
  }

  if (!OPENAI_API_KEY) {
    cacheSet(cacheKey, true);
    return true;
  }

  const actor = buildActor({ req, username });
  try {
    aiGov.assertAllowed({
      actor,
      feature: 'video_validation',
      cacheKey,
      endpoint: 'validateVideoCandidate'
    });
  } catch (err) {
    if (err instanceof AiGovernanceError) {
      cacheSet(cacheKey, true);
      return true;
    }
    throw err;
  }

  aiGov.recordAiUsage(actor, 'video_validation', cacheKey);

  const titleShort = truncateWords(title, 20);
  const channelShort = truncateWords(channelName, 15);
  const durationMin = Number.isFinite(durationSec) && durationSec > 0
    ? Math.round(durationSec / 60)
    : '?';

  const userContent = truncateWords(
    `Type: ${mediaType === 'tv' ? 'TV episode' : 'movie'}. Title: ${titleShort}. Duration: ${durationMin} min. Channel: ${channelShort || 'unknown'}.`,
    MAX_WORDS
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 3,
        messages: [
          {
            role: 'system',
            content: 'You classify videos. Answer ONLY "YES" if it is a full movie or TV episode. Answer ONLY "NO" if it is a trailer, teaser, review, reaction, or clip.'
          },
          { role: 'user', content: userContent }
        ]
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      aiGov.logEvent({
        actor,
        feature: 'video_validation',
        endpoint: 'validateVideoCandidate',
        cacheKey,
        outcome: 'error',
        reason: isRateLimitError(response.status, data.error?.message) ? 'openai_rate_limit' : 'openai_error'
      });
      if (isRateLimitError(response.status, data.error?.message)) return true;
      return true;
    }

    const answer = String(data.choices?.[0]?.message?.content || '').trim().toUpperCase();
    const valid = answer.startsWith('YES');
    cacheSet(cacheKey, valid);
    aiGov.logEvent({
      actor,
      feature: 'video_validation',
      endpoint: 'validateVideoCandidate',
      cacheKey,
      outcome: 'cache_miss',
      cached: false
    });
    return valid;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}
