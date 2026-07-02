/* ===================================================================
   catalogBrowser.js — каталог фильмов на главной (вкладка «Каталог»).

   Рисует готовые подборки горизонтальными лентами: спец-подборки
   (популярное, новинки, кассовое, сериалы), по настроению и по жанрам,
   плюс раздел «200 лучших за всё время» с фильтром фильмы/сериалы/всё.

   Каталог — отдельный слой поверх существующих данных: ничего из списка
   пользователя, рекомендаций и страницы фильма не меняет. Гость может
   просматривать каталог; добавлять в список может только вошедший.

   Ленивая загрузка: каждая лента подгружается, когда попадает во вьюпорт
   (IntersectionObserver) — поэтому каталог не делает десятки запросов
   сразу и быстро работает в PWA.
   =================================================================== */
(function () {
  'use strict';

  var section = document.getElementById('catalog-section');
  if (!section) return;

  var indexEl = section.querySelector('#catalog-index');
  var topItemsEl = section.querySelector('#catalog-top-items');
  var topFilterEl = section.querySelector('#catalog-top-filter');
  var searchInput = section.querySelector('#catalog-search');
  var searchFilterEl = section.querySelector('#catalog-search-filter');
  var searchPanelEl = section.querySelector('#catalog-search-panel');
  var searchResultsEl = section.querySelector('#catalog-search-results');
  var movieRequestCompactEl = section.querySelector('#catalog-movie-request');

  var loadedCollections = {};
  var topLoaded = {};
  var io = null;
  var catalogGroups = [];
  var activeGroupId = null;
  var searchFilter = 'all';
  var searchTimer = null;
  var searchSeq = 0;
  var searchCache = {};
  var lastSearchKey = '';
  var SEARCH_DEBOUNCE_MS = 400;
  var SEARCH_MIN_CHARS = 2;

  function esc(text) {
    return (window.MovieDisplay && window.MovieDisplay.escapeHtml)
      ? window.MovieDisplay.escapeHtml(text)
      : String(text == null ? '' : text);
  }

  // Перевод по ключу (с фолбэком на русский текст, если i18n не загружен).
  function tt(key, fallback) {
    return (window.t ? window.t(key) : null) || fallback;
  }

  // Язык для запросов к каталогу (TMDB-названия/описания приходят на нём).
  function lang() {
    return (window.I18N && window.I18N.getLang) ? window.I18N.getLang() : 'ru';
  }

  function tmdbApiLang() {
    return (window.I18N && window.I18N.tmdbLang) ? window.I18N.tmdbLang() : 'ru-RU';
  }

  function withLang(url) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'lang=' + encodeURIComponent(lang());
  }

  function isLoggedIn() {
    return typeof window.isLoggedIn === 'function' ? window.isLoggedIn() : false;
  }

  // Безопасные заголовки: auth.js может ещё не загрузиться к первому вызову.
  function hdrs() {
    return (typeof window.authHeaders === 'function') ? window.authHeaders() : {};
  }

  function posterUrl(url) {
    if (window.MovieDisplay && window.MovieDisplay.posterUrl) {
      return window.MovieDisplay.posterUrl(url, 'w342');
    }
    return url;
  }

  function moviePageUrl(item) {
    if (window.MovieDisplay && window.MovieDisplay.moviePageUrl) {
      return window.MovieDisplay.moviePageUrl(item);
    }
    var type = item.mediaType === 'tv' ? 'tv' : 'movie';
    return '/movie.html?type=' + type + '&id=' + encodeURIComponent(item.tmdbId);
  }

  // Уже в списке пользователя? (по tmdbId или названию)
  function inUserList(item) {
    if (!window.MovieApp || !window.MovieApp.getMovies) return false;
    var movies = window.MovieApp.getMovies() || [];
    var title = String(item.title || '').toLowerCase().trim();
    return movies.some(function (m) {
      if (item.tmdbId && m.tmdbId && Number(m.tmdbId) === Number(item.tmdbId)
        && (m.mediaType || 'movie') === (item.mediaType || 'movie')) return true;
      return String(m.title || '').toLowerCase().trim() === title;
    });
  }

  function ratingBadge(item) {
    var r = Number(item.voteAverage);
    if (!r) return '';
    return '<span class="cat-card-rating">★ ' + r.toFixed(1) + '</span>';
  }

  function contentTypeLabel(item) {
    var type = item.contentType || (item.mediaType === 'tv' ? 'tv' : 'movie');
    if (type === 'anime') return tt('card.anime', 'Аниме');
    if (type === 'animation') return tt('card.animation', 'Мультфильм');
    if (type === 'tv') return tt('card.series', 'Сериал');
    return tt('card.movie', 'Фильм');
  }

  function truncateOverview(text, max) {
    var str = String(text || '').trim();
    if (!str) return '';
    max = max || 160;
    if (str.length <= max) return str;
    return str.slice(0, max).replace(/\s+\S*$/, '') + '…';
  }

  // Расширенная карточка для результатов поиска (список, не сетка).
  function searchResultCardHtml(item) {
    var href = moviePageUrl(item);
    var added = item.inUserList || inUserList(item);
    var poster = item.poster
      ? '<img class="cat-search-poster" src="' + esc(posterUrl(item.poster)) + '" alt="' + esc(item.title) + '" loading="lazy" decoding="async">'
      : '<div class="cat-search-poster cat-search-poster--empty">🎬</div>';
    var yearHtml = item.year ? '<span class="cat-search-year">' + esc(item.year) + '</span>' : '';
    var rating = Number(item.voteAverage);
    var ratingHtml = rating
      ? '<span class="cat-search-rating">★ ' + rating.toFixed(1) + '</span>'
      : '';
    var original = item.originalTitle && item.originalTitle !== item.title
      ? '<span class="cat-search-original">' + esc(item.originalTitle) + '</span>'
      : '';
    var overview = item.overview
      ? '<p class="cat-search-overview">' + esc(truncateOverview(item.overview)) + '</p>'
      : '';
    var addBtn = added
      ? '<button type="button" class="cat-search-add cat-search-add--done" disabled>' + esc(tt('card.added', '✓ В списке')) + '</button>'
      : '<button type="button" class="cat-search-add" data-add="1">' + esc(tt('card.add', '+ В список')) + '</button>';

    return '' +
      '<article class="cat-search-item" data-tmdb="' + esc(item.tmdbId) + '" data-type="' + esc(item.mediaType || 'movie') + '">' +
        '<a class="cat-search-poster-link" href="' + esc(href) + '" aria-hidden="true" tabindex="-1">' + poster + '</a>' +
        '<div class="cat-search-body">' +
          '<div class="cat-search-headline">' +
            '<a class="cat-search-title" href="' + esc(href) + '">' + esc(item.title) + '</a>' +
            '<div class="cat-search-meta">' +
              '<span class="cat-search-type">' + esc(contentTypeLabel(item)) + '</span>' +
              yearHtml + ratingHtml +
            '</div>' +
            original +
          '</div>' +
          overview +
        '</div>' +
        '<div class="cat-search-actions">' +
          addBtn +
          '<a class="cat-search-open" href="' + esc(href) + '">' + esc(tt('catalog.openMovie', 'Открыть')) + '</a>' +
        '</div>' +
      '</article>';
  }

  // Карточка фильма каталога. rank — номер для «200 лучших» (необязателен).
  function cardHtml(item, rank) {
    var href = moviePageUrl(item);
    var added = inUserList(item);
    var poster = item.poster
      ? '<img class="cat-card-poster" src="' + esc(posterUrl(item.poster)) + '" alt="' + esc(item.title) + '" loading="lazy" decoding="async">'
      : '<div class="cat-card-poster cat-card-poster--empty">🎬</div>';
    var rankHtml = rank ? '<span class="cat-card-rank">' + rank + '</span>' : '';
    var yearHtml = item.year ? '<span class="cat-card-year">' + esc(item.year) + '</span>' : '';
    var typeHtml = item.mediaType === 'tv' ? '<span class="cat-card-type">' + esc(tt('card.series', 'Сериал')) + '</span>' : '';
    var addBtn = added
      ? '<button type="button" class="cat-card-add cat-card-add--done" disabled>' + esc(tt('card.added', '✓ В списке')) + '</button>'
      : '<button type="button" class="cat-card-add" data-add="1">' + esc(tt('card.add', '+ В список')) + '</button>';

    return '' +
      '<article class="cat-card" data-tmdb="' + esc(item.tmdbId) + '" data-type="' + esc(item.mediaType || 'movie') + '">' +
        '<a class="cat-card-poster-link" href="' + esc(href) + '">' +
          poster + rankHtml +
          '<span class="cat-card-badges">' + ratingBadge(item) + typeHtml + '</span>' +
        '</a>' +
        '<div class="cat-card-body">' +
          '<a class="cat-card-title" href="' + esc(href) + '">' + esc(item.title) + '</a>' +
          yearHtml +
        '</div>' +
        addBtn +
      '</article>';
  }

  // Делегированный обработчик «+ В список» для всего каталога.
  section.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.cat-card-add[data-add], .cat-search-add[data-add]');
    if (!btn) return;
    var card = btn.closest('.cat-card, .cat-search-item');
    if (!card) return;
    addToList(card, btn);
  });

  function findItemData(card) {
    var tmdbId = Number(card.getAttribute('data-tmdb')) || null;
    var data = card.__catItem;
    if (data) return data;
    return { tmdbId: tmdbId, mediaType: card.getAttribute('data-type') || 'movie' };
  }

  function addToList(card, btn) {
    if (!isLoggedIn()) {
      if (typeof window.requireLogin === 'function') {
        window.requireLogin(tt('card.loginToAdd', 'Войдите, чтобы добавлять фильмы в свой список.'));
      }
      return;
    }
    var item = findItemData(card);
    if (!item || !window.MovieApp || !window.MovieApp.executeActions) return;

    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = tt('card.adding', 'Добавляю…');

    window.MovieApp.executeActions([{
      type: 'add_movie',
      title: item.title,
      status: 'want',
      genres: item.genres || [],
      tmdbId: item.tmdbId,
      mediaType: item.mediaType || 'movie',
      meta: {
        poster: item.poster || null,
        year: item.year || null,
        voteAverage: item.voteAverage || null,
        overview: item.overview || null,
        originalTitle: item.originalTitle || null,
        matchSource: 'auto'
      }
    }]).then(function (results) {
      var r = (results && results[0]) || {};
      if (r.success || r.duplicate) {
        btn.textContent = tt('card.added', '✓ В списке');
        btn.classList.add('cat-card-add--done', 'cat-search-add--done');
      } else {
        btn.disabled = false;
        btn.textContent = original;
      }
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = original;
    });
  }

  /* ── Рендер реестра подборок ───────────────────────────────────────
     Подборки свёрнуты: показываем горизонтальную ленту «чипов» (названий).
     Тап по чипу разворачивает ленту фильмов этой подборки в панели ниже;
     повторный тап — сворачивает. Открыта одна подборка за раз — компактно. */
  var collCache = {};   // id → массив items (чтобы не грузить повторно)

  /* ── Иконки и подписи категорий (визуальные карточки каталога) ──── */
  var ICONS = {
    fire: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c1 4-2 5-2 8a2 2 0 0 0 4 0c0-1 0-1 .5-2 1.5 1.5 2.5 3.2 2.5 5a5 5 0 0 1-10 0c0-3.5 3-5 5-11z"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15 9 22 9.5 17 14 18.5 21 12 17.3 5.5 21 7 14 2 9.5 9 9"/></svg>',
    cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9v6M18 9v6"/></svg>',
    tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="13" rx="2"/><path d="M8 3l4 4 4-4"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 4 14 11 14 10 22 20 9 13 9 13 2"/></svg>',
    bulb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>',
    mountains: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20l6-10 4 6 2-3 6 7z"/><circle cx="7" cy="6" r="2"/></svg>',
    masks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h7v6a3.5 3.5 0 0 1-7 0z"/><path d="M14 9h7v4a3.5 3.5 0 0 1-7 0z"/></svg>',
    smile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/></svg>',
    rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 15c-1 1-1 4-1 4s3 0 4-1m0-3a8 8 0 0 1 9-9 8 8 0 0 1-9 9z"/><circle cx="14.5" cy="9.5" r="1.5"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
    ghost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V10a7 7 0 0 1 14 0v11l-2.5-2-2.5 2-2-2-2 2-3-2z"/><path d="M9 10h.01M15 10h.01"/></svg>',
    cuffs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="16" r="4"/><circle cx="17" cy="16" r="4"/><path d="M7 12V7a3 3 0 0 1 6 0M17 12V7a3 3 0 0 0-6 0"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.6l-1-1a5.5 5.5 0 1 0-7.8 7.8l8.8 8.6 8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/></svg>',
    wand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4V2M15 10V8M19 6h2M9 6h2M5 19l9-9M17 7l2-2"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
    compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polygon points="16 8 11 11 8 16 13 13 16 8"/></svg>',
    toon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="1.2"/><circle cx="15" cy="10" r="1.2"/><path d="M8 15c1.2 1.3 6.8 1.3 8 0"/></svg>',
    scroll: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h10a2 2 0 0 1 2 2v12a3 3 0 0 0 3 3H8a2 2 0 0 1-2-2z"/><path d="M6 3a2 2 0 0 0-2 2v2h2M10 8h6M10 12h6"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z"/></svg>',
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M17 8h4M3 16h4M17 16h4"/></svg>',
    flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c1 4-2 5-2 8a2 2 0 0 0 4 0c0-1 0-1 .5-2 1.5 1.5 2.5 3.2 2.5 5a5 5 0 0 1-10 0c0-3.5 3-5 5-11z"/></svg>',
    trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/><path d="M9 14.5h6M10 21h4M12 14v3"/></svg>',
    sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18.5 9l-4.7 1.3L12 15l-1.8-4.7L5.5 9l4.7-1.3z"/><path d="M18 14l.7 1.8L20.5 17l-1.8.6L18 19l-.7-1.4L15.5 17l1.8-1.2z"/></svg>',
    gem: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l3 5-9 13L3 8z"/><path d="M3 8h18M9 3l-3 5 6 13 6-13-3-5"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18"/></svg>',
    plane: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16 3 14v-2l7 1 4-7 2 .5L14 12l5 1 2-2 1.5.5-2.5 4.5L20 18l-1.5 2-2-5z"/></svg>',
    ball: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3l3 4-1.5 5h-3L9 7zM3.5 9.5 7 11M20.5 9.5 17 11M7 17l1.5-3M17 17l-1.5-3"/></svg>',
    briefcase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 12h18"/></svg>',
    grad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c0 1 3 2.5 6 2.5S18 17 18 16v-5M22 9v5"/></svg>',
    tent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 20h18zM12 3v17"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8z"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M21 3l-7 7M4 20l6-6M16 21h5v-5M15 15l6 6M4 4l5 5"/></svg>',
    family: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="7" r="2.5"/><circle cx="16" cy="7" r="2.5"/><path d="M3.5 20v-3a3 3 0 0 1 3-3h3a3 3 0 0 1 3 3v3M14 20v-3a3 3 0 0 1 3-3h0a3 3 0 0 1 3 3v3"/></svg>'
  };

  // Доступ к иконкам из других модулей (homeCollections.js).
  window.CatalogIcons = ICONS;

  // Спец-подборки и настроения: короткая подпись + описание + иконка.
  var CAT_META = {
    'most-popular':     { icon: 'fire',      label: 'Популярное',       desc: 'Сейчас на слуху' },
    'best-recent':      { icon: 'star',      label: 'Лучшее за годы',   desc: 'Высокие оценки' },
    'highest-grossing': { icon: 'cash',      label: 'Кассовые',         desc: 'Хиты проката' },
    'top-series':       { icon: 'tv',        label: 'Сериалы',          desc: 'Лучшие шоу' },
    'mood-light':       { icon: 'sun',       label: 'Лёгкое и доброе',  desc: 'Без напряжения' },
    'mood-tense':       { icon: 'bolt',      label: 'Напряжённое',      desc: 'Триллеры и интрига' },
    'mood-think':       { icon: 'bulb',      label: 'Заставляет думать', desc: 'Глубокие сюжеты' },
    'mood-epic':        { icon: 'mountains', label: 'Эпичное',          desc: 'Зрелищное кино' }
  };

  // Жанры по ключу (id вида genre-<key>).
  var GENRE_META = {
    'боевик':      { icon: 'bolt',     label: 'Боевики' },
    'драма':       { icon: 'masks',    label: 'Драмы' },
    'комедия':     { icon: 'smile',    label: 'Комедии' },
    'фантастика':  { icon: 'rocket',   label: 'Фантастика' },
    'триллер':     { icon: 'eye',      label: 'Триллеры' },
    'ужасы':       { icon: 'ghost',    label: 'Ужасы' },
    'криминал':    { icon: 'cuffs',    label: 'Криминал' },
    'мелодрама':   { icon: 'heart',    label: 'Романтика' },
    'фэнтези':     { icon: 'wand',     label: 'Фэнтези' },
    'детектив':    { icon: 'search',   label: 'Детективы' },
    'приключения': { icon: 'compass',  label: 'Приключения' },
    'мультфильм':  { icon: 'toon',     label: 'Мультфильмы' },
    'история':     { icon: 'scroll',   label: 'Историческое' },
    'военный':     { icon: 'shield',   label: 'Военные' }
  };

  function categoryMeta(s) {
    // Сервер присылает локализованные icon (ключ) + desc + shortTitle —
    // используем их как основной источник (полная локализация RU/EN).
    var icon = (s.icon && ICONS[s.icon]) ? ICONS[s.icon] : ICONS.film;
    return { icon: icon, label: shortLabel(s), desc: s.desc || '' };
  }

  // Короткая подпись для чипа. Приоритет — локализованный shortTitle с сервера;
  // далее локальные карты (на случай старого ответа), затем срезаем «20 лучших».
  function shortLabel(s) {
    if (s.shortTitle) return s.shortTitle;
    if (CAT_META[s.id]) return CAT_META[s.id].label;
    if (s.id.indexOf('genre-') === 0 && GENRE_META[s.id.slice(6)]) return GENRE_META[s.id.slice(6)].label;
    return String(s.title || '').replace(/^\d+\s+(лучших|самых)\s+/i, '');
  }

  function renderIndex(data) {
    catalogGroups = (data && data.groups) || [];
    if (!catalogGroups.length) { indexEl.innerHTML = ''; return; }

    if (!activeGroupId || !catalogGroups.some(function (g) { return g.id === activeGroupId; })) {
      activeGroupId = catalogGroups[0].id;
    }

    var tabsHtml = catalogGroups.map(function (g) {
      var active = g.id === activeGroupId;
      return '<button type="button" class="cat-group-tab' + (active ? ' cat-group-tab--active' : '') + '" data-group="' + esc(g.id) + '" aria-selected="' + (active ? 'true' : 'false') + '">' + esc(g.title) + '</button>';
    }).join('');

    indexEl.innerHTML = '' +
      '<div class="cat-group-tabs" role="tablist" aria-label="' + esc(tt('catalog.categories', 'Категории')) + '">' + tabsHtml + '</div>' +
      '<div id="cat-group-panel" class="cat-group-panel"></div>';

    renderActiveGroup();
  }

  function renderActiveGroup() {
    var panel = document.getElementById('cat-group-panel');
    if (!panel) return;
    var group = catalogGroups.find(function (g) { return g.id === activeGroupId; });
    if (!group || !group.collections.length) {
      panel.innerHTML = '<p class="cat-row-empty">' + esc(tt('catalog.loadError', 'Не удалось загрузить каталог.')) + '</p>';
      return;
    }

    panel.innerHTML = '' +
      '<div class="cat-chips" role="tablist" aria-label="' + esc(group.title) + '">' +
        group.collections.map(function (s) {
          var m = categoryMeta(s);
          return '<button type="button" class="cat-chip" data-collection="' + esc(s.id) + '" aria-expanded="false">' +
            '<span class="cat-chip-icon" aria-hidden="true">' + m.icon + '</span>' +
            '<span class="cat-chip-info">' +
              '<span class="cat-chip-text">' + esc(m.label) + '</span>' +
              (m.desc ? '<span class="cat-chip-desc">' + esc(m.desc) + '</span>' : '') +
            '</span>' +
            '<span class="cat-chip-caret" aria-hidden="true">▾</span>' +
          '</button>';
        }).join('') +
      '</div>' +
      '<div id="cat-chip-panel" class="cat-chip-panel" hidden></div>';
  }

  // Делегированный обработчик табов групп и чипов подборок.
  indexEl.addEventListener('click', function (e) {
    var groupTab = e.target.closest && e.target.closest('.cat-group-tab');
    if (groupTab) {
      activeGroupId = groupTab.getAttribute('data-group');
      indexEl.querySelectorAll('.cat-group-tab').forEach(function (t) {
        var on = t === groupTab;
        t.classList.toggle('cat-group-tab--active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      renderActiveGroup();
      return;
    }

    var chip = e.target.closest && e.target.closest('.cat-chip');
    if (!chip) return;
    var id = chip.getAttribute('data-collection');
    var panel = document.getElementById('cat-chip-panel');
    var wasActive = chip.classList.contains('cat-chip--active');

    indexEl.querySelectorAll('.cat-chip').forEach(function (c) {
      c.classList.remove('cat-chip--active');
      c.setAttribute('aria-expanded', 'false');
    });

    if (wasActive) {            // повторный тап — свернуть
      if (panel) { panel.hidden = true; panel.innerHTML = ''; }
      return;
    }

    chip.classList.add('cat-chip--active');
    chip.setAttribute('aria-expanded', 'true');
    openCollection(id);
  });

  function openCollection(id) {
    var panel = document.getElementById('cat-chip-panel');
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = '<div class="cat-row-scroll" id="cat-row-' + esc(id) + '">' + rowSkeleton() + '</div>';
    var target = document.getElementById('cat-row-' + id);
    if (!target) return;

    if (collCache[id]) { renderCardsInto(target, collCache[id]); return; }

    // На «холодном» кеше (особенно при первом переключении языка) сборка
    // подборки из TMDB может временно вернуть пусто — повторяем перед ошибкой.
    fetchCollectionWithRetry(id, 0)
      .then(function (items) {
        if (!items || !items.length) {
          target.innerHTML = '<p class="cat-row-empty">' + esc(tt('card.loadFailed', 'Не удалось загрузить')) + '</p>';
          return;
        }
        collCache[id] = items;
        renderCardsInto(target, items);
      })
      .catch(function () {
        target.innerHTML = '<p class="cat-row-empty">' + esc(tt('card.serverDown', 'Сервер недоступен')) + '</p>';
      });
  }

  function fetchCollectionWithRetry(id, attempt) {
    return fetch(withLang('/api/catalog/collection/' + encodeURIComponent(id)), { headers: hdrs() })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, d: d }; }); })
      .then(function (out) {
        var items = (out.ok && out.d && out.d.items) ? out.d.items : [];
        if (!items.length && attempt < 2) {
          return new Promise(function (r) { setTimeout(r, 700 * (attempt + 1)); })
            .then(function () { return fetchCollectionWithRetry(id, attempt + 1); });
        }
        return items;
      })
      .catch(function () {
        if (attempt < 2) {
          return new Promise(function (r) { setTimeout(r, 700 * (attempt + 1)); })
            .then(function () { return fetchCollectionWithRetry(id, attempt + 1); });
        }
        throw new Error('failed');
      });
  }

  function rowSkeleton() {
    var cards = '';
    for (var i = 0; i < 6; i++) {
      cards += '<div class="cat-card cat-card--skeleton"><div class="cat-card-poster cat-card-poster--skeleton"></div></div>';
    }
    return cards;
  }

  // Наблюдаем только за «200 лучших» (ленивая загрузка при попадании во вьюпорт).
  // Подборки теперь грузятся по тапу на чип, поэтому их не наблюдаем.
  function observeRows() {
    if (io) io.disconnect();
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);
        if (entry.target.id === 'catalog-top-sentinel') loadTop(currentTopFilter());
      });
    }, { rootMargin: '300px 0px' });

    var topSentinel = document.getElementById('catalog-top-sentinel');
    if (topSentinel) io.observe(topSentinel);
  }

  function renderCardsInto(target, items) {
    target.innerHTML = items.map(function (it) { return cardHtml(it); }).join('');
    // Прикрепляем данные к карточкам для добавления в список.
    var cards = target.querySelectorAll('.cat-card');
    cards.forEach(function (card, i) { card.__catItem = items[i]; });
  }

  /* ── 200 лучших ────────────────────────────────────────────────── */
  function currentTopFilter() {
    var active = topFilterEl && topFilterEl.querySelector('.cat-top-tab--active');
    return (active && active.getAttribute('data-filter')) || 'all';
  }

  function loadTop(filter) {
    filter = filter || 'all';
    if (topLoaded[filter]) {
      // Уже загружено — просто показываем (перерисуем из кеша браузера ниже).
    }
    topItemsEl.innerHTML = rowSkeletonGrid();

    fetchTopWithRetry(filter, 0)
      .then(function (items) {
        if (!items || !items.length) {
          topItemsEl.innerHTML = '<p class="cat-row-empty">' + esc(tt('card.loadFailed', 'Не удалось загрузить подборку')) + '</p>';
          return;
        }
        topLoaded[filter] = true;
        topItemsEl.innerHTML = items.map(function (it, i) { return cardHtml(it, i + 1); }).join('');
        var cards = topItemsEl.querySelectorAll('.cat-card');
        cards.forEach(function (card, i) { card.__catItem = items[i]; });
      })
      .catch(function () {
        topItemsEl.innerHTML = '<p class="cat-row-empty">' + esc(tt('card.serverDown', 'Сервер недоступен')) + '</p>';
      });
  }

  function fetchTopWithRetry(filter, attempt) {
    return fetch(withLang('/api/catalog/top?filter=' + encodeURIComponent(filter)), { headers: hdrs() })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, d: d }; }); })
      .then(function (out) {
        var items = (out.ok && out.d && out.d.items) ? out.d.items : [];
        if (!items.length && attempt < 2) {
          return new Promise(function (r) { setTimeout(r, 800 * (attempt + 1)); })
            .then(function () { return fetchTopWithRetry(filter, attempt + 1); });
        }
        return items;
      })
      .catch(function () {
        if (attempt < 2) {
          return new Promise(function (r) { setTimeout(r, 800 * (attempt + 1)); })
            .then(function () { return fetchTopWithRetry(filter, attempt + 1); });
        }
        throw new Error('failed');
      });
  }

  function rowSkeletonGrid() {
    var cards = '';
    for (var i = 0; i < 10; i++) {
      cards += '<div class="cat-card cat-card--skeleton"><div class="cat-card-poster cat-card-poster--skeleton"></div></div>';
    }
    return cards;
  }

  if (topFilterEl) {
    topFilterEl.addEventListener('click', function (e) {
      var tab = e.target.closest && e.target.closest('.cat-top-tab');
      if (!tab) return;
      topFilterEl.querySelectorAll('.cat-top-tab').forEach(function (t) {
        t.classList.toggle('cat-top-tab--active', t === tab);
      });
      loadTop(tab.getAttribute('data-filter'));
    });
  }

  /* ── Поиск по названию ─────────────────────────────────────────── */
  function setSearching(active) {
    section.classList.toggle('catalog-section--searching', active);
  }

  function renderMovieRequestCompact() {
    if (window.MovieRequestBlock && window.MovieRequestBlock.updateCompactEl) {
      window.MovieRequestBlock.updateCompactEl(movieRequestCompactEl);
    }
  }

  function renderSearchResults(items, query) {
    if (!searchResultsEl) return;
    if (!items || !items.length) {
      searchResultsEl.innerHTML = (window.MovieRequestBlock && window.MovieRequestBlock.html)
        ? window.MovieRequestBlock.html({
          showEmpty: true,
          emptyKey: 'catalog.searchEmpty',
          emptyFallback: 'Ничего не найдено.',
          emptyHintKey: 'catalog.searchEmptyHint',
          emptyHintFallback: 'Попробуйте другое написание, оригинальное название или год выпуска.',
          query: query
        })
        : '<div class="cat-search-empty">' +
            '<p class="cat-search-empty__title">' + esc(tt('catalog.searchEmpty', 'Ничего не найдено.')) + '</p>' +
            '<p class="cat-search-empty__hint">' + esc(tt('catalog.searchEmptyHint', 'Попробуйте другое написание, оригинальное название или год выпуска.')) + '</p>' +
          '</div>';
      return;
    }
    searchResultsEl.innerHTML = items.map(function (it) { return searchResultCardHtml(it); }).join('');
    var cards = searchResultsEl.querySelectorAll('.cat-search-item');
    cards.forEach(function (card, i) { card.__catItem = items[i]; });
  }

  function searchCacheKey(query) {
    return lang() + '|' + searchFilter + '|' + query.toLowerCase();
  }

  function runSearch(query) {
    if (!searchPanelEl || !searchResultsEl) return;
    if (!query || query.length < SEARCH_MIN_CHARS) {
      setSearching(false);
      searchPanelEl.hidden = true;
      searchResultsEl.innerHTML = '';
      lastSearchKey = '';
      return;
    }

    var cacheKey = searchCacheKey(query);
    if (cacheKey === lastSearchKey && searchCache[cacheKey]) {
      setSearching(true);
      searchPanelEl.hidden = false;
      renderSearchResults(searchCache[cacheKey], query);
      return;
    }
    lastSearchKey = cacheKey;

    setSearching(true);
    searchPanelEl.hidden = false;
    searchResultsEl.innerHTML = '<p class="cat-search-loading">' + esc(tt('common.loading', 'Загрузка…')) + '</p>';

    var seq = ++searchSeq;
    var url = withLang('/api/catalog/search?q=' + encodeURIComponent(query) + '&filter=' + encodeURIComponent(searchFilter));
    fetch(url, { headers: hdrs() })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, d: d }; }); })
      .then(function (out) {
        if (seq !== searchSeq) return;
        if (!out.ok) {
          searchResultsEl.innerHTML = '<p class="cat-row-empty">' + esc(tt('catalog.searchError', 'Не удалось выполнить поиск.')) + '</p>';
          return;
        }
        var items = (out.d && out.d.items) || [];
        searchCache[cacheKey] = items;
        renderSearchResults(items, query);
      })
      .catch(function () {
        if (seq !== searchSeq) return;
        searchResultsEl.innerHTML = '<p class="cat-row-empty">' + esc(tt('card.serverDown', 'Сервер недоступен')) + '</p>';
      });
  }

  function scheduleSearch() {
    clearTimeout(searchTimer);
    var q = searchInput ? searchInput.value.trim() : '';
    searchTimer = setTimeout(function () { runSearch(q); }, SEARCH_DEBOUNCE_MS);
  }

  if (searchInput) {
    searchInput.addEventListener('input', scheduleSearch);
    searchInput.addEventListener('search', scheduleSearch);
  }

  if (searchFilterEl) {
    searchFilterEl.addEventListener('click', function (e) {
      var tab = e.target.closest && e.target.closest('.cat-search-tab');
      if (!tab) return;
      searchFilterEl.querySelectorAll('.cat-search-tab').forEach(function (t) {
        t.classList.toggle('cat-search-tab--active', t === tab);
      });
      searchFilter = tab.getAttribute('data-filter') || 'all';
      if (searchInput && searchInput.value.trim()) runSearch(searchInput.value.trim());
    });
  }

  renderMovieRequestCompact();

  /* ── Инициализация ─────────────────────────────────────────────── */
  var indexRendered = false;
  var indexLoading = false;
  function init() {
    if (indexRendered || indexLoading) return;
    indexLoading = true;
    fetch(withLang('/api/catalog'), { headers: hdrs() })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        indexLoading = false;
        indexRendered = true;
        renderIndex(data);
        observeRows();
      })
      .catch(function () {
        indexLoading = false;
        indexEl.innerHTML = '<p class="cat-row-empty">' + esc(tt('catalog.loadError', 'Не удалось загрузить каталог.')) +
          ' <button type="button" class="cat-card-add" data-retry="1">' + esc(tt('common.retry', 'Повторить')) + '</button></p>';
      });
  }

  // Смена языка: подписи категорий и названия/описания фильмов зависят от языка.
  // Полностью сбрасываем состояние и перезагружаем индекс + видимые блоки.
  document.addEventListener('i18n:change', function () {
    collCache = {};
    topLoaded = {};
    loadedCollections = {};
    searchCache = {};
    lastSearchKey = '';
    indexRendered = false;
    indexLoading = false;
    activeGroupId = null;
    catalogGroups = [];
    var panel = document.getElementById('cat-chip-panel');
    if (panel) { panel.hidden = true; panel.innerHTML = ''; }
    if (topItemsEl) topItemsEl.innerHTML = '';
    init();
    kickVisible();
    if (searchInput && searchInput.value.trim()) runSearch(searchInput.value.trim());
    renderMovieRequestCompact();
  });

  // Кнопка «Повторить» в состоянии ошибки.
  section.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-retry]')) init();
  });

  // Публичный API: appShell вызывает refresh при показе вкладки «Каталог».
  // Также экспортируем переиспользуемые хелперы для лент на главной
  // (homeCollections.js): рендер карточек и добавление в список.
  window.CatalogUI = {
    refresh: function () {
      init();
      // На случай, если ленты уже отрисованы, но IO не сработал (например,
      // секция была display:none) — пнём загрузку видимых лент.
      if (indexRendered) kickVisible();
    },
    cardHtml: cardHtml,
    renderCardsInto: renderCardsInto,
    addFromCard: addToList
  };

  // Подстраховка от гонок при первой загрузке: если экран «Каталог» активен
  // (deep-link), но appShell по какой-то причине не вызвал refresh — пробуем
  // сами после полной загрузки страницы.
  function maybeInitOnActive() {
    if (document.body.dataset.appScreen === 'catalog' || location.hash === '#catalog') init();
  }
  window.addEventListener('load', function () { setTimeout(maybeInitOnActive, 400); });
  window.addEventListener('hashchange', function () {
    if (location.hash === '#catalog') maybeInitOnActive();
  });

  // Догружает «200 лучших», если секция уже во вьюпорте после показа вкладки.
  // Подборки грузятся по тапу на чип, поэтому здесь их не трогаем.
  function kickVisible() {
    var topSentinel = document.getElementById('catalog-top-sentinel');
    if (topSentinel && !topLoaded[currentTopFilter()]) {
      var rect = topSentinel.getBoundingClientRect();
      if (rect.top < (window.innerHeight + 300) && rect.bottom > -300) loadTop(currentTopFilter());
    }
  }

  // Deep-link #catalog обрабатывает appShell: при показе экрана «Каталог»
  // он вызывает CatalogUI.refresh(). Поэтому здесь init() заранее не зовём —
  // на момент загрузки этого скрипта auth.js может быть ещё не подключён.
})();
