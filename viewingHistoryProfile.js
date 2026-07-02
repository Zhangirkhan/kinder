/* ===================================================================
   viewingHistoryProfile.js — таблица «История просмотра» в профиле.
   =================================================================== */
(function () {
  'use strict';

  const root = document.getElementById('viewing-history-section');
  const tableWrap = document.getElementById('viewing-history-table');
  if (!root || !tableWrap) return;

  function esc(text) {
    return window.MovieDisplay?.escapeHtml(String(text ?? '')) || String(text ?? '');
  }

  function tt(key, fallback, vars) {
    return window.t ? window.t(key, vars) : fallback;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      const lang = window.I18N?.getLang?.() || 'ru';
      const locale = lang === 'en' ? 'en-US' : lang === 'kk' ? 'kk-KZ' : 'ru-RU';
      return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return '—';
    }
  }

  function progressCell(entry) {
    const pct = entry.progress?.percent;
    if (pct == null) return '—';
    if (entry.mediaType === 'tv' && entry.season != null && entry.episode != null) {
      return esc(tt('viewing.progressEpisode', 'с.{season} э.{episode} · {percent}%', {
        season: entry.season,
        episode: entry.episode,
        percent: pct
      }));
    }
    return esc(tt('viewing.progressPercent', '{percent}%', { percent: pct }));
  }

  function movieHref(entry) {
    if (window.MovieDisplay?.moviePageUrl) return window.MovieDisplay.moviePageUrl(entry);
    const type = entry.mediaType === 'tv' ? 'tv' : 'movie';
    return `/movie.html?type=${type}&id=${encodeURIComponent(entry.tmdbId)}`;
  }

  async function refresh() {
    tableWrap.innerHTML = window.LoadingUI?.skeletonLines?.(5)
      || `<p>${esc(tt('common.loading', 'Загрузка…'))}</p>`;

    await window.ViewingHistory?.init?.().catch(() => {});
    const rows = window.ViewingHistory?.getAllHistory?.() || [];

    if (!rows.length) {
      tableWrap.innerHTML = `<p class="viewing-history-empty">${esc(tt('viewing.historyEmpty', 'Пока нет истории просмотра. Начните смотреть фильм на странице фильма.'))}</p>`;
      return;
    }

    const body = rows.map((entry) => {
      const type = window.ViewingHistory?.getContentType?.(entry) || 'movie';
      const typeLabel = window.ViewingHistory?.contentTypeLabel?.(type) || type;
      const statusLabel = window.ViewingHistory?.viewingStatusLabel?.(entry.viewingStatus) || entry.viewingStatus;
      const rating = entry.rating != null ? `${entry.rating}/10` : '—';

      return `
        <tr>
          <td class="vh-col-title"><a href="${esc(movieHref(entry))}">${esc(entry.title)}</a></td>
          <td data-label="${esc(tt('viewing.colType', 'Тип'))}">${esc(typeLabel)}</td>
          <td data-label="${esc(tt('viewing.colStatus', 'Статус'))}"><span class="vh-status vh-status--${esc(entry.viewingStatus)}">${esc(statusLabel)}</span></td>
          <td data-label="${esc(tt('viewing.colDate', 'Дата'))}">${esc(formatDate(entry.watchedAt || entry.lastActionAt))}</td>
          <td data-label="${esc(tt('viewing.colRating', 'Оценка'))}">${esc(rating)}</td>
          <td data-label="${esc(tt('viewing.colProgress', 'Прогресс'))}">${progressCell(entry)}</td>
        </tr>`;
    }).join('');

    tableWrap.innerHTML = `
      <div class="viewing-history-scroll">
        <table class="viewing-history-table">
          <thead>
            <tr>
              <th>${esc(tt('viewing.colTitle', 'Название'))}</th>
              <th>${esc(tt('viewing.colType', 'Тип'))}</th>
              <th>${esc(tt('viewing.colStatus', 'Статус'))}</th>
              <th>${esc(tt('viewing.colDate', 'Дата просмотра'))}</th>
              <th>${esc(tt('viewing.colRating', 'Оценка'))}</th>
              <th>${esc(tt('viewing.colProgress', 'Прогресс'))}</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  window.refreshViewingHistoryProfile = refresh;

  document.addEventListener('viewing-history:change', refresh);
  document.addEventListener('i18n:change', refresh);
})();
