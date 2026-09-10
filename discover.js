(function () {
  const stack = document.getElementById('discover-stack');
  if (!stack) return;

  const refreshBtn = document.getElementById('discover-refresh');
  const likeBtn = document.getElementById('discover-like');
  const skipBtn = document.getElementById('discover-skip');
  const watchedBtn = document.getElementById('discover-watched');
  const statusEl = document.getElementById('discover-status');

  const BATCH_SIZE = 12;
  const SWIPE_THRESHOLD = 90;
  const TAP_THRESHOLD = 8;

  // Единая смешанная лента: фильмы, сериалы и мультфильмы вместе.
  const localRecommendations = [
    { title: 'Интерстеллар', originalTitle: 'Interstellar', mediaType: 'movie', tmdbId: 157336, genres: ['Фантастика', 'Драма'], year: 2014 },
    { title: 'Начало', originalTitle: 'Inception', mediaType: 'movie', tmdbId: 27205, genres: ['Фантастика', 'Триллер'], year: 2010 },
    { title: 'Матрица', originalTitle: 'The Matrix', mediaType: 'movie', tmdbId: 603, genres: ['Фантастика', 'Боевик'], year: 1999 },
    { title: 'Достать ножи', originalTitle: 'Knives Out', mediaType: 'movie', tmdbId: 546554, genres: ['Детектив', 'Комедия'], year: 2019 },
    { title: 'Дюна', originalTitle: 'Dune', mediaType: 'movie', tmdbId: 438631, genres: ['Фантастика', 'Приключения'], year: 2021 },
    { title: 'Во все тяжкие', originalTitle: 'Breaking Bad', mediaType: 'tv', tmdbId: 1396, genres: ['Криминал', 'Драма'], year: 2008 },
    { title: 'Чернобыль', originalTitle: 'Chernobyl', mediaType: 'tv', tmdbId: 87108, genres: ['Драма', 'История'], year: 2019 },
    { title: 'Тьма', originalTitle: 'Dark', mediaType: 'tv', tmdbId: 70523, genres: ['Фантастика', 'Драма'], year: 2017 },
    { title: 'Аркейн', originalTitle: 'Arcane', mediaType: 'tv', tmdbId: 94605, genres: ['Анимация', 'Драма'], year: 2021 },
    { title: 'Рик и Морти', originalTitle: 'Rick and Morty', mediaType: 'tv', tmdbId: 60625, genres: ['Анимация', 'Комедия'], year: 2013 }
  ];

  let items = [];
  let index = 0;
  let loading = false;
  let pointerState = null;

  // Карточки, которые пользователь уже видел/свайпал, запоминаем между
  // обновлениями и сессиями — чтобы кнопка «Обновить» приносила новые фильмы,
  // а не тот же набор.
  // Храним записи вида "<ключ>::<нормализованный заголовок>", чтобы знать
  // и ключ (для локальной дедупликации), и название (для исключения на сервере).
  const SEEN_STORAGE_KEY = 'discoverSeenKeysV1';
  const SEEN_LIMIT = 400;
  let seenEntries = loadSeenEntries();

  function tt(key, fallback, vars) {
    if (!window.t) {
      return vars
        ? String(fallback).replace(/\{(\w+)\}/g, (m, name) => (vars[name] != null ? vars[name] : m))
        : fallback;
    }
    const out = window.t(key, vars);
    if (out == null || out === key) {
      return vars
        ? String(fallback).replace(/\{(\w+)\}/g, (m, name) => (vars[name] != null ? vars[name] : m))
        : fallback;
    }
    return out;
  }

  function refreshBtnLabel(isLoading) {
    return isLoading ? tt('common.loadingDots', 'Загрузка...') : tt('common.refresh', 'Обновить');
  }

  function updateRefreshBtn() {
    if (refreshBtn) refreshBtn.textContent = refreshBtnLabel(loading);
  }

  function loadSeenEntries() {
    try {
      const raw = localStorage.getItem(SEEN_STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }

  function persistSeenEntries() {
    try {
      const arr = [...seenEntries].slice(-SEEN_LIMIT);
      seenEntries = new Set(arr);
      localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(arr));
    } catch { /* localStorage может быть недоступен — не критично */ }
  }

  function seenEntry(item) {
    return `${recommendationKey(item)}::${normalizeTitle(item.title || item.originalTitle)}`;
  }

  function markSeen(item) {
    if (!item) return;
    seenEntries.add(seenEntry(item));
    persistSeenEntries();
  }

  function resetSeen() {
    seenEntries = new Set();
    try { localStorage.removeItem(SEEN_STORAGE_KEY); } catch { /* ignore */ }
  }

  function isSeen(item) {
    return seenEntries.has(seenEntry(item)) || seenKeySet().has(recommendationKey(item));
  }

  function seenKeySet() {
    const keys = new Set();
    seenEntries.forEach((entry) => keys.add(entry.split('::')[0]));
    return keys;
  }

  // ── Сессионный профиль вкуса свайпов ───────────────────────────────
  // Живёт только в текущей сессии. Свайп вправо усиливает похожие признаки
  // в дальнейшей выдаче, свайп влево — понижает. Отправляется на сервер,
  // который адаптирует ленту прямо во время листания.
  const SWIPE_SESSION_MAX = 14;
  const swipeSession = { right: [], left: [], boostGenres: {}, penalizeGenres: {} };
  let adaptInFlight = false;
  let adaptQueued = false;

  function sessionItem(item) {
    return {
      tmdbId: item.tmdbId || null,
      mediaType: item.mediaType || 'movie',
      title: item.title || item.originalTitle || '',
      genres: item.genres || []
    };
  }

  function recordSwipeSignal(item, dir) {
    if (!item) return;
    const entry = sessionItem(item);
    const arr = dir === 'right' ? swipeSession.right : swipeSession.left;
    arr.push(entry);
    if (arr.length > SWIPE_SESSION_MAX) arr.splice(0, arr.length - SWIPE_SESSION_MAX);
    const target = dir === 'right' ? swipeSession.boostGenres : swipeSession.penalizeGenres;
    (entry.genres || []).forEach((g) => {
      const key = String(g).toLowerCase();
      target[key] = (target[key] || 0) + 1;
    });
  }

  function hasSwipeSession() {
    return swipeSession.right.length > 0 || swipeSession.left.length > 0;
  }

  function sessionPayload() {
    return {
      right: swipeSession.right.slice(-SWIPE_SESSION_MAX),
      left: swipeSession.left.slice(-SWIPE_SESSION_MAX),
      boostGenres: swipeSession.boostGenres,
      penalizeGenres: swipeSession.penalizeGenres
    };
  }

  function esc(text) {
    return window.MovieDisplay?.escapeHtml(text) || String(text || '');
  }

  function normalizeTitle(title) {
    return String(title || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  }

  function recommendationKey(item) {
    if (item.tmdbId) return `${item.mediaType || 'movie'}:tmdb:${item.tmdbId}`;
    return `${item.mediaType || 'movie'}:title:${normalizeTitle(item.title || item.originalTitle)}`;
  }

  function seenTitles() {
    const titles = [];
    seenEntries.forEach((entry) => {
      const title = entry.split('::')[1];
      if (title) titles.push(title);
    });
    return titles;
  }

  function existingTitles() {
    return (window.MovieApp?.getMovies?.() || []).map((movie) => movie.title);
  }

  function isAlreadySaved(item) {
    const title = normalizeTitle(item.title);
    const mediaType = item.mediaType || 'movie';
    return (window.MovieApp?.getMovies?.() || []).some((movie) =>
      normalizeTitle(movie.title) === title && (movie.mediaType || 'movie') === mediaType
    );
  }

  function localTopUp(limit, knownKeys) {
    const blockedTitles = new Set(existingTitles().map(normalizeTitle));
    const picked = [];
    localRecommendations.forEach((item) => {
      if (picked.length >= limit) return;
      if (blockedTitles.has(normalizeTitle(item.title))) return;
      if (isSeen(item)) return;
      const key = recommendationKey(item);
      if (knownKeys.has(key)) return;
      knownKeys.add(key);
      picked.push(item);
    });
    return picked;
  }

  function setStatus(message, tone) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.className = `discover-status${tone ? ` discover-status--${tone}` : ''}`;
  }

  function setLoading(next) {
    loading = next;
    if (refreshBtn) {
      refreshBtn.disabled = next;
      updateRefreshBtn();
    }
    [likeBtn, skipBtn, watchedBtn].forEach((btn) => { if (btn) btn.disabled = next || !items[index]; });
  }

  function posterSrc(item) {
    return window.MovieDisplay?.posterUrl(item.poster) || item.poster || '';
  }

  function mediaLabel(item) {
    const mt = item.mediaType || 'movie';
    const tt = (k, f) => (window.t ? window.t(k) : f);
    if (window.MediaCategories?.isAnimeContent?.(item)) return tt('media.anime', 'Аниме');
    if (window.MediaCategories?.isAnimatedContent?.(item)) return tt('media.animation', 'Мультфильм');
    return mt === 'tv' ? tt('media.series', 'Сериал') : tt('media.movie', 'Фильм');
  }

  function ratingValue(item) {
    const r = item.voteAverage || item.rating || null;
    return r ? Number(r).toFixed(1) : null;
  }

  function movieHref(item) {
    if (!item.tmdbId) return null;
    return `/movie.html?type=${item.mediaType === 'tv' ? 'tv' : 'movie'}&id=${item.tmdbId}`;
  }

  // Минимальная карточка: постер, название, жанр+год, рейтинг. Остальное —
  // на странице фильма (открывается по тапу).
  function renderCard(item, offset) {
    const card = document.createElement('article');
    card.className = `discover-card${offset === 0 ? ' discover-card--top' : ' discover-card--behind'}`;
    card.style.setProperty('--stack-offset', String(offset));
    card.dataset.index = String(index + offset);

    const poster = posterSrc(item);
    const year = item.year
      || item.releaseDate?.slice(0, 4)
      || item.release_date?.slice(0, 4)
      || item.firstAirDate?.slice(0, 4)
      || item.first_air_date?.slice(0, 4)
      || item.meta?.year
      || '';
    const genre = (window.MovieDisplay?.displayGenres(item) || item.genres || [])[0] || '';
    const metaParts = [year, genre, mediaLabel(item)].filter(Boolean);
    const rating = ratingValue(item);
    const site = item.siteRating?.average
      ? `<span class="discover-rating discover-rating--site" title="${esc(tt('discover.siteRating', 'Средняя оценка зрителей сайта ({count})', { count: item.siteRating.count }))}">★ ${esc(String(item.siteRating.average))} <small>${esc(tt('discover.siteLabel', 'ваша оценка'))}</small></span>`
      : '';

    card.innerHTML = `
      <div class="discover-badge discover-badge--like">${esc(tt('discover.badge.like', 'Хочу'))}</div>
      <div class="discover-badge discover-badge--skip">${esc(tt('discover.badge.skip', 'Мимо'))}</div>
      <div class="discover-poster ${poster ? '' : 'discover-poster--empty'}">
        ${poster ? `<div class="discover-poster-bg" style="background-image:url('${esc(poster)}')"></div>` : ''}
        ${poster ? `<img src="${esc(poster)}" alt="${esc(window.MovieDisplay?.displayTitle(item) || item.title)}" loading="lazy" decoding="async" draggable="false">` : '<span>🎬</span>'}
        ${rating ? `<span class="discover-rating">★ ${esc(rating)}</span>` : ''}
        ${site}
      </div>
      <div class="discover-card-info">
        <h3 class="discover-card-title">${esc(window.MovieDisplay?.displayTitle(item) || item.title)}</h3>
        <p class="discover-card-meta">${esc(metaParts.join(' · ')) || mediaLabel(item)}</p>
      </div>
    `;

    if (offset === 0) attachSwipe(card, item);
    return card;
  }

  function renderStack() {
    stack.innerHTML = '';
    const visible = items.slice(index, index + 2);
    if (!visible.length) {
      stack.innerHTML = `
        <div class="discover-empty">
          <strong>${window.t ? window.t('discover.emptyTitle') : 'Карточки закончились'}</strong>
          <span>${window.t ? window.t('discover.emptyHint') : 'Нажмите «Обновить», чтобы получить новую пачку рекомендаций.'}</span>
        </div>
      `;
      setLoading(false);
      return;
    }

    visible.reverse().forEach((item, reverseOffset) => {
      const offset = visible.length - reverseOffset - 1;
      stack.appendChild(renderCard(item, offset));
    });
    setLoading(false);
  }

  function attachSwipe(card, item) {
    card.addEventListener('pointerdown', (event) => {
      if (loading) return;
      pointerState = { startX: event.clientX, startY: event.clientY, x: 0, y: 0, pointerId: event.pointerId };
      card.setPointerCapture(event.pointerId);
      card.classList.add('discover-card--dragging');
    });

    card.addEventListener('pointermove', (event) => {
      if (!pointerState || pointerState.pointerId !== event.pointerId) return;
      pointerState.x = event.clientX - pointerState.startX;
      pointerState.y = event.clientY - pointerState.startY;
      const y = pointerState.y * 0.12;
      const rotation = Math.max(-10, Math.min(10, pointerState.x / 14));
      card.style.transform = `translate(${pointerState.x}px, ${y}px) rotate(${rotation}deg)`;
      card.classList.toggle('discover-card--like', pointerState.x > SWIPE_THRESHOLD * 0.45);
      card.classList.toggle('discover-card--skip', pointerState.x < -SWIPE_THRESHOLD * 0.45);
    });

    card.addEventListener('pointerup', (event) => finishPointer(card, item, event.pointerId));
    card.addEventListener('pointercancel', (event) => finishPointer(card, item, event.pointerId, true));
  }

  function finishPointer(card, item, pointerId, cancelled = false) {
    if (!pointerState || pointerState.pointerId !== pointerId) return;
    const { x, y } = pointerState;
    pointerState = null;
    card.classList.remove('discover-card--dragging');

    if (!cancelled && x > SWIPE_THRESHOLD) {
      animateChoice('like');
    } else if (!cancelled && x < -SWIPE_THRESHOLD) {
      animateChoice('skip');
    } else if (!cancelled && Math.abs(x) < TAP_THRESHOLD && Math.abs(y) < TAP_THRESHOLD) {
      // Тап (не свайп) — открываем страницу фильма.
      const href = movieHref(item);
      if (href) { location.href = href; return; }
      card.style.transform = '';
      card.classList.remove('discover-card--like', 'discover-card--skip');
    } else {
      card.style.transform = '';
      card.classList.remove('discover-card--like', 'discover-card--skip');
    }
  }

  function animateChoice(choice, extra = null) {
    const card = stack.querySelector('.discover-card--top');
    if (!card || loading) return;
    setLoading(true);
    if (choice === 'skip') {
      card.classList.add('discover-card--out-skip');
    } else {
      card.classList.add('discover-card--out-like');
    }
    window.setTimeout(() => {
      if (choice === 'like') applyChoice('like');
      else if (choice === 'watched') applyChoice('watched', extra);
      else applyChoice('skip');
    }, 230);
  }

  function openWatchedRatingModal() {
    const item = items[index];
    if (!item || loading) return;
    const displayTitle = window.MovieDisplay?.displayTitle(item) || item.title;
    window.promptWatchedRating?.({ title: displayTitle }).then((rating) => {
      if (rating) animateChoice('watched', rating);
    });
  }

  // Глобальный счётчик реакций (все пользователи, в т.ч. гости).
  // Сервер принимает like/dislike/watched, поэтому свайп «Мимо» (skip)
  // отправляем как dislike — так левые свайпы тоже формируют соц. сигнал.
  function recordGlobal(item, action) {
    const globalAction = action === 'skip' ? 'dislike' : action;
    fetch('/api/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...window.authHeaders() },
      body: JSON.stringify({ tmdbId: item.tmdbId, mediaType: item.mediaType || 'movie', title: item.title, action: globalAction })
    }).catch(() => undefined);
  }

  async function applyChoice(action, rating = null) {
    const item = items[index];
    if (!item) { setLoading(false); return; }

    if (action === 'watched' && (!Number.isFinite(rating) || rating < 1 || rating > 10)) {
      setLoading(false);
      return;
    }

    // 0) Запоминаем карточку как «просмотренную» — больше не покажем её
    //    при следующих обновлениях ленты.
    markSeen(item);

    // 0.5) Гостевые свайпы — отдельное хранилище для переноса в аккаунт.
    if (!window.MovieApp?.isAuthenticated?.()) {
      window.GuestSwipeActions?.saveGuestSwipeAction?.(item, action, { rating: action === 'watched' ? rating : null });
    }

    // 1) Считаем реакцию глобально (лайк/дизлайк/смотрел).
    recordGlobal(item, action);

    // 1.5) Обновляем сессионный профиль вкуса свайпов и адаптируем ленту.
    //      Вправо (Хочу/Посмотрел) — усиливаем похожее; влево (Мимо) — понижаем.
    if (action === 'skip') {
      recordSwipeSignal(item, 'left');
      scheduleAdaptation();
    } else {
      recordSwipeSignal(item, 'right');
      scheduleAdaptation();
    }

    // 2) skip — просто дальше.
    if (action === 'skip') { nextCard(tt('discover.status.skip', 'Мимо')); return; }

    const displayTitle = window.MovieDisplay?.displayTitle(item) || item.title;

    // 3) like/watched — добавляем в список. Гость тоже может добавлять:
    //    список сохраняется локально и переносится в аккаунт после входа.
    if (isAlreadySaved(item)) {
      if (action === 'watched') {
        try {
          const result = await window.MovieApp.executeActions([{
            type: 'update_movie',
            title: item.title,
            mediaType: item.mediaType || 'movie',
            status: 'watched',
            rating
          }]);
          if (result?.[0]?.success) {
            nextCard(
              tt('discover.status.addedWatchedRated', 'В «Посмотрел»: {title} — {rating}/10', { title: displayTitle, rating }),
              'success'
            );
            return;
          }
          nextCard(result?.[0]?.error || tt('discover.status.addFailed', 'Не удалось добавить'), 'error');
        } catch (error) {
          nextCard(error.message || tt('discover.status.saveFailed', 'Не удалось сохранить'), 'error');
        } finally {
          setLoading(false);
        }
        return;
      }
      nextCard(tt('notify.alreadyInList', 'Фильм уже есть в списке'), 'success');
      return;
    }

    const status = action === 'watched' ? 'watched' : 'want';
    try {
      const result = await window.MovieApp.executeActions([{
        type: 'add_movie',
        title: item.title,
        status,
        rating: action === 'watched' ? rating : null,
        mediaType: item.mediaType || 'movie',
        tmdbId: item.tmdbId,
        genres: item.genres || [],
        meta: { poster: item.poster, year: item.year, overview: item.overview, originalTitle: item.originalTitle, matchSource: 'discover' }
      }]);
      if (result?.[0]?.success) {
        const msg = status === 'watched'
          ? tt('discover.status.addedWatchedRated', 'В «Посмотрел»: {title} — {rating}/10', { title: displayTitle, rating })
          : tt('discover.status.addedWant', 'В «Хочу»: {title}', { title: displayTitle });
        nextCard(msg, 'success');
        return;
      }
      nextCard(result?.[0]?.error || tt('discover.status.addFailed', 'Не удалось добавить'), 'error');
    } catch (error) {
      nextCard(error.message || tt('discover.status.saveFailed', 'Не удалось сохранить'), 'error');
    } finally {
      setLoading(false);
    }
  }

  function nextCard(message, tone) {
    index += 1;
    setStatus(message || '', tone);
    renderStack();
    if (items.length - index <= 3 && !loading) {
      loadFeed(true).catch(() => undefined);
    }
  }

  // Язык для запросов (TMDB-названия/описания карточек приходят на нём).
  function lang() {
    return (window.I18N && window.I18N.getLang) ? window.I18N.getLang() : 'ru';
  }

  // Запрос ленты: основной путь — POST /api/discover/feed с сессионным
  // профилем свайпов (адаптация в реальном времени). При ошибке — фолбэк
  // на старый GET /api/recommendations.
  async function requestRecommendations(bustCache) {
    const exclude = [
      ...existingTitles(),
      ...items.map((item) => item.title),
      ...seenTitles()
    ].filter(Boolean);

    // Пока пользователь не свайпал — обычная (кешируемая) персональная лента.
    // Как только появились свайпы — адаптивный POST-эндпоинт с сессией.
    if (hasSwipeSession()) {
      try {
        const response = await fetch('/api/discover/feed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...window.authHeaders() },
          body: JSON.stringify({ limit: BATCH_SIZE, excludeTitles: exclude, session: sessionPayload(), lang: lang() })
        });
        const data = await response.json();
        if (response.ok) return data.recommendations || [];
      } catch { /* уходим в фолбэк ниже */ }
    }

    const params = new URLSearchParams();
    params.set('limit', String(BATCH_SIZE));
    params.set('excludeTitles', exclude.join(','));
    params.set('lang', lang());
    if (bustCache) params.set('nocache', '1');
    const response = await fetch(`/api/recommendations?${params}`, { headers: window.authHeaders() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Ошибка загрузки');
    return data.recommendations || [];
  }

  async function fetchFeed(append, { bustCache = false } = {}) {
    const incoming = await requestRecommendations(bustCache);

    const knownKeys = new Set(items.map(recommendationKey));
    const fresh = incoming.filter((item) => {
      const key = recommendationKey(item);
      if (knownKeys.has(key) || isAlreadySaved(item) || isSeen(item)) return false;
      knownKeys.add(key);
      return true;
    });
    const topUp = localTopUp(Math.max(0, BATCH_SIZE - fresh.length), knownKeys);
    return append ? [...fresh, ...topUp] : [...fresh, ...topUp].slice(0, BATCH_SIZE);
  }

  // ── Адаптация ленты после свайпа вправо ────────────────────────────
  // Через 1–2 уже готовые карточки в очередь начинают попадать похожие
  // фильмы. Запрос мягко дебаунсится: пока один летит — следующий ставится
  // в очередь, а не дёргает сервер на каждый свайп.
  function scheduleAdaptation() {
    if (!hasSwipeSession()) return;
    if (adaptInFlight) { adaptQueued = true; return; }
    adaptInFlight = true;
    fetchAdaptedBatch()
      .then((batch) => { if (batch && batch.length) applyAdaptedFeed(batch); })
      .catch(() => undefined)
      .finally(() => {
        adaptInFlight = false;
        if (adaptQueued) { adaptQueued = false; scheduleAdaptation(); }
      });
  }

  async function fetchAdaptedBatch() {
    const exclude = [
      ...existingTitles(),
      ...seenTitles()
    ].filter(Boolean);
    const response = await fetch('/api/discover/feed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...window.authHeaders() },
      body: JSON.stringify({ limit: BATCH_SIZE, excludeTitles: exclude, session: sessionPayload(), lang: lang() })
    });
    const data = await response.json();
    if (!response.ok) return [];
    return data.recommendations || [];
  }

  // Сохраняем ближайшие 1–2 карточки (естественная задержка), а дальше
  // подменяем хвост очереди свежей адаптированной + смешанной подборкой.
  function applyAdaptedFeed(batch) {
    const GAP = 2;
    const keepUntil = Math.min(items.length, index + GAP);
    const head = items.slice(0, keepUntil);

    const known = new Set(head.map(recommendationKey));
    const fresh = batch.filter((item) => {
      const key = recommendationKey(item);
      if (known.has(key) || isAlreadySaved(item) || isSeen(item)) return false;
      known.add(key);
      return true;
    });
    if (!fresh.length) return;

    items = [...head, ...fresh];
    renderStack();
  }

  async function loadFeed(append = false) {
    if (loading && !append) return;
    const manual = !append;
    setLoading(true);
    if (!append) {
      // Ручное «Обновить»: помечаем уже показанную колоду как просмотренную,
      // иначе сервер вернёт те же фильмы (они ещё не попали в seen, ведь
      // пользователь мог не свайпать). Так каждая пачка приносит новое.
      if (manual) items.forEach(markSeen);
      items = [];
      index = 0;
      stack.innerHTML = window.LoadingUI?.aiRecommendations(tt('discover.loadingFeed', 'Загружаю свайп-ленту...'), 1, { tag: 'div' }) || `<div class="rec-empty">${esc(tt('common.loading', 'Загрузка...'))}</div>`;
      setStatus('');
    }

    try {
      let batch = await fetchFeed(append, { bustCache: manual });

      // Если на ручном обновлении всё уже просмотрено — сбрасываем память
      // и пробуем ещё раз, чтобы лента не оставалась пустой навсегда.
      if (manual && !batch.length && seenEntries.size) {
        resetSeen();
        batch = await fetchFeed(false, { bustCache: true });
      }

      items = append ? [...items, ...batch] : batch;
      if (!items.length) setStatus(window.t ? window.t('discover.nothing') : 'Пока нечего показать.', 'error');
      else if (manual) setStatus(window.t ? window.t('common.updated') : 'Подборка обновлена', 'success');
    } catch (error) {
      const knownKeys = new Set(items.map(recommendationKey));
      const fallback = localTopUp(BATCH_SIZE, knownKeys);
      items = append ? [...items, ...fallback] : fallback;
      setStatus(fallback.length ? tt('discover.localFallback', 'Показываю локальные рекомендации, сервер недоступен.') : (error.message || tt('errors.loading', 'Ошибка загрузки')), fallback.length ? '' : 'error');
    } finally {
      renderStack();
    }
  }

  refreshBtn?.addEventListener('click', () => loadFeed(false));
  likeBtn?.addEventListener('click', () => animateChoice('like'));
  skipBtn?.addEventListener('click', () => animateChoice('skip'));
  watchedBtn?.addEventListener('click', () => openWatchedRatingModal());

  // Смена языка: названия/описания карточек (TMDB) зависят от языка —
  // перезагружаем ленту, чтобы получить локализованные тайтлы.
  document.addEventListener('i18n:change', () => {
    updateRefreshBtn();
    if (items && items.length) loadFeed(false);
  });

  updateRefreshBtn();

  window.DiscoverPWA = {
    refresh: () => loadFeed(false)
  };
})();
