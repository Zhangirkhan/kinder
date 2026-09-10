/* ===================================================================
   services/torrentStream.js — серверный стриминг торрентов (WebTorrent).
   Браузерный WebTorrent не находит пиров у обычных раздач; сервер
   подключается к DHT/трекерам и отдаёт видео по HTTP с Range.
   =================================================================== */

import crypto from 'crypto';

const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];
const STREAM_TTL_MS = 2 * 60 * 60 * 1000; // 2 часа
const ADD_TIMEOUT_MS = Number(process.env.TORRENT_ADD_TIMEOUT_MS) || 120000;
const MAX_ACTIVE = Number(process.env.TORRENT_MAX_ACTIVE) || 6;
const MIN_READY_PROGRESS = Number(process.env.TORRENT_MIN_READY_PROGRESS) || 0.008;
const MIN_READY_BYTES = Number(process.env.TORRENT_MIN_READY_BYTES) || 1536 * 1024;
const RANGE_WAIT_MS = Number(process.env.TORRENT_RANGE_WAIT_MS) || 60000;
const HEAD_BUFFER_BYTES = Number(process.env.TORRENT_HEAD_BUFFER_BYTES) || 1024 * 1024;
const TAIL_BUFFER_BYTES = Number(process.env.TORRENT_TAIL_BUFFER_BYTES) || 8 * 1024 * 1024;
const TAIL_WAIT_MS = Number(process.env.TORRENT_TAIL_WAIT_MS) || 8000;

const TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.webtorrent.dev',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce'
];

let WebTorrentCtor = null;
let client = null;
const streams = new Map();

const loadWebTorrent = async () => {
  if (WebTorrentCtor) return WebTorrentCtor;
  const mod = await import('webtorrent');
  WebTorrentCtor = mod.default || mod;
  return WebTorrentCtor;
};

const getClient = async () => {
  if (client) return client;
  const WebTorrent = await loadWebTorrent();
  client = new WebTorrent({ maxConns: 80, dht: true });
  return client;
};

const pickVideoFile = (torrent) => {
  const candidates = torrent.files.filter((file) => {
    const name = file.name.toLowerCase();
    return VIDEO_EXTS.some((ext) => name.endsWith(ext));
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const aMp4 = a.name.toLowerCase().endsWith('.mp4') ? 1 : 0;
    const bMp4 = b.name.toLowerCase().endsWith('.mp4') ? 1 : 0;
    if (aMp4 !== bMp4) return bMp4 - aMp4;
    return b.length - a.length;
  });
  return candidates[0];
};

const cleanupOld = () => {
  const now = Date.now();
  for (const [id, entry] of streams) {
    if (now - entry.createdAt > STREAM_TTL_MS) destroyStream(id);
  }
  while (streams.size > MAX_ACTIVE) {
    const oldest = [...streams.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) destroyStream(oldest[0]);
    else break;
  }
};

export function destroyStream(id) {
  const entry = streams.get(id);
  if (!entry) return;
  try { entry.torrent?.destroy?.(); } catch { /* ignore */ }
  streams.delete(id);
}

export function getStreamStatus(id) {
  const entry = streams.get(id);
  if (!entry) return null;
  const { torrent, file } = entry;
  const name = file?.name || '';
  const lower = name.toLowerCase();
  return {
    id,
    name,
    format: lower.endsWith('.mkv') ? 'mkv'
      : (lower.endsWith('.webm') ? 'webm' : 'mp4'),
    seekable: !lower.endsWith('.mkv'),
    progress: torrent?.progress || 0,
    fileProgress: file?.progress || 0,
    fileDownloaded: file?.downloaded || 0,
    downloadSpeed: torrent?.downloadSpeed || 0,
    numPeers: torrent?.numPeers || 0,
    length: file?.length || 0,
    ready: Boolean(entry.ready),
    stalled: Boolean(entry.stalled)
  };
}

function pieceRangeForBytes(torrent, file, start, end) {
  const pieceLength = torrent.pieceLength || 0;
  if (!pieceLength) return { startPiece: 0, endPiece: 0 };
  const absStart = Math.max(0, start + (file.offset || 0));
  const absEnd = Math.max(absStart, end + (file.offset || 0));
  return {
    startPiece: Math.floor(absStart / pieceLength),
    endPiece: Math.floor(absEnd / pieceLength)
  };
}

