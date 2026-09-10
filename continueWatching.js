/* ===================================================================
   continueWatching.js — блок «Хотите досмотреть?» на главной.
   =================================================================== */
(function () {
  'use strict';

  const root = document.getElementById('continue-watching-section');
  if (!root) return;

  const listEl = root.querySelector('#continue-watching-list');
  const viewportEl = root.querySelector('#continue-watching-viewport');

  function esc(text) {
    return window.MovieDisplay?.escapeHtml(String(text ?? '')) || String(text ?? '');
  }

  function tt(key, fallback, vars) {
    return window.t ? window.t(key, vars) : fallback;
  }

  function posterSrc(url) {
    return window.MovieDisplay?.posterUrl(url) || url || '';
  }

  function movieHref(entry) {
    if (window.MovieDisplay?.moviePageUrl) {
      return window.MovieDisplay.moviePageUrl(entry);
    }
    const type = entry.mediaType === 'tv' ? 'tv' : 'movie';
    return `/movie.html?type=${type}&id=${encodeURIComponent(entry.tmdbId)}`;
  }

  function formatWatchedTime(seconds) {
    const sec = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function progressLabel(entry) {
    const time = formatWatchedTime(entry.progress?.positionSeconds || 0);
    if (entry.mediaType === 'tv' && entry.season != null && entry.episode != null) {
      return tt('viewing.progressEpisode', 'с.{season} э.{episode} · {time}', {
        season: entry.season,
        episode: entry.episode,
        time
      });
    }
    return time;
  }

  function renderCard(entry) {
    const poster = entry.poster
      ? `<img class="cw-card__poster" src="${esc(posterSrc(entry.poster))}" alt="" loading="lazy" decoding="async">`
      : '<span class="cw-card__poster cw-card__poster--empty" aria-hidden="true">🎬</span>';
    const year = entry.year ? `<span class="cw-card__year">${esc(entry.year)}</span>` : '';
    const pct = Math.max(2, Math.min(100, entry.progress?.percent || 0));

    return `
      <article class="cw-card">
        <a class="cw-card__link" href="${esc(movieHref(entry))}">
          ${poster}
          <div class="cw-card__progress" aria-hidden="true"><span style="width:${pct}%"></span></div>
        </a>
        <div class="cw-card__body">
          <a class="cw-card__title" href="${esc(movieHref(entry))}">${esc(entry.title)}</a>
          <div class="cw-card__meta">${year}<span class="cw-card__progress-label">${esc(progressLabel(entry))}</span></div>
          <a class="cw-card__btn" href="${esc(movieHref(entry))}">${esc(tt('viewing.continueBtn', 'Продолжить'))}</a>
        </div>
      </article>`;
  }

  function syncListLayout() {
    if (!viewportEl || !listEl) return;
    const overflows = listEl.scrollWidth > viewportEl.clientWidth + 2;
    viewportEl.classList.toggle('is-scrollable', overflows);
    viewportEl.classList.toggle('is-centered', !overflows);
  }

  async function refresh() {
    if (!listEl) return;
    await window.ViewingHistory?.init?.().catch(() => {});
    const items = window.ViewingHistory?.getContinueWatching?.(30) || [];

    if (!items.length) {
      root.hidden = true;
      listEl.innerHTML = '';
      window.appShellSyncContinueWatching?.();
      return;
    }

    root.hidden = false;
    listEl.innerHTML = items.map(renderCard).join('');
    requestAnimationFrame(function () {
      syncListLayout();
      window.appShellSyncContinueWatching?.();
    });
  }

  window.refreshContinueWatching = refresh;

  document.addEventListener('viewing-history:change', refresh);
  document.addEventListener('movie-list:change', refresh);
  document.addEventListener('i18n:change', refresh);
  window.addEventListener('resize', syncListLayout);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { refresh(); });
  } else {
    refresh();
  }
})();
