/* ===================================================================
   movieRequestBlock.js — блок «Не нашли фильм?» с кнопками соцсетей.
   Используется в каталоге при пустом поиске и как компактная подсказка.
   =================================================================== */
(function () {
  'use strict';

  var INSTAGRAM_URL = 'https://www.instagram.com/tildanuk/';
  var THREADS_URL = 'https://www.threads.com/@tildanuk?xmt=AQG03hf9M4W98S__MgAbsn4O1ATmZqIs1o5yOiRgSwXuRys';

  var INSTAGRAM_ICON =
    '<svg class="movie-request-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<rect x="2.5" y="2.5" width="19" height="19" rx="5.5" stroke="currentColor" stroke-width="2"/>' +
      '<circle cx="12" cy="12" r="4.5" stroke="currentColor" stroke-width="2"/>' +
      '<circle cx="17.2" cy="6.8" r="1.3" fill="currentColor"/>' +
    '</svg>';

  var THREADS_ICON =
    '<svg class="movie-request-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  function actionButtons(iconOnly) {
    var igLabel = esc(t('request.instagram', 'Написать в Instagram'));
    var thLabel = esc(t('request.threads', 'Написать в Threads'));
    var igShort = esc(t('request.instagramShort', 'Instagram'));
    var thShort = esc(t('request.threadsShort', 'Threads'));
    var socialClass = iconOnly ? ' movie-request-btn--social' : '';

    return (
      '<div class="movie-request-block__actions">' +
        '<a href="' + esc(INSTAGRAM_URL) + '" class="movie-request-btn movie-request-btn--instagram' + socialClass + '" target="_blank" rel="noopener noreferrer" aria-label="' + igLabel + '">' +
          (iconOnly
            ? '<span class="movie-request-btn__glyph">' + INSTAGRAM_ICON + '</span><span class="movie-request-btn__name">' + igShort + '</span>'
            : igLabel) +
        '</a>' +
        '<a href="' + esc(THREADS_URL) + '" class="movie-request-btn movie-request-btn--threads' + socialClass + '" target="_blank" rel="noopener noreferrer" aria-label="' + thLabel + '">' +
          (iconOnly
            ? '<span class="movie-request-btn__glyph">' + THREADS_ICON + '</span><span class="movie-request-btn__name">' + thShort + '</span>'
            : thLabel) +
        '</a>' +
      '</div>'
    );
  }

  function esc(text) {
    return (window.MovieDisplay && window.MovieDisplay.escapeHtml)
      ? window.MovieDisplay.escapeHtml(text)
      : String(text == null ? '' : text);
  }

  function t(key, fallback) {
    return (window.t ? window.t(key) : null) || fallback;
  }

  function html(options) {
    options = options || {};
    var compact = options.compact;
    var showEmpty = options.showEmpty;
    var emptyKey = options.emptyKey || 'catalog.searchEmpty';
    var emptyFallback = options.emptyFallback || 'Ничего не найдено.';
    var emptyHintKey = options.emptyHintKey || 'catalog.searchEmptyHint';
    var emptyHintFallback = options.emptyHintFallback || 'Попробуйте другое написание, оригинальное название или год выпуска.';

    var title = esc(t('request.title', 'Не нашли нужный фильм?'));
    var text = esc(t('request.text', 'Напишите мне в Instagram или Threads — я проверю и добавлю его на сайт.'));
    var hint = esc(t('request.hint', 'Укажите название фильма, год выпуска и, если есть, ссылку на TMDB / Кинопоиск / IMDb.'));
    var writeLabel = esc(t('request.writeUs', 'Можете написать:'));

    if (compact) {
      return (
        '<div class="movie-request-block movie-request-block--compact" role="complementary">' +
          '<div class="movie-request-block__compact-inner">' +
            '<div class="movie-request-block__compact-text">' +
              '<p class="movie-request-block__title">' + title + '</p>' +
              '<p class="movie-request-block__hint">' + hint + '</p>' +
            '</div>' +
            '<div class="movie-request-block__compact-actions">' +
              '<p class="movie-request-block__write-label">' + writeLabel + '</p>' +
              actionButtons(true) +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }

    var emptyHtml = showEmpty
      ? '<div class="movie-request-block__empty-wrap">' +
          '<p class="movie-request-block__empty">' + esc(t(emptyKey, emptyFallback)) + '</p>' +
          '<p class="movie-request-block__empty-hint">' + esc(t(emptyHintKey, emptyHintFallback)) + '</p>' +
        '</div>'
      : '';

    return (
      '<div class="movie-request-block" role="complementary">' +
        emptyHtml +
        '<h3 class="movie-request-block__title">' + title + '</h3>' +
        '<p class="movie-request-block__text">' + text + '</p>' +
        '<p class="movie-request-block__hint">' + hint + '</p>' +
        actionButtons(false) +
      '</div>'
    );
  }

  function updateCompactEl(el) {
    if (!el) return;
    el.innerHTML = html({ compact: true });
  }

  window.MovieRequestBlock = {
    INSTAGRAM_URL: INSTAGRAM_URL,
    THREADS_URL: THREADS_URL,
    html: html,
    updateCompactEl: updateCompactEl
  };
})();
