/* ===================================================================
   services/videoFeedback.js — пользовательские оценки источников видео
   Хранение в data/video_feedback.json, байесовский рейтинг источников.
   =================================================================== */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FEEDBACK_FILE = path.join(DATA_DIR, 'video_feedback.json');
const BACKUP_FILE = path.join(DATA_DIR, 'video_feedback.json.bak');

const DEFAULT_SOURCES = ['youtube', 'rutube', 'vk', 'dailymotion', 'hdrezka'];
const PRIOR_ALPHA = 2;
const PRIOR_BETA = 2;

let feedback = null;
let loaded = false;
let writing = false;
let writeQueued = false;

const ensureDataDirs = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FEEDBACK_FILE)) fs.writeFileSync(FEEDBACK_FILE, '[]');
};

const loadFeedback = () => {
  if (loaded) return feedback;
  ensureDataDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8') || '[]');
    feedback = Array.isArray(raw) ? raw : [];
  } catch {
    feedback = [];
  }
  loaded = true;
  return feedback;
};

const writeFeedbackToDisk = () => {
  if (writing) {
    writeQueued = true;
    return;
  }
  writing = true;
  try {
    ensureDataDirs();
    if (fs.existsSync(FEEDBACK_FILE)) {
      try { fs.copyFileSync(FEEDBACK_FILE, BACKUP_FILE); } catch { /* ignore */ }
    }
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedback || [], null, 2));
  } finally {
    writing = false;
    if (writeQueued) {
      writeQueued = false;
      writeFeedbackToDisk();
    }
  }
};

const normalizeSource = (source) => String(source || '').trim().toLowerCase();

/**
 * Байесовская оценка доли положительных (Laplace smoothing).
 */
export function bayesianScore(up, down) {
  const u = Math.max(0, Number(up) || 0);
  const d = Math.max(0, Number(down) || 0);
  return (u + PRIOR_ALPHA) / (u + d + PRIOR_ALPHA + PRIOR_BETA);
}

export function getSourceRatings() {
  const items = loadFeedback();
  const tallies = {};

  for (const src of DEFAULT_SOURCES) {
    tallies[src] = { up: 0, down: 0 };
  }

  for (const row of items) {
    const src = normalizeSource(row.source);
    if (!src) continue;
    if (!tallies[src]) tallies[src] = { up: 0, down: 0 };
    if (row.rating === 'up') tallies[src].up += 1;
    else if (row.rating === 'down') tallies[src].down += 1;
  }

  const ratings = {};
  for (const [src, { up, down }] of Object.entries(tallies)) {
    const total = up + down;
    const score = bayesianScore(up, down);
    const percent = total > 0 ? Math.round((up / total) * 100) : null;
    const weight = total > 0 ? (up - down) / total : 0;
    ratings[src] = { up, down, total, score, percent, weight };
  }
  return ratings;
}

/**
 * Порядок источников по накопленному рейтингу (с сохранением дефолта при равенстве).
 */
export function getSourcePriorityOrder() {
  const ratings = getSourceRatings();
  return [...DEFAULT_SOURCES].sort((a, b) => {
    const diff = (ratings[b]?.score || 0) - (ratings[a]?.score || 0);
    if (Math.abs(diff) < 0.0001) {
      return DEFAULT_SOURCES.indexOf(a) - DEFAULT_SOURCES.indexOf(b);
    }
    return diff;
  });
}

export function getSourceRating(source) {
  const ratings = getSourceRatings();
  const src = normalizeSource(source);
  return ratings[src] || { up: 0, down: 0, total: 0, score: bayesianScore(0, 0), percent: null, weight: 0 };
}

export function recordVideoFeedback({ tmdbId, source, videoUrl, rating }) {
  const src = normalizeSource(source);
  const r = rating === 'down' ? 'down' : (rating === 'up' ? 'up' : null);
  if (!src || !r) return { ok: false, error: 'invalid payload' };

  const items = loadFeedback();
  items.push({
    tmdbId: tmdbId != null ? String(tmdbId) : null,
    source: src,
    videoUrl: String(videoUrl || '').slice(0, 500),
    rating: r,
    at: Date.now()
  });

  if (items.length > 10000) {
    feedback = items.slice(-10000);
  }

  writeFeedbackToDisk();
  return { ok: true, rating: getSourceRating(src) };
}
