/* ===================================================================
   anubisBypass.js — обход PoW-защиты Anubis на зеркалах HDRezka.
   Cookie techaro.lol-anubis-auth действует ~7 дней на хост.
   =================================================================== */
import crypto from 'crypto';

const cookieJars = new Map();

function hostKey(urlOrBase) {
  try {
    const u = new URL(urlOrBase.startsWith('http') ? urlOrBase : `https://${urlOrBase}`);
    return u.hostname;
  } catch {
    return String(urlOrBase || '').toLowerCase();
  }
}

function getJar(host) {
  if (!cookieJars.has(host)) cookieJars.set(host, new Map());
  return cookieJars.get(host);
}

function parseSetCookies(headers) {
  const raw = headers?.getSetCookie?.() || [];
  const out = [];
  for (const line of raw) {
    const part = line.split(';')[0];
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (line.includes('Max-Age=0')) {
      out.push({ name, value: null });
    } else {
      out.push({ name, value });
    }
  }
  return out;
}

function applyCookies(host, cookies) {
  const jar = getJar(host);
  for (const { name, value } of cookies) {
    if (value == null) jar.delete(name);
    else jar.set(name, value);
  }
}

export function getCookieHeader(urlOrBase) {
  const host = hostKey(urlOrBase);
  const jar = getJar(host);
  if (!jar.size) return '';
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function isAnubisChallenge(html) {
  return Boolean(html && (/id="anubis_challenge"/i.test(html) || /Проверяем, что вы не бот/i.test(html)));
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function meetsDifficulty(digest, difficulty) {
  const fullBytes = Math.floor(difficulty / 2);
  const half = difficulty % 2 !== 0;
  for (let i = 0; i < fullBytes; i++) {
    if (digest[i] !== 0) return false;
  }
  if (half && (digest[fullBytes] >> 4) !== 0) return false;
  return true;
}

function solveFastChallenge(randomData, difficulty) {
  for (let nonce = 0; nonce < 10_000_000; nonce++) {
    const digest = crypto.createHash('sha256').update(randomData + String(nonce)).digest();
    if (meetsDifficulty(digest, difficulty)) {
      return { hash: digest.toString('hex'), nonce };
    }
  }
  return null;
}

function parseChallenge(html) {
  const raw = html.match(/<script id="anubis_challenge"[^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const challenge = data?.challenge;
    const rules = data?.rules;
    if (!challenge?.id || !challenge?.randomData || !rules?.difficulty) return null;
    return {
      id: challenge.id,
      randomData: challenge.randomData,
      difficulty: Number(rules.difficulty) || 2,
      algorithm: rules.algorithm || 'fast'
    };
  } catch {
    return null;
  }
}

async function passChallenge(base, challenge, solved, redir, cookieHeader) {
  const passUrl = new URL(`${base}/.within.website/x/cmd/anubis/api/pass-challenge`);
  passUrl.searchParams.set('id', challenge.id);
  passUrl.searchParams.set('response', solved.hash);
  passUrl.searchParams.set('nonce', String(solved.nonce));
  passUrl.searchParams.set('redir', redir);
  passUrl.searchParams.set('elapsedTime', '250');

  const res = await fetch(passUrl, {
    headers: {
      'User-Agent': DEFAULT_UA,
      Cookie: cookieHeader
    },
    redirect: 'manual'
  });

  applyCookies(hostKey(base), parseSetCookies(res.headers));
  return res.status === 302 || res.status === 200;
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Решает Anubis и сохраняет cookie для хоста. Возвращает true при успехе.
 */
export async function ensureAnubisAccess(base, pageUrl, html, cookieHeader = '') {
  if (!isAnubisChallenge(html)) return true;

  const challenge = parseChallenge(html);
  if (!challenge) return false;

  if (challenge.algorithm !== 'fast') {
    console.warn('[anubis] unsupported algorithm:', challenge.algorithm);
    return false;
  }

  const solved = solveFastChallenge(challenge.randomData, challenge.difficulty);
  if (!solved) {
    console.warn('[anubis] PoW solve failed');
    return false;
  }

  const ok = await passChallenge(base, challenge, solved, pageUrl, cookieHeader);
  if (!ok) console.warn('[anubis] pass-challenge failed');
  return ok;
}

/**
 * fetch с cookie-jar и однократным обходом Anubis при challenge-странице.
 */
export async function hdrezkaFetch(url, options = {}) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const base = `${parsed.protocol}//${parsed.host}`;
  const headers = {
    'User-Agent': DEFAULT_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    ...(options.headers || {})
  };

  const cookie = getCookieHeader(host);
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, { ...options, headers });
  applyCookies(host, parseSetCookies(res.headers));

  const contentType = res.headers.get('content-type') || '';
  const isText = !contentType || /text|json|javascript|xml/i.test(contentType);
  if (!isText) return res;

  const text = await res.text();
  if (!isAnubisChallenge(text)) {
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  const refreshedCookie = getCookieHeader(host);
  const bypassed = await ensureAnubisAccess(base, url, text, refreshedCookie);
  if (!bypassed) {
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  const retryHeaders = { ...headers, Cookie: getCookieHeader(host) };
  return fetch(url, { ...options, headers: retryHeaders });
}