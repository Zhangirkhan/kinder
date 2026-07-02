/* ===================================================================
   services/aiGovernance.js — кэш, cooldown и rate limit для всех AI-вызовов
   =================================================================== */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** TTL, cooldown и лимиты по типу AI-функции. */
export const AI_FEATURES = {
  recommendations: {
    ttlMs: Number(process.env.AI_CACHE_TTL_RECOMMENDATIONS_MS) || 3 * HOUR_MS,
    cooldownMs: Number(process.env.AI_COOLDOWN_RECOMMENDATIONS_MS) || 60 * 1000,
    hourlyGuest: Number(process.env.AI_RATE_GUEST_RECOMMENDATIONS_HOUR) || 8,
    hourlyUser: Number(process.env.AI_RATE_USER_RECOMMENDATIONS_HOUR) || 40,
    dailyGuest: Number(process.env.AI_RATE_GUEST_RECOMMENDATIONS_DAY) || 20,
    dailyUser: Number(process.env.AI_RATE_USER_RECOMMENDATIONS_DAY) || 150,
    guestAiAllowed: false
  },
  recommendations_explain: {
    ttlMs: Number(process.env.AI_CACHE_TTL_EXPLANATIONS_MS) || 7 * DAY_MS,
    cooldownMs: Number(process.env.AI_COOLDOWN_EXPLANATIONS_MS) || 5 * 60 * 1000,
    hourlyGuest: 0,
    hourlyUser: Number(process.env.AI_RATE_USER_EXPLANATIONS_HOUR) || 15,
    dailyGuest: 0,
    dailyUser: Number(process.env.AI_RATE_USER_EXPLANATIONS_DAY) || 60,
    guestAiAllowed: false
  },
  premieres: {
    ttlMs: Number(process.env.AI_CACHE_TTL_PREMIERES_MS) || 18 * HOUR_MS,
    cooldownMs: Number(process.env.AI_COOLDOWN_PREMIERES_MS) || 10 * 60 * 1000,
    hourlyGuest: 0,
    hourlyUser: Number(process.env.AI_RATE_USER_PREMIERES_HOUR) || 10,
    dailyGuest: 0,
    dailyUser: Number(process.env.AI_RATE_USER_PREMIERES_DAY) || 30,
    guestAiAllowed: false
  },
  watch_now: {
    ttlMs: Number(process.env.AI_CACHE_TTL_WATCH_NOW_MS) || 2 * HOUR_MS,
    cooldownMs: Number(process.env.AI_COOLDOWN_WATCH_NOW_MS) || 2 * 60 * 1000,
    hourlyGuest: 0,
    hourlyUser: Number(process.env.AI_RATE_USER_WATCH_NOW_HOUR) || 12,
    dailyGuest: 0,
    dailyUser: Number(process.env.AI_RATE_USER_WATCH_NOW_DAY) || 40,
    guestAiAllowed: false
  },
  taste_analysis: {
    ttlMs: Number(process.env.AI_CACHE_TTL_TASTE_MS) || DAY_MS,
    cooldownMs: Number(process.env.AI_COOLDOWN_TASTE_MS) || 10 * 60 * 1000,
    hourlyGuest: 0,
    hourlyUser: Number(process.env.AI_RATE_USER_TASTE_HOUR) || 6,
    dailyGuest: 0,
    dailyUser: Number(process.env.AI_RATE_USER_TASTE_DAY) || 20,
    guestAiAllowed: false
  },
  similar: {
    ttlMs: Number(process.env.AI_CACHE_TTL_SIMILAR_MS) || 6 * HOUR_MS,
    cooldownMs: Number(process.env.AI_COOLDOWN_SIMILAR_MS) || 30 * 1000,
    hourlyGuest: 0,
    hourlyUser: Number(process.env.AI_RATE_USER_SIMILAR_HOUR) || 20,
    dailyGuest: 0,
    dailyUser: Number(process.env.AI_RATE_USER_SIMILAR_DAY) || 80,
    guestAiAllowed: false
  },
  import: {
    ttlMs: Number(process.env.AI_CACHE_TTL_IMPORT_MS) || 30 * 60 * 1000,
    cooldownMs: Number(process.env.AI_COOLDOWN_IMPORT_MS) || 5 * 1000,
    hourlyGuest: 0,
    hourlyUser: Number(process.env.AI_RATE_USER_IMPORT_HOUR) || 15,
    dailyGuest: 0,
    dailyUser: Number(process.env.AI_RATE_USER_IMPORT_DAY) || 50,
    guestAiAllowed: false
  },
  psych_recommendations: {
    ttlMs: Number(process.env.AI_CACHE_TTL_PSYCH_MS) || 3 * HOUR_MS,
    cooldownMs: Number(process.env.AI_COOLDOWN_PSYCH_MS) || 60 * 1000,
    hourlyGuest: 0,
    hourlyUser: Number(process.env.AI_RATE_USER_PSYCH_HOUR) || 15,
    dailyGuest: 0,
    dailyUser: Number(process.env.AI_RATE_USER_PSYCH_DAY) || 50,
    guestAiAllowed: false
  },
  visual_recommendations: {
    ttlMs: Number(process.env.AI_CACHE_TTL_VISUAL_MS) || 3 * HOUR_MS,
    cooldownMs: Number(process.env.AI_COOLDOWN_VISUAL_MS) || 60 * 1000,
    hourlyGuest: 0,
    hourlyUser: Number(process.env.AI_RATE_USER_VISUAL_HOUR) || 15,
    dailyGuest: 0,
    dailyUser: Number(process.env.AI_RATE_USER_VISUAL_DAY) || 50,
    guestAiAllowed: false
  },
  short_visual_recommendations: {
    ttlMs: Number(process.env.AI_CACHE_TTL_SHORT_VISUAL_MS) || 3 * HOUR_MS,
    cooldownMs: Number(process.env.AI_COOLDOWN_SHORT_VISUAL_MS) || 60 * 1000,
    hourlyGuest: 0,
    hourlyUser: Number(process.env.AI_RATE_USER_SHORT_VISUAL_HOUR) || 15,
    dailyGuest: 0,
    dailyUser: Number(process.env.AI_RATE_USER_SHORT_VISUAL_DAY) || 50,
    guestAiAllowed: false
  },
  premiere_suggest: {
    ttlMs: Number(process.env.AI_CACHE_TTL_PREMIERE_SUGGEST_MS) || 18 * HOUR_MS,
    cooldownMs: Number(process.env.AI_COOLDOWN_PREMIERE_SUGGEST_MS) || 10 * 60 * 1000,
    hourlyGuest: 0,
    hourlyUser: Number(process.env.AI_RATE_USER_PREMIERE_SUGGEST_HOUR) || 8,
    dailyGuest: 0,
    dailyUser: Number(process.env.AI_RATE_USER_PREMIERE_SUGGEST_DAY) || 25,
    guestAiAllowed: false
  },
  person_insight: {
    ttlMs: Number(process.env.AI_CACHE_TTL_PERSON_MS) || DAY_MS,
    cooldownMs: Number(process.env.AI_COOLDOWN_PERSON_MS) || 60 * 1000,
    hourlyGuest: 0,
    hourlyUser: Number(process.env.AI_RATE_USER_PERSON_HOUR) || 20,
    dailyGuest: 0,
    dailyUser: Number(process.env.AI_RATE_USER_PERSON_DAY) || 80,
    guestAiAllowed: false
  },
  translation: {
    ttlMs: 14 * DAY_MS,
    cooldownMs: Number(process.env.AI_COOLDOWN_TRANSLATION_MS) || 500,
    hourlyGuest: Number(process.env.AI_RATE_GUEST_TRANSLATION_HOUR) || 30,
    hourlyUser: Number(process.env.AI_RATE_USER_TRANSLATION_HOUR) || 120,
    dailyGuest: Number(process.env.AI_RATE_GUEST_TRANSLATION_DAY) || 100,
    dailyUser: Number(process.env.AI_RATE_USER_TRANSLATION_DAY) || 500,
    guestAiAllowed: true
  },
  video_validation: {
    ttlMs: 90 * DAY_MS,
    cooldownMs: Number(process.env.AI_COOLDOWN_VIDEO_VALIDATION_MS) || 200,
    hourlyGuest: Number(process.env.AI_RATE_GUEST_VIDEO_VALIDATION_HOUR) || 40,
    hourlyUser: Number(process.env.AI_RATE_USER_VIDEO_VALIDATION_HOUR) || 120,
    dailyGuest: Number(process.env.AI_RATE_GUEST_VIDEO_VALIDATION_DAY) || 200,
    dailyUser: Number(process.env.AI_RATE_USER_VIDEO_VALIDATION_DAY) || 600,
    guestAiAllowed: true
  },
  legacy_generation: {
    ttlMs: Number(process.env.AI_CACHE_TTL_LEGACY_MS) || 3 * HOUR_MS,
    cooldownMs: Number(process.env.AI_COOLDOWN_LEGACY_MS) || 60 * 1000,
    hourlyGuest: 0,
    hourlyUser: Number(process.env.AI_RATE_USER_LEGACY_HOUR) || 20,
    dailyGuest: 0,
    dailyUser: Number(process.env.AI_RATE_USER_LEGACY_DAY) || 80,
    guestAiAllowed: false
  }
};

