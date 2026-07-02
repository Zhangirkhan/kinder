/* ===================================================================
   torrentPlayer.js — встроенный WebTorrent-плеер для страницы фильма.
   Загружается лениво (вместе с webtorrent.min.js) при первом «Смотреть».
   =================================================================== */
(function (global) {
  const WEBTORRENT_CDN = 'https://cdn.jsdelivr.net/npm/webtorrent@2.5.3/webtorrent.min.js';
  const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];
  const NO_PEERS_TIMEOUT_MS = 45000;

  let webTorrentLoadPromise = null;
  let client = null;
  let activeTorrent = null;
  let progressTimer = null;
  let noPeersTimer = null;
  let activeState = null;

  function t(key, fallback, vars) {
    if (global.t) {
      const out = global.t(key, vars);
      if (out && out !== key) return out;
    }
    if (vars && typeof fallback === 'string') {
      return fallback.replace(/\{(\w+)\}/g, (m, name) =>
        vars[name] != null ? vars[name] : m);
    }
    return fallback || key;
  }

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isWebRTCSupported() {
    return Boolean(
      global.RTCPeerConnection
      || global.webkitRTCPeerConnection
      || global.mozRTCPeerConnection
    );
  }

  function formatBytes(n) {
    const num = Number(n) || 0;
    if (num < 1) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = num;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
  }

  function loadWebTorrentLib() {
    if (global.WebTorrent) return Promise.resolve(global.WebTorrent);
    if (webTorrentLoadPromise) return webTorrentLoadPromise;
    webTorrentLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = WEBTORRENT_CDN;
      script.async = true;
      script.onload = () => {
        if (global.WebTorrent) resolve(global.WebTorrent);
        else reject(new Error('WebTorrent not available'));
      };
      script.onerror = () => reject(new Error('WebTorrent load failed'));
      document.head.appendChild(script);
    });
    return webTorrentLoadPromise;
  }

  function clearTimers() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    if (noPeersTimer) {
      clearTimeout(noPeersTimer);
      noPeersTimer = null;
    }
  }

  function destroyActive() {
    clearTimers();
    if (activeTorrent) {
      try { activeTorrent.destroy(); } catch { /* ignore */ }
      activeTorrent = null;
    }
    if (client) {
      try { client.destroy(); } catch { /* ignore */ }
      client = null;
    }
  }

  function pickVideoFile(torrent) {
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
  }

  function updateProgress(ui, torrent) {
    const percent = Math.min(100, Math.max(0, torrent.progress * 100));
    const peers = torrent.numPeers || 0;
    const speed = formatBytes(torrent.downloadSpeed) + '/s';
    ui.progressText.textContent = t(
      'movie.torrentStreamProgress',
      'Загрузка {percent}% · {speed} · пиров: {peers}',
      { percent: percent.toFixed(1), speed, peers }
    );
  }

  function showError(ui, messageKey, fallback) {
    ui.status.hidden = true;
    ui.video.hidden = true;
    ui.error.hidden = false;
    ui.errorMsg.textContent = t(messageKey, fallback);
  }

  function showLoading(ui) {
    ui.status.hidden = false;
    ui.video.hidden = true;
    ui.error.hidden = true;
    ui.progressText.textContent = t('movie.torrentStreamConnecting', 'Подключение к раздаче…');
  }

  function buildPlayerUi(container, title) {
    container.innerHTML = `
      <div class="torrent-player" role="region" aria-label="${esc(t('movie.torrentPlayer', 'Торрент-плеер'))}">
        <div class="torrent-player__header">
          <button type="button" class="torrent-player__back">${esc(t('movie.torrentBackToList', '← Назад к списку'))}</button>
          <p class="torrent-player__title">${esc(title)}</p>
        </div>
        <div class="torrent-player__status">
          <span class="loading-ui__spinner torrent-player__spinner" aria-hidden="true"></span>
          <p class="torrent-player__progress-text"></p>
        </div>
        <video class="torrent-player__video" controls playsinline autoplay></video>
        <div class="torrent-player__error" hidden>
          <p class="torrent-player__error-msg"></p>
          <div class="torrent-player__error-actions">
            <button type="button" class="torrent-player__retry">${esc(t('movie.torrentStreamRetry', 'Повторить'))}</button>
            <button type="button" class="torrent-player__magnet">${esc(t('movie.torrentOpenClient', 'Открыть в клиенте'))}</button>
          </div>
        </div>
      </div>`;

    return {
      root: container.querySelector('.torrent-player'),
      status: container.querySelector('.torrent-player__status'),
      progressText: container.querySelector('.torrent-player__progress-text'),
      video: container.querySelector('.torrent-player__video'),
      error: container.querySelector('.torrent-player__error'),
      errorMsg: container.querySelector('.torrent-player__error-msg'),
      backBtn: container.querySelector('.torrent-player__back'),
      retryBtn: container.querySelector('.torrent-player__retry'),
      magnetBtn: container.querySelector('.torrent-player__magnet')
    };
  }

  async function fetchTorrentBuffer(torrentUrl, authHeaders) {
    const res = await fetch(
      `/api/torrents/download?url=${encodeURIComponent(torrentUrl)}`,
      { headers: authHeaders || {} }
    );
    if (!res.ok) throw new Error('torrent download failed');
    return res.arrayBuffer();
  }

  function startPlayback(ui, torrent, file) {
    ui.status.hidden = true;
    ui.video.hidden = false;
    ui.error.hidden = true;
    file.renderTo(ui.video, { autoplay: true }, (err) => {
      if (err) showError(ui, 'movie.torrentStreamPlayError', 'Не удалось воспроизвести видео');
    });
    ui.video.play().catch(() => { /* autoplay may be blocked */ });
  }

  function attachTorrentHandlers(ui, torrent, opts) {
    activeTorrent = torrent;

    torrent.on('download', () => updateProgress(ui, torrent));
    torrent.on('wire', () => updateProgress(ui, torrent));

    torrent.on('ready', () => {
      clearTimeout(noPeersTimer);
      const file = pickVideoFile(torrent);
      if (!file) {
        showError(ui, 'movie.torrentStreamNoVideo', 'В торренте не найден видеофайл');
        return;
      }
      startPlayback(ui, torrent, file);
    });

    torrent.on('error', () => {
      showError(ui, 'movie.torrentStreamError', 'Ошибка загрузки торрента');
    });

    progressTimer = setInterval(() => {
      if (activeTorrent) updateProgress(ui, activeTorrent);
    }, 1000);

    noPeersTimer = setTimeout(() => {
      if (!activeTorrent || activeTorrent.destroyed) return;
      if (activeTorrent.numPeers === 0 && activeTorrent.progress < 0.01) {
        showError(ui, 'movie.torrentStreamNoPeers', 'Нет пиров — торрент не скачивается');
      }
    }, NO_PEERS_TIMEOUT_MS);
  }

  async function addTorrent(magnet, torrentUrl, authHeaders) {
    const WebTorrent = await loadWebTorrentLib();
    destroyActive();
    client = new WebTorrent();

    const addSource = (source) => new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err || new Error('add failed'));
      };
      const timer = setTimeout(() => fail(new Error('timeout')), NO_PEERS_TIMEOUT_MS);
      try {
        client.add(source, (torrent) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!torrent) fail();
          else resolve(torrent);
        });
      } catch (err) {
        clearTimeout(timer);
        fail(err);
      }
      client.once('error', (err) => {
        clearTimeout(timer);
        fail(err);
      });
    });

    if (magnet) return addSource(magnet);

    if (torrentUrl) {
      const buffer = await fetchTorrentBuffer(torrentUrl, authHeaders);
      return addSource(buffer);
    }

    throw new Error('no source');
  }

  async function open(opts) {
    const {
      panelEl,
      listHtml,
      magnet,
      torrentUrl,
      title,
      authHeaders,
      onMagnetFallback
    } = opts;

    if (!panelEl) return false;

    if (!isWebRTCSupported()) {
      if (onMagnetFallback) onMagnetFallback(magnet);
      return false;
    }

    activeState = { panelEl, listHtml, magnet, torrentUrl, title, authHeaders, onMagnetFallback };
    const ui = buildPlayerUi(panelEl, title || t('movie.watchTorrent', '▶ Смотреть'));

    ui.backBtn.addEventListener('click', () => {
      destroyActive();
      panelEl.innerHTML = listHtml;
      if (opts.onBack) opts.onBack(panelEl);
    });

    ui.retryBtn.addEventListener('click', () => {
      open(opts);
    });

    ui.magnetBtn.addEventListener('click', () => {
      if (onMagnetFallback && magnet) onMagnetFallback(magnet);
    });
    if (!magnet) ui.magnetBtn.hidden = true;

    showLoading(ui);

    try {
      await loadWebTorrentLib();
      const torrent = await addTorrent(magnet, torrentUrl, authHeaders);
      attachTorrentHandlers(ui, torrent, opts);
      updateProgress(ui, torrent);
      return true;
    } catch {
      showError(ui, 'movie.torrentStreamError', 'Ошибка загрузки торрента');
      return false;
    }
  }

  let enabledCache = null;

  async function isEnabled() {
    if (enabledCache !== null) return enabledCache;
    try {
      const res = await fetch('/api/config');
      const data = await res.json().catch(() => ({}));
      enabledCache = data.webtorrentEnabled !== false;
    } catch {
      enabledCache = true;
    }
    return enabledCache;
  }

  global.TorrentPlayer = {
    open,
    destroy: destroyActive,
    isEnabled,
    isWebRTCSupported
  };
})(window);
