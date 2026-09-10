/* ===================================================================
   torrentPlayer.js — торрент-плеер через серверный стриминг.
   Сервер качает раздачу (DHT/трекеры) и отдаёт видео по HTTP Range;
   браузерный WebTorrent с обычными торрентами пиров не находит.
   =================================================================== */
(function (global) {
  const POLL_MS = 500;
  const START_TIMEOUT_MS = 90000;
  const MIN_PLAY_PROGRESS = 0.008;

  let activeState = null;
  let progressTimer = null;
  let streamId = null;

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

  function clearTimers() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  async function destroyActive() {
    clearTimers();
    if (streamId) {
      const id = streamId;
      streamId = null;
      try {
        await fetch(`/api/torrents/stream/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: activeState?.authHeaders || {}
        });
      } catch { /* ignore */ }
    }
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
          <p class="torrent-player__progress-text"></p>
        </div>
        <video class="torrent-player__video" controls playsinline></video>
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

  function updateProgress(ui, status) {
    const percent = Math.min(100, Math.max(0, (status.progress || 0) * 100));
    const peers = status.numPeers || 0;
    const speed = formatBytes(status.downloadSpeed) + '/s';
    ui.progressText.textContent = t(
      'movie.torrentStreamProgress',
      'Загрузка {percent}% · {speed} · пиров: {peers}',
      { percent: percent.toFixed(1), speed, peers }
    );
  }

  async function startServerStream(magnet, torrentUrl, authHeaders) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), START_TIMEOUT_MS);
    try {
      const res = await fetch('/api/torrents/stream', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(authHeaders || {})
        },
        body: JSON.stringify({
          magnet: magnet || null,
          torrentUrl: torrentUrl || null
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'stream start failed');
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function waitForStreamReady(id, authHeaders, ui) {
    const started = Date.now();
    while (Date.now() - started < START_TIMEOUT_MS) {
      const res = await fetch(`/api/torrents/stream/${encodeURIComponent(id)}/status`, {
        headers: authHeaders || {}
      });
      if (!res.ok) throw new Error('status failed');
      const status = await res.json().catch(() => ({}));
      if (status.ready) {
        if (status.stalled || (status.numPeers === 0 && status.progress < MIN_PLAY_PROGRESS)) {
          throw new Error('no peers');
        }
        return status;
      }
      updateProgress(ui, status);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error('buffer timeout');
  }

  function attachPlayback(ui, id, authHeaders, streamInfo) {
    const src = `/api/torrents/stream/${encodeURIComponent(id)}`;
    const fileLength = Number(streamInfo?.length) || 1;
    let fileDownloaded = Number(streamInfo?.fileDownloaded) || 0;
    let lastGoodTime = 0;
    let seeking = false;
    let errorTimer = null;

    ui.status.hidden = true;
    ui.video.hidden = false;
    ui.error.hidden = true;
    ui.video.src = src;
    ui.video.load();
    ui.video.play().catch(() => { /* autoplay may be blocked */ });

    progressTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/torrents/stream/${encodeURIComponent(id)}/status`, {
          headers: authHeaders || {}
        });
        if (!res.ok) return;
        const status = await res.json().catch(() => null);
        if (!status) return;
        fileDownloaded = Number(status.fileDownloaded) || fileDownloaded;
        if (ui.status.hidden === false || seeking) {
          updateProgress(ui, status);
        }
      } catch { /* ignore */ }
    }, POLL_MS);

    const showBuffering = (messageKey, fallback) => {
      seeking = true;
      ui.status.hidden = false;
      ui.progressText.textContent = t(messageKey, fallback);
    };

    const hideBuffering = () => {
      if (!seeking) return;
      seeking = false;
      if (!ui.error.hidden) return;
      ui.status.hidden = true;
    };

    ui.video.addEventListener('timeupdate', () => {
      if (!ui.video.seeking && ui.video.readyState >= 2) {
        lastGoodTime = ui.video.currentTime;
      }
    });

    ui.video.addEventListener('seeking', () => {
      if (errorTimer) {
        clearTimeout(errorTimer);
        errorTimer = null;
      }
      showBuffering('movie.torrentStreamBuffering', 'Буферизация после перемотки…');
    });

    ui.video.addEventListener('seeked', hideBuffering);
    ui.video.addEventListener('waiting', () => {
      showBuffering('movie.torrentStreamBuffering', 'Буферизация после перемотки…');
    });
    ui.video.addEventListener('playing', hideBuffering);
    ui.video.addEventListener('canplay', hideBuffering);

    ui.video.addEventListener('error', () => {
      if (errorTimer) clearTimeout(errorTimer);
      errorTimer = setTimeout(() => {
        const errCode = ui.video.error?.code;
        if (seeking) {
          showError(
            ui,
            'movie.torrentStreamSeekError',
            'Не удалось перемотать — дождитесь загрузки этой части или выберите MP4-раздачу'
          );
          return;
        }
        showError(ui, 'movie.torrentStreamPlayError', 'Не удалось воспроизвести видео');
      }, 3000);
    });
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

    await destroyActive();
    activeState = { panelEl, listHtml, magnet, torrentUrl, title, authHeaders, onMagnetFallback };
    const ui = buildPlayerUi(panelEl, title || t('movie.watchTorrent', '▶ Смотреть'));

    ui.backBtn.addEventListener('click', async () => {
      await destroyActive();
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
      const info = await startServerStream(magnet, torrentUrl, authHeaders);
      if (!info?.id) throw new Error('no stream id');
      streamId = info.id;
      updateProgress(ui, info);
      const ready = await waitForStreamReady(info.id, authHeaders, ui);
      attachPlayback(ui, info.id, authHeaders, ready);
      return true;
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg === 'no peers') {
        showError(ui, 'movie.torrentStreamNoPeers', 'Нет пиров — торрент не скачивается');
      } else if (msg.includes('mkv')) {
        showError(ui, 'movie.torrentStreamMkvSeek', 'MKV не поддерживает онлайн-просмотр — скачайте торрент');
      } else {
        showError(ui, 'movie.torrentStreamError', 'Ошибка загрузки торрента');
      }
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

  // Оставлено для совместимости — серверный стриминг не требует WebRTC в браузере.
  function isWebRTCSupported() {
    return true;
  }

  global.TorrentPlayer = {
    open,
    destroy: destroyActive,
    isEnabled,
    isWebRTCSupported
  };
})(window);