function rangeIsDownloaded(torrent, startPiece, endPiece) {
  if (!torrent.bitfield) return false;
  for (let i = startPiece; i <= endPiece; i += 1) {
    if (!torrent.bitfield.get(i)) return false;
  }
  return true;
}

function isHeadBuffered(torrent, file) {
  const end = Math.min(file.length - 1, HEAD_BUFFER_BYTES - 1);
  const { startPiece, endPiece } = pieceRangeForBytes(torrent, file, 0, end);
  return rangeIsDownloaded(torrent, startPiece, endPiece);
}

function isTailBuffered(torrent, file) {
  const start = Math.max(0, file.length - TAIL_BUFFER_BYTES);
  const { startPiece, endPiece } = pieceRangeForBytes(torrent, file, start, file.length - 1);
  return rangeIsDownloaded(torrent, startPiece, endPiece);
}

function prioritizePlaybackLayout(torrent, file) {
  const total = file.length;
  const name = file.name.toLowerCase();
  prioritizeByteRange(torrent, file, 0, Math.min(total - 1, HEAD_BUFFER_BYTES - 1));
  if (name.endsWith('.mp4') || name.endsWith('.m4v') || name.endsWith('.mov') || name.endsWith('.mkv')) {
    const tailStart = Math.max(0, total - TAIL_BUFFER_BYTES);
    prioritizeByteRange(torrent, file, tailStart, total - 1);
  }
}

function waitForByteRange(torrent, file, start, end, timeoutMs = RANGE_WAIT_MS, isAborted = () => false) {
  const { startPiece, endPiece } = pieceRangeForBytes(torrent, file, start, end);
  prioritizeByteRange(torrent, file, start, end);

  return new Promise((resolve, reject) => {
    const finish = (err) => {
      clearInterval(poll);
      torrent.off('verified', onVerified);
      if (err) reject(err);
      else resolve();
    };
    const check = () => {
      if (isAborted()) return finish(new Error('aborted'));
      if (torrent.destroyed) return finish(new Error('torrent destroyed'));
      if (rangeIsDownloaded(torrent, startPiece, endPiece)) return finish();
      if (Date.now() >= deadline) return finish(new Error('range timeout'));
    };
    const onVerified = (index) => {
      if (index >= startPiece && index <= endPiece) check();
    };
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(check, 200);
    torrent.on('verified', onVerified);
    check();
  });
}

function markReadyWhenBuffered(entry) {
  const { torrent, file } = entry;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const finish = (stalled = false) => {
      entry.ready = true;
      entry.stalled = stalled;
      resolve();
    };
    const check = () => {
      const headOk = isHeadBuffered(torrent, file);
      const name = file.name.toLowerCase();
      const needsTail = name.endsWith('.mp4') || name.endsWith('.m4v') || name.endsWith('.mov');
      const tailOk = !needsTail || isTailBuffered(torrent, file) || Date.now() - startedAt > TAIL_WAIT_MS;
      const fileDl = file.downloaded || 0;
      const active = torrent.numPeers > 0 && torrent.downloadSpeed > 0;
      const enough = headOk
        || fileDl >= MIN_READY_BYTES
        || torrent.progress >= MIN_READY_PROGRESS
        || (active && fileDl >= 384 * 1024);
      if (tailOk && enough) {
        clearInterval(poll);
        clearTimeout(timer);
        finish(false);
      }
    };
    const poll = setInterval(check, 500);
    const timer = setTimeout(() => {
      clearInterval(poll);
      const stalled = torrent.numPeers === 0
        && torrent.downloadSpeed === 0
        && !isHeadBuffered(torrent, file);
      finish(stalled);
    }, ADD_TIMEOUT_MS);
    torrent.on('download', check);
    torrent.on('verified', check);
    check();
  });
}