export class AiGovernanceError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AiGovernanceError';
    this.governanceCode = code;
    this.cached = extra.cached ?? null;
    this.retryAfterMs = extra.retryAfterMs ?? null;
  }
}

function stableHash(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 24);
}

export function buildActor({ req, username }) {
  const isGuest = !username || username === '__guest__';
  const actorId = isGuest
    ? `ip:${getClientIp(req)}`
    : `user:${username}`;
  return { actorId, isGuest, username: isGuest ? '__guest__' : username };
}

export function getClientIp(req) {
  if (!req) return 'unknown';
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

export function createAiGovernance({ dataDir, debug = false } = {}) {
  const CACHE_FILE = path.join(dataDir, 'ai_response_cache.json');
  const LOG_FILE = path.join(dataDir, 'ai_usage_log.jsonl');

  let responseCache = {};
  let cacheLoaded = false;
  let cacheWriting = false;
  let cacheWriteQueued = false;

  const cooldowns = new Map();
  const rateCounters = new Map();

  const ensureDirs = () => {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(CACHE_FILE)) fs.writeFileSync(CACHE_FILE, '{}');
  };

  const loadResponseCache = () => {
    if (cacheLoaded) return responseCache;
    ensureDirs();
    try {
      responseCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8') || '{}');
    } catch {
      responseCache = {};
    }
    cacheLoaded = true;
    return responseCache;
  };

  const flushResponseCache = () => {
    if (cacheWriting) {
      cacheWriteQueued = true;
      return;
    }
    cacheWriting = true;
    try {
      ensureDirs();
      fs.writeFileSync(CACHE_FILE, JSON.stringify(responseCache, null, 2));
    } catch (err) {
      if (debug) console.error('[ai-governance] cache write failed', err?.message);
    } finally {
      cacheWriting = false;
      if (cacheWriteQueued) {
        cacheWriteQueued = false;
        flushResponseCache();
      }
    }
  };

  const cacheStorageKey = (feature, cacheKey) => `${feature}::${cacheKey}`;

  const getCachedResponse = (feature, cacheKey) => {
    const cfg = AI_FEATURES[feature];
    if (!cfg || !cacheKey) return null;
    const c = loadResponseCache();
    const entry = c[cacheStorageKey(feature, cacheKey)];
    if (!entry?.at || !entry.data) return null;
    if (Date.now() - entry.at > cfg.ttlMs) {
      delete c[cacheStorageKey(feature, cacheKey)];
      flushResponseCache();
      return null;
    }
    return entry.data;
  };

  const setCachedResponse = (feature, cacheKey, data) => {
    const cfg = AI_FEATURES[feature];
    if (!cfg || !cacheKey || !data || cfg.ttlMs <= 0) return;
    const c = loadResponseCache();
    c[cacheStorageKey(feature, cacheKey)] = { at: Date.now(), data };
    const keys = Object.keys(c);
    if (keys.length > 2000) {
      const sorted = keys
        .map((k) => ({ k, at: c[k]?.at || 0 }))
        .sort((a, b) => a.at - b.at);
      sorted.slice(0, keys.length - 1800).forEach(({ k }) => delete c[k]);
    }
    flushResponseCache();
  };

  const cooldownKey = (actorId, feature, cacheKey) =>
    `${actorId}::${feature}::${cacheKey || '*'}`;

  const checkCooldown = (actorId, feature, cacheKey) => {
    const cfg = AI_FEATURES[feature];
    if (!cfg) return { ok: true };
    const key = cooldownKey(actorId, feature, cacheKey);
    const last = cooldowns.get(key) || 0;
    const elapsed = Date.now() - last;
    if (elapsed < cfg.cooldownMs) {
      return { ok: false, retryAfterMs: cfg.cooldownMs - elapsed };
    }
    return { ok: true };
  };

  const touchCooldown = (actorId, feature, cacheKey) => {
    cooldowns.set(cooldownKey(actorId, feature, cacheKey), Date.now());
  };

  const rateKey = (actorId, feature, window) => `${actorId}::${feature}::${window}`;

  const bumpRate = (actorId, feature) => {
    const now = Date.now();
    const hourBucket = Math.floor(now / HOUR_MS);
    const dayBucket = Math.floor(now / DAY_MS);
    for (const [window, bucket] of [['hour', hourBucket], ['day', dayBucket]]) {
      const k = rateKey(actorId, feature, `${window}:${bucket}`);
      rateCounters.set(k, (rateCounters.get(k) || 0) + 1);
    }
    if (rateCounters.size > 5000) {
      const cutoff = now - DAY_MS;
      for (const [k, v] of rateCounters) {
        const parts = k.split('::');
        const bucketPart = parts[parts.length - 1];
        const [, bucketNum] = bucketPart.split(':');
        const bucketMs = bucketPart.startsWith('hour:')
          ? Number(bucketNum) * HOUR_MS
          : Number(bucketNum) * DAY_MS;
        if (bucketMs < cutoff) rateCounters.delete(k);
      }
    }
  };

  const getRateCount = (actorId, feature, window) => {
    const now = Date.now();
    const bucket = window === 'hour'
      ? Math.floor(now / HOUR_MS)
      : Math.floor(now / DAY_MS);
    return rateCounters.get(rateKey(actorId, feature, `${window}:${bucket}`)) || 0;
  };

  const checkRateLimit = (actor, feature) => {
    const cfg = AI_FEATURES[feature];
    if (!cfg) return { ok: true };
    const hourlyLimit = actor.isGuest ? cfg.hourlyGuest : cfg.hourlyUser;
    const dailyLimit = actor.isGuest ? cfg.dailyGuest : cfg.dailyUser;
    if (hourlyLimit <= 0 && actor.isGuest) {
      return { ok: false, reason: 'guest_blocked' };
    }
    if (hourlyLimit > 0 && getRateCount(actor.actorId, feature, 'hour') >= hourlyLimit) {
      return { ok: false, reason: 'rate_limit_hour' };
    }
    if (dailyLimit > 0 && getRateCount(actor.actorId, feature, 'day') >= dailyLimit) {
      return { ok: false, reason: 'rate_limit_day' };
    }
    return { ok: true };
  };

  const appendLog = (entry) => {
    try {
      ensureDirs();
      const line = JSON.stringify({
        at: new Date().toISOString(),
        ...entry
      });
      fs.appendFileSync(LOG_FILE, `${line}\n`);
    } catch (err) {
      if (debug) console.error('[ai-governance] log write failed', err?.message);
    }
    if (debug) {
      console.log('[ai-governance]', entry.event, entry.feature, entry.outcome || entry.reason || '');
    }
  };

  const logEvent = ({
    actor,
    feature,
    endpoint,
    cacheKey,
    outcome,
    reason,
    cached
  }) => {
    appendLog({
      actor: actor?.actorId,
      guest: actor?.isGuest ?? null,
      feature,
      endpoint: endpoint || null,
      cacheKey: cacheKey || null,
      outcome,
      reason: reason || null,
      cached: Boolean(cached)
    });
  };

  /**
   * Проверяет, можно ли вызывать AI. Возвращает кэш при cooldown/rate limit.
   * @returns {{ allowed: boolean, cached: object|null, reason: string|null, retryAfterMs: number|null }}
   */
  function preflight({ actor, feature, cacheKey, skipCache = false, endpoint }) {
    const cfg = AI_FEATURES[feature];
    if (!cfg) return { allowed: true, cached: null, reason: null, retryAfterMs: null };

    if (actor.isGuest && !cfg.guestAiAllowed) {
      const cached = !skipCache ? getCachedResponse(feature, cacheKey) : null;
      logEvent({
        actor, feature, endpoint, cacheKey,
        outcome: cached ? 'cache_hit' : 'denied',
        reason: 'guest_blocked',
        cached: Boolean(cached)
      });
      return {
        allowed: false,
        cached,
        reason: 'guest_blocked',
        retryAfterMs: null
      };
    }

    if (!skipCache) {
      const cached = getCachedResponse(feature, cacheKey);
      if (cached) {
        logEvent({
          actor, feature, endpoint, cacheKey,
          outcome: 'cache_hit',
          cached: true
        });
        return { allowed: false, cached, reason: 'cache_hit', retryAfterMs: null };
      }
    }

    const cd = checkCooldown(actor.actorId, feature, cacheKey);
    if (!cd.ok) {
      const stale = getCachedResponse(feature, cacheKey);
      logEvent({
        actor, feature, endpoint, cacheKey,
        outcome: stale ? 'cooldown_cached' : 'denied',
        reason: 'cooldown',
        cached: Boolean(stale)
      });
      return {
        allowed: false,
        cached: stale,
        reason: 'cooldown',
        retryAfterMs: cd.retryAfterMs
      };
    }

    const rate = checkRateLimit(actor, feature);
    if (!rate.ok) {
      const stale = getCachedResponse(feature, cacheKey);
      logEvent({
        actor, feature, endpoint, cacheKey,
        outcome: stale ? 'rate_limit_cached' : 'denied',
        reason: rate.reason,
        cached: Boolean(stale)
      });
      return {
        allowed: false,
        cached: stale,
        reason: rate.reason,
        retryAfterMs: null
      };
    }

    return { allowed: true, cached: null, reason: null, retryAfterMs: null };
  }

  /**
   * Обёртка над реальным вызовом OpenAI.
   */
  async function governedCall(apiKey, {
    actor,
    feature,
    cacheKey,
    messages,
    skipCache = false,
    endpoint,
    callOpenAI
  }) {
    if (!apiKey) {
      logEvent({ actor, feature, endpoint, cacheKey, outcome: 'denied', reason: 'no_key' });
      throw new AiGovernanceError('no_key', 'OpenAI API key not configured');
    }

    const check = preflight({ actor, feature, cacheKey, skipCache, endpoint });
    if (!check.allowed) {
      if (check.cached) return check.cached;
      if (check.reason === 'guest_blocked') {
        throw new AiGovernanceError('guest_blocked', 'AI недоступен для гостей', {
          retryAfterMs: check.retryAfterMs
        });
      }
      if (check.reason === 'cooldown') {
        throw new AiGovernanceError('cooldown', 'Можно обновить позже', {
          retryAfterMs: check.retryAfterMs
        });
      }
      if (check.reason === 'rate_limit_hour' || check.reason === 'rate_limit_day') {
        throw new AiGovernanceError('rate_limit', 'Превышен лимит AI-запросов', {
          retryAfterMs: check.retryAfterMs
        });
      }
      if (check.reason === 'cache_hit' && check.cached) return check.cached;
    }

    touchCooldown(actor.actorId, feature, cacheKey);
    bumpRate(actor.actorId, feature);

    try {
      const message = await callOpenAI(apiKey, messages);
      setCachedResponse(feature, cacheKey, message);
      logEvent({
        actor, feature, endpoint, cacheKey,
        outcome: 'cache_miss',
        cached: false
      });
      return message;
    } catch (err) {
      logEvent({
        actor, feature, endpoint, cacheKey,
        outcome: 'error',
        reason: err?.governanceCode || err?.message || 'openai_error'
      });
      throw err;
    }
  }

  /** Только проверка лимита (для aiValidator и т.п.) без полного кэша ответа. */
  function assertAllowed({ actor, feature, cacheKey, endpoint }) {
    const check = preflight({ actor, feature, cacheKey, skipCache: true, endpoint });
    if (!check.allowed && !check.cached) {
      if (check.reason === 'guest_blocked') {
        throw new AiGovernanceError('guest_blocked', 'AI недоступен для гостей');
      }
      if (check.reason === 'cooldown') {
        throw new AiGovernanceError('cooldown', 'Можно обновить позже', {
          retryAfterMs: check.retryAfterMs
        });
      }
      if (check.reason === 'rate_limit_hour' || check.reason === 'rate_limit_day') {
        throw new AiGovernanceError('rate_limit', 'Превышен лимит AI-запросов');
      }
    }
    if (!check.allowed && check.cached) return { fromCache: true, data: check.cached };
    return { fromCache: false, data: null };
  }

  function hashCacheKey(...parts) {
    return stableHash(parts.filter((p) => p != null && p !== '').join('::'));
  }

  function invalidateFeaturePrefix(feature, prefix) {
    const c = loadResponseCache();
    const needle = `${feature}::${prefix}`;
    let changed = false;
    for (const k of Object.keys(c)) {
      if (k.startsWith(needle)) {
        delete c[k];
        changed = true;
      }
    }
    if (changed) flushResponseCache();
  }

  function recordAiUsage(actor, feature, cacheKey) {
    touchCooldown(actor.actorId, feature, cacheKey);
    bumpRate(actor.actorId, feature);
  }

  return {
    AI_FEATURES,
    buildActor,
    getClientIp,
    getCachedResponse,
    setCachedResponse,
    governedCall,
    preflight,
    assertAllowed,
    recordAiUsage,
    hashCacheKey,
    invalidateFeaturePrefix,
    logEvent
  };
}
