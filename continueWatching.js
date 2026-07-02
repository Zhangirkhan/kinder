/* ===================================================================
   continueWatching.js — блок «Хотите досмотреть?» на главной.
   =================================================================== */
(function () {
  'use strict';

  const root = document.getElementById('continue-watching-section');
  if (!root) return;

  const listEl = root.querySelector('#continue-watching-list');

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

  function progressLabel(entry) {
    const pct = entry.progress?.percent || 0;
    if (entry.mediaType === 'tv' && entry.season != null && entry.episode != null) {
      return tt('viewing.progressEpisode', 'с.{season} э.{episode} · {percent}%', {
        season: entry.season,
        episode: entry.episode,
        percent: pct
      });
    }
    return tt('viewing.progressPercent', '{percent}%', { percent: pct });
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

  async function refresh() {
    if (!listEl) return;
    await window.ViewingHistory?.init?.().catch(() => {});
    const items = window.ViewingHistory?.getContinueWatching?.(12) || [];

    if (!items.length) {
      root.hidden = true;
      listEl.innerHTML = '';
      return;
    }

    root.hidden = false;
    listEl.innerHTML = items.map(renderCard).join('');
  }

  window.refreshContinueWatching = refresh;

  document.addEventListener('viewing-history:change', refresh);
  document.addEventListener('i18n:change', refresh);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { refresh(); });
  } else {
    refresh();
  }
})();