export async function startTorrentStream({ magnet, torrentBuffer } = {}) {
  if (!magnet && !torrentBuffer) throw new Error('no source');

  cleanupOld();

  const WebTorrent = await loadWebTorrent();
  const wt = await getClient();
  const id = crypto.randomUUID();

  const opts = { announce: TRACKERS };
  const source = magnet || torrentBuffer;

  const torrent = await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wt.removeListener('error', onClientError);
      reject(err || new Error('add failed'));
    };
    const onClientError = (err) => fail(err);
    const timer = setTimeout(() => fail(new Error('timeout')), ADD_TIMEOUT_MS);
    try {
      wt.add(source, opts, (t) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wt.removeListener('error', onClientError);
        if (!t) fail(new Error('empty torrent'));
        else resolve(t);
      });
    } catch (err) {
      fail(err);
    }
    wt.once('error', onClientError);
  });

  const file = pickVideoFile(torrent);
  if (!file) {
    try { torrent.destroy(); } catch { /* ignore */ }
    throw new Error('no video file');
  }
  if (file.name.toLowerCase().endsWith('.mkv')) {
    try { torrent.destroy(); } catch { /* ignore */ }
    throw new Error('mkv not streamable');
  }
  try { file.select(1); } catch { /* ignore */ }
  prioritizePlaybackLayout(torrent, file);

  const entry = {
    id,
    torrent,
    file,
    createdAt: Date.now(),
    ready: false,
    stalled: false
  };
  streams.set(id, entry);
  markReadyWhenBuffered(entry).catch(() => { /* ignore */ });

  return {
    id,
    name: file.name,
    length: file.length,
    progress: torrent.progress,
    numPeers: torrent.numPeers,
    ready: false
  };
}

function prioritizeByteRange(torrent, file, start, end) {
  try {
    const { startPiece, endPiece } = pieceRangeForBytes(torrent, file, start, end);
    torrent.critical(startPiece, endPiece);
  } catch { /* ignore */ }
}

function pipeReadStreamToResponse(req, res, stream) {
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    req.off('close', onAbort);
    req.off('aborted', onAbort);
    res.off('close', onAbort);
    res.off('error', onAbort);
    if (!stream.destroyed) stream.destroy();
  };
  const onAbort = () => cleanup();

  req.on('close', onAbort);
  req.on('aborted', onAbort);
  res.on('close', onAbort);
  res.on('error', onAbort);

  stream.on('error', (err) => {
    cleanup();
    if (!res.headersSent) {
      try { res.status(500).end(); } catch { /* ignore */ }
    } else if (!res.writableEnded) {
      try { res.destroy(); } catch { /* ignore */ }
    }
    if (process.env.RECOMMENDER_DEBUG === 'true') {
      console.error('[torrents] stream read error', err?.message);
    }
  });

  stream.pipe(res);
}

export async function pipeStreamToResponse(id, req, res) {
  const entry = streams.get(id);
  if (!entry?.file) {
    res.status(404).json({ error: 'stream not found' });
    return;
  }

  const { torrent, file } = entry;
  try { file.select(1); } catch { /* ignore */ }

  const total = file.length;
  const range = req.headers.range;
  let start = 0;
  let chunkEnd = total - 1;
  let waitStart = 0;
  let waitEnd = Math.min(total - 1, HEAD_BUFFER_BYTES - 1);
  let aborted = false;
  const onAbort = () => { aborted = true; };
  req.on('close', onAbort);
  req.on('aborted', onAbort);

  try {
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      if (Number.isNaN(start) || start >= total) {
        res.status(416).end();
        return;
      }
      chunkEnd = Math.min(end, total - 1);
      waitStart = start;
      waitEnd = chunkEnd;
    }

    await waitForByteRange(torrent, file, waitStart, waitEnd, RANGE_WAIT_MS, () => aborted);
    if (aborted) return;
  } catch (err) {
    if (!res.headersSent) {
      if (err?.message === 'range timeout') {
        res.status(504).json({ error: 'range not ready' });
      } else if (err?.message !== 'aborted') {
        res.status(500).json({ error: 'stream failed' });
      }
    }
    return;
  } finally {
    req.off('close', onAbort);
    req.off('aborted', onAbort);
  }

  if (aborted) return;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', file.name.toLowerCase().endsWith('.mkv')
    ? 'video/x-matroska'
    : 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${chunkEnd}/${total}`);
    res.setHeader('Content-Length', chunkEnd - start + 1);
    pipeReadStreamToResponse(req, res, file.createReadStream({ start, end: chunkEnd }));
    return;
  }

  res.setHeader('Content-Length', total);
  pipeReadStreamToResponse(req, res, file.createReadStream());
}

setInterval(cleanupOld, 10 * 60 * 1000).unref();
