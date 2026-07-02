/* ===================================================================
   movie.js — отдельная мобильная страница фильма/сериала/мультфильма.
   URL: /movie.html?type=movie|tv&id=<tmdbId>
   Самодостаточна: не зависит от DOM index.html. Авторизацию читает из
   sessionStorage; для добавления в список нужен вход.
   =================================================================== */
(function () {
  const root = document.getElementById('movie-root');
  const toastEl = document.getElementById('movie-toast');
  const backBtn = document.getElementById('movie-back');

  const params = new URLSearchParams(location.search);
  const tmdbId = params.get('id');
  const mediaType = params.get('type') === 'tv' ? 'tv' : 'movie';

  function t(key, fallbackOrVars, vars) {
    const interpolation = vars ?? (
      fallbackOrVars && typeof fallbackOrVars === 'object' && !Array.isArray(fallbackOrVars)
        ? fallbackOrVars
        : undefined
    );
    if (window.t) {
      const out = window.t(key, interpolation);
      if (out !== key) return out;
    }
    if (typeof fallbackOrVars === 'string') {
      if (interpolation) {
        return fallbackOrVars.replace(/\{(\w+)\}/g, (m, name) =>
          interpolation[name] != null ? interpolation[name] : m);
      }
      return fallbackOrVars;
    }
    return key;
  }
  const lang = () => (window.I18N ? window.I18N.getLang() : 'ru');
  const tmdbApiLang = () => (window.I18N ? window.I18N.tmdbLang() : 'ru-RU');

  backBtn?.addEventListener('click', () => {
    if (history.length > 1) history.back();
    else location.href = '/';
  });

  function setupOfflineIndicator() {
    const topbar = document.querySelector('.moviepage-topbar');
    if (!topbar || document.getElementById('movie-offline-indicator')) return;
    const el = document.createElement('span');
    el.id = 'movie-offline-indicator';
    el.className = 'movie-offline-indicator';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    const sync = () => {
      const online = navigator.onLine;
      el.classList.toggle('is-offline', !online);
      el.title = online ? 'Онлайн' : 'Оффлайн';
      el.innerHTML = online
        ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M24 8.98C20.93 5.9 16.69 4 12 4S3.07 5.9 0 8.98L12 21 24 8.98zM2.92 9.07C5.51 7.08 8.67 6 12 6s6.49 1.08 9.08 3.07l-9.08 9.08-9.08-9.08z"/></svg>';
    };
    sync();
    topbar.appendChild(el);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
  }
  setupOfflineIndicator();

  function isOffline() {
    return !navigator.onLine;
  }

  function token() { return sessionStorage.getItem('token'); }
  function isLoggedIn() { return Boolean(token() && sessionStorage.getItem('username')); }
  function authHeaders() {
    const headers = {};
    const t = token();
    if (t) headers.Authorization = `Bearer ${t}`;
    if (window.I18N?.apiHeaders) Object.assign(headers, window.I18N.apiHeaders());
    return headers;
  }

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  let toastTimer = null;
  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
  }

  if (!tmdbId) {
    root.innerHTML = `<p class="moviepage-error">${esc(t('movie.notSpecified'))}</p>`;
    return;
  }

  function personHref(id) {
    return `/person.html?id=${encodeURIComponent(id)}`;
  }

  // ── Полноэкранный просмотр изображения с зумом и панорамированием ──
  let lightboxEl = null;
  let lbState = null;

  function buildLightbox() {
    const el = document.createElement('div');
    el.className = 'img-lightbox hidden';
    el.dataset.allowPinch = 'true';
    el.innerHTML = `
      <button type="button" class="img-lightbox-back">${esc(t('common.back'))}</button>
      <div class="img-lightbox-tools">
        <button type="button" class="img-lightbox-btn" data-act="out" aria-label="Уменьшить">−</button>
        <button type="button" class="img-lightbox-btn" data-act="reset" aria-label="Сбросить масштаб">1:1</button>
        <button type="button" class="img-lightbox-btn" data-act="in" aria-label="Увеличить">+</button>
      </div>
      <div class="img-lightbox-stage">
        <img class="img-lightbox-img" alt="">
      </div>`;
    document.body.appendChild(el);

    const stage = el.querySelector('.img-lightbox-stage');
    const img = el.querySelector('.img-lightbox-img');
    lbState = { scale: 1, x: 0, y: 0, dragging: false, sx: 0, sy: 0, ox: 0, oy: 0, moved: false };

    const apply = () => {
      img.style.transform = `translate(${lbState.x}px, ${lbState.y}px) scale(${lbState.scale})`;
      img.style.cursor = lbState.scale > 1 ? 'grab' : 'zoom-in';
      el.classList.toggle('img-lightbox--zoomed', lbState.scale > 1);
    };
    const reset = () => { lbState.scale = 1; lbState.x = 0; lbState.y = 0; apply(); };
    const setScale = (next) => {
      lbState.scale = Math.min(5, Math.max(1, next));
      if (lbState.scale === 1) { lbState.x = 0; lbState.y = 0; }
      apply();
    };

    el.querySelector('.img-lightbox-back').addEventListener('click', closeImageLightbox);
    el.querySelectorAll('.img-lightbox-btn').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'in') setScale(lbState.scale + 0.5);
        else if (act === 'out') setScale(lbState.scale - 0.5);
        else reset();
      });
    });

    // Клик по фону (вне картинки) закрывает; двойной клик по картинке — зум.
    stage.addEventListener('click', (e) => {
      if (lbState.moved) { lbState.moved = false; return; }
      if (e.target === img) {
        setScale(lbState.scale > 1 ? 1 : 2.5);
      } else {
        closeImageLightbox();
      }
    });

    // Колесо мыши — плавный зум.
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      setScale(lbState.scale + (e.deltaY < 0 ? 0.3 : -0.3));
    }, { passive: false });

    // Перетаскивание при увеличении (только мышь — тач обрабатываем ниже).
    img.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      if (lbState.scale <= 1) return;
      lbState.dragging = true; lbState.moved = false;
      lbState.sx = e.clientX; lbState.sy = e.clientY;
      lbState.ox = lbState.x; lbState.oy = lbState.y;
      img.setPointerCapture(e.pointerId);
      img.style.cursor = 'grabbing';
    });
    img.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      if (!lbState.dragging) return;
      const dx = e.clientX - lbState.sx;
      const dy = e.clientY - lbState.sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) lbState.moved = true;
      lbState.x = lbState.ox + dx;
      lbState.y = lbState.oy + dy;
      img.style.transform = `translate(${lbState.x}px, ${lbState.y}px) scale(${lbState.scale})`;
    });
    const endDrag = (e) => {
      if (e.pointerType === 'touch') return;
      if (!lbState.dragging) return;
      lbState.dragging = false;
      img.style.cursor = 'grab';
      try { img.releasePointerCapture(e.pointerId); } catch {}
    };
    img.addEventListener('pointerup', endDrag);
    img.addEventListener('pointercancel', endDrag);

    // ── Жесты на тач-устройствах: pinch-to-zoom двумя пальцами + панорама ──
    const touchDist = (touches) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.hypot(dx, dy);
    };
    let pinch = null; // { startDist, startScale }
    let touchPan = null; // { sx, sy, ox, oy }

    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        // Начало pinch — запоминаем расстояние между пальцами и текущий масштаб.
        pinch = { startDist: touchDist(e.touches) || 1, startScale: lbState.scale };
        touchPan = null;
        lbState.moved = true; // не считать как клик после жеста
        e.preventDefault();
      } else if (e.touches.length === 1) {
        lbState.moved = false;
        // Панорама одним пальцем (только когда увеличено).
        if (lbState.scale > 1) {
          const t = e.touches[0];
          touchPan = { sx: t.clientX, sy: t.clientY, ox: lbState.x, oy: lbState.y };
        }
      }
    }, { passive: false });

    stage.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const ratio = touchDist(e.touches) / pinch.startDist;
        setScale(pinch.startScale * ratio);
      } else if (touchPan && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        const dx = t.clientX - touchPan.sx;
        const dy = t.clientY - touchPan.sy;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) lbState.moved = true;
        lbState.x = touchPan.ox + dx;
        lbState.y = touchPan.oy + dy;
        img.style.transform = `translate(${lbState.x}px, ${lbState.y}px) scale(${lbState.scale})`;
      }
    }, { passive: false });

    const endTouch = (e) => {
      if (e.touches.length < 2) pinch = null;
      if (e.touches.length === 0) touchPan = null;
    };
    stage.addEventListener('touchend', endTouch);
    stage.addEventListener('touchcancel', endTouch);

    el._img = img;
    el._reset = reset;
    return el;
  }

  function onLightboxKey(e) {
    if (e.key === 'Escape') closeImageLightbox();
  }

  function openImageLightbox(src, alt) {
    if (!src) return;
    if (!lightboxEl) lightboxEl = buildLightbox();
    lightboxEl._reset();
    lightboxEl._img.src = src;
    lightboxEl._img.alt = alt || '';
    lightboxEl.classList.remove('hidden');
    document.body.classList.add('img-lightbox-open');
    document.addEventListener('keydown', onLightboxKey);
  }

  function closeImageLightbox() {
    if (!lightboxEl) return;
    lightboxEl.classList.add('hidden');
    document.body.classList.remove('img-lightbox-open');
    document.removeEventListener('keydown', onLightboxKey);
  }

  // Список «чипов» рейтингов (TMDB / IMDb / Кинопоиск / оценка сайта).
  function ratingChips(meta) {
    const items = [];
    if (meta.voteAverage) items.push(`<span class="movie-rating movie-rating--tmdb"><span class="movie-rating-src">TMDB</span><span class="movie-rating-val">${Number(meta.voteAverage).toFixed(1)}</span></span>`);
    if (meta.imdb?.rating) items.push(`<span class="movie-rating movie-rating--imdb"><span class="movie-rating-src">IMDb</span><span class="movie-rating-val">${esc(meta.imdb.rating)}</span></span>`);
    if (meta.kinopoisk?.rating) items.push(`<span class="movie-rating movie-rating--kp"><span class="movie-rating-src">${esc(t('rating.kinopoisk'))}</span><span class="movie-rating-val">${esc(meta.kinopoisk.rating)}</span></span>`);
    if (meta.siteRating?.average) {
      const c = meta.siteRating.count;
      const word = lang() === 'en'
        ? (c === 1 ? 'vote' : 'votes')
        : (c % 10 === 1 && c % 100 !== 11 ? 'оценка' : (c % 10 >= 2 && c % 10 <= 4 && (c % 100 < 10 || c % 100 >= 20) ? 'оценки' : 'оценок'));
      items.push(`<span class="movie-rating movie-rating--site" title="${esc(t('rating.siteTitle'))} (${c} ${word})"><span class="movie-rating-src">${esc(t('rating.site'))}</span><span class="movie-rating-val">${esc(meta.siteRating.average)} <small>· ${c}</small></span></span>`);
    }
    return items;
  }

  // Отдельный аккуратный блок рейтингов над описанием фильма.
  function ratingsHtml(meta) {
    const items = ratingChips(meta);
    if (!items.length) return '';
    return `
      <section class="movie-block movie-ratings-block">
        <h2 class="movie-block-title">${esc(t('movie.ratings'))}</h2>
        <div class="movie-ratings">${items.join('')}</div>
      </section>`;
  }

  function metaLine(data) {
    const m = data.meta || {};
    const parts = [];
    if (m.year) parts.push(esc(m.year));
    parts.push(data.mediaType === 'tv' ? t('common.series') : t('common.film'));
    if (m.runtime) parts.push(`${m.runtime} ${t('common.minutes')}`);
    if (m.seasons) parts.push(`${m.seasons} ${t('common.seasonsShort')}`);
    if (m.country) parts.push(esc(m.country));
    return parts.join(' · ');
  }

  // Кликабельный «чип» человека (актёр) → переход на страницу человека.
  function castChip(c) {
    if (c && c.id) {
      return `<a class="movie-cast-chip movie-cast-chip--link" href="${personHref(c.id)}">${esc(c.name)}</a>`;
    }
    return `<span class="movie-cast-chip">${esc(c.name || c)}</span>`;
  }

  function castHtml(meta) {
    const cast = meta.castDetails?.length
      ? meta.castDetails
      : (meta.cast ? String(meta.cast).split(',').map((s) => ({ name: s.trim() })) : []);
    if (!cast.length) return '';
    const chips = cast.slice(0, 12).map(castChip).join('');
    return `
      <section class="movie-block">
        <h2 class="movie-block-title">${esc(t('movie.cast'))}</h2>
        <div class="movie-cast">${chips}</div>
      </section>`;
  }

  // Блок «Сценарий» — кликабельные сценаристы (если есть данные с id).
  function writersHtml(meta) {
    const writers = meta.writerDetails?.length
      ? meta.writerDetails
      : (meta.writers ? String(meta.writers).split(',').map((s) => ({ name: s.trim() })) : []);
    if (!writers.length) return '';
    const chips = writers.slice(0, 6).map(castChip).join('');
    return `
      <section class="movie-block">
        <h2 class="movie-block-title">${esc(t('movie.writers'))}</h2>
        <div class="movie-cast">${chips}</div>
      </section>`;
  }

  function trailerHtml(meta) {
    if (!meta.trailer?.key) return '';
    return `
      <section class="movie-block">
        <h2 class="movie-block-title">${esc(t('movie.trailer'))}</h2>
        <div class="movie-trailer">
          <iframe
            src="https://www.youtube.com/embed/${encodeURIComponent(meta.trailer.key)}"
            title="${esc(meta.trailer.name || t('movie.trailerDefault'))}"
            frameborder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen></iframe>
        </div>
      </section>`;
  }

  // Кнопка внешнего сайта: рабочая ссылка только при подтверждённом совпадении.
  // Пока проверяем — состояние «checking». Не нашли — неактивная кнопка.
  function siteBtn({ label, url, matched, loaded, mod }) {
    if (matched && url) {
      return `<a class="movie-watch-btn movie-watch-btn--${mod}" href="${esc(url)}" target="_blank" rel="noopener">${esc(t('movie.watchOn', { site: label }))}</a>`;
    }
    if (!loaded) {
      return `<span class="movie-watch-btn movie-watch-btn--${mod} movie-watch-btn--checking" aria-disabled="true">${esc(t('movie.checking', { site: label }))}</span>`;
    }
    return `<span class="movie-watch-btn movie-watch-btn--${mod} movie-watch-btn--disabled" aria-disabled="true" title="${esc(t('movie.notOn', { site: label }))}">${esc(t('movie.notOn', { site: label }))}</span>`;
  }

  // Внешние ссылки (просмотр / поиск) — отдельный блок в самом низу страницы.
  function watchLinksHtml(meta, data) {
    const loaded = Boolean(meta._extrasLoaded);
    const links = [];
    links.push(siteBtn({ label: 'HDRezka', url: meta.hdrezkaUrl, matched: meta.hdrezkaMatched, loaded, mod: 'hdrezka' }));
    links.push(siteBtn({ label: 'Kinogo', url: meta.kinogoUrl, matched: meta.kinogoMatched, loaded, mod: 'kinogo' }));

    const kindWord = data.mediaType === 'tv' ? t('common.series') : t('common.film');
    const query = encodeURIComponent(`${data.title} ${kindWord} ${lang() === 'en' ? 'watch online' : 'смотреть онлайн'}`);
    links.push(`<a class="movie-watch-btn movie-watch-btn--search" href="https://www.google.com/search?q=${query}" target="_blank" rel="noopener">${esc(t('movie.findGoogle'))}</a>`);

    const missing = loaded && (!meta.hdrezkaMatched || !meta.kinogoMatched);
    const note = missing
      ? `<p class="movie-watch-note">${esc(t('movie.watchNote', { kind: kindWord.toLowerCase() }))}</p>`
      : '';
    return `<div class="movie-watch-links">${links.join('')}</div>${note}`;
  }

  function watchSectionHtml(meta, data) {
    return `
      <section class="movie-block movie-watch-section">
        <h2 class="movie-block-title">${esc(t('movie.whereToWatch'))}</h2>
        <div id="movie-watch-slot">${watchLinksHtml(meta, data)}</div>
      </section>`;
  }

  function addControlsHtml() {
    return `
      <div class="movie-add">
        <p class="movie-add-label">${esc(t('movie.addToList'))}</p>
        <div class="movie-add-actions">
          <button type="button" class="movie-add-btn movie-add-btn--want" data-status="want">${esc(t('movie.want'))}</button>
          <button type="button" class="movie-add-btn movie-add-btn--watched" data-status="watched">${esc(t('movie.markWatched', 'Посмотрел'))}</button>
        </div>
      </div>
      <div class="movie-user-rating hidden" id="movie-user-rating">
        <p class="movie-user-rating__label">${esc(t('movie.myRating', 'Моя оценка'))}</p>
        <div class="movie-user-rating__row">
          <span class="movie-user-rating__value" id="movie-user-rating-value"></span>
          <button type="button" class="movie-user-rating__btn" id="movie-user-rating-btn"></button>
        </div>
      </div>`;
  }

  let listEntry = null;

  function applyAddButtonState(status, entry = listEntry) {
    const wantBtn = root.querySelector('.movie-add-btn--want');
    const watchedBtn = root.querySelector('.movie-add-btn--watched');
    if (!wantBtn || !watchedBtn) return;

    wantBtn.classList.remove('movie-add-btn--in-list');
    watchedBtn.classList.remove('movie-add-btn--in-list');
    wantBtn.disabled = false;
    watchedBtn.disabled = false;
    wantBtn.textContent = t('movie.want');
    watchedBtn.textContent = t('movie.markWatched', 'Посмотрел');

    if (status === 'want') {
      wantBtn.classList.add('movie-add-btn--in-list');
      wantBtn.textContent = t('movie.inList');
      wantBtn.disabled = true;
    } else if (status === 'watched') {
      watchedBtn.classList.add('movie-add-btn--in-list');
      watchedBtn.textContent = entry?.rating
        ? t('movie.watchedRated', '✓ Посмотрел · {rating}/10', { rating: entry.rating })
        : t('movie.watchedInList', '✓ Посмотрел');
      watchedBtn.disabled = true;
    }

    applyUserRatingState(entry);
  }

  function applyUserRatingState(entry = listEntry) {
    const block = root.querySelector('#movie-user-rating');
    const valueEl = root.querySelector('#movie-user-rating-value');
    const btn = root.querySelector('#movie-user-rating-btn');
    if (!block || !valueEl || !btn) return;

    if (!isLoggedIn() || entry?.status !== 'watched') {
      block.classList.add('hidden');
      block.classList.remove('movie-user-rating--pending');
      return;
    }

    block.classList.remove('hidden');
    if (entry.rating) {
      valueEl.textContent = t('movie.myRatingValue', '{rating}/10', { rating: entry.rating });
      valueEl.classList.remove('movie-user-rating__value--empty');
      btn.textContent = t('movie.changeRating', 'Изменить');
      block.classList.remove('movie-user-rating--pending');
    } else {
      valueEl.textContent = t('movie.noRatingYet', 'Без оценки');
      valueEl.classList.add('movie-user-rating__value--empty');
      btn.textContent = t('movie.rateNow', 'Оценить');
      block.classList.add('movie-user-rating--pending');
    }
  }

  async function saveWatchedRating(data, rating) {
    const res = await fetch('/api/movies/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        tmdbId: data.tmdbId,
        mediaType: data.mediaType,
        status: 'watched',
        rating,
        title: data.title,
        genres: data.genres,
        poster: data.meta?.poster
      })
    });
    if (res.status === 401) {
      toast(t('auth.sessionExpired'));
      return null;
    }
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || t('movie.ratingFailed', 'Не удалось сохранить оценку'));
    return out.movie || { ...listEntry, status: 'watched', rating };
  }

  async function openWatchedRatingEditor(data) {
    if (!isLoggedIn()) {
      toast(t('auth.loginToAdd'));
      return;
    }
    if (listEntry?.status !== 'watched') return;

    const rating = await window.promptWatchedRating?.({
      title: data.title,
      initialRating: listEntry.rating ?? undefined,
      confirmLabel: t('movie.saveRating', 'Сохранить оценку')
    });
    if (!rating) return;

    const btn = root.querySelector('#movie-user-rating-btn');
    if (btn) btn.disabled = true;
    try {
      const updated = await saveWatchedRating(data, rating);
      if (!updated) return;
      listEntry = updated;
      applyAddButtonState('watched', listEntry);
      toast(t('movie.ratingSaved', 'Оценка сохранена'));
    } catch (err) {
      toast(err.message || t('movie.ratingFailed', 'Не удалось сохранить оценку'));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function refreshListStatus(movieData) {
    if (!isLoggedIn()) return;
    try {
      const res = await fetch('/api/movies', { headers: authHeaders() });
      if (!res.ok) return;
      const payload = await res.json();
      const movies = Array.isArray(payload.movies) ? payload.movies : [];
      const id = Number(movieData.tmdbId || tmdbId);
      listEntry = movies.find((m) => m.tmdbId === id && (m.mediaType || 'movie') === mediaType) || null;
      applyAddButtonState(listEntry?.status || null, listEntry);
    } catch { /* ignore */ }
  }

  function render(data) {
    const meta = data.meta || {};
    const backdrop = meta.backdrop || meta.poster || '';
    const genres = (data.genres || []).slice(0, 5).map((g) => `<span class="movie-genre">${esc(g)}</span>`).join('');

    root.innerHTML = `
      <div class="movie-hero${backdrop ? ' movie-hero--zoomable' : ''}">
        ${backdrop ? `<div class="movie-hero-bg" style="background-image:url('${esc(backdrop)}')"></div>` : ''}
        <div class="movie-hero-overlay"></div>
        ${backdrop ? `<button type="button" class="movie-hero-expand" aria-label="${esc(t('movie.expand'))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>` : ''}
        <div class="movie-hero-content">
          ${meta.poster ? `<img class="movie-hero-poster" src="${esc(meta.poster)}" alt="${esc(data.title)}" loading="lazy">` : ''}
          <div class="movie-hero-text">
            <h1 class="movie-title">${esc(data.title)}</h1>
            ${meta.originalTitle && meta.originalTitle !== data.title ? `<p class="movie-original">${esc(meta.originalTitle)}</p>` : ''}
            <p class="movie-metaline">${metaLine(data)}</p>
            ${genres ? `<div class="movie-genres">${genres}</div>` : ''}
          </div>
        </div>
      </div>

      <div class="movie-body">
        ${meta.tagline ? `<p class="movie-tagline">«${esc(meta.tagline)}»</p>` : ''}
        ${addControlsHtml()}
        <div id="movie-ratings-slot">${ratingsHtml(meta)}</div>
        <div id="player-section"></div>
        <div id="torrents-section"></div>
        ${meta.overview ? `
          <section class="movie-block">
            <h2 class="movie-block-title">${esc(t('movie.overview'))}</h2>
            <p class="movie-overview">${esc(meta.overview)}</p>
          </section>` : ''}
        ${meta.director ? `
          <section class="movie-block movie-block--inline">
            <h2 class="movie-block-title">${esc(t('movie.director'))}</h2>
            <p>${meta.directorId
              ? `<a class="movie-person-link" href="${personHref(meta.directorId)}">${esc(meta.director)}</a>`
              : esc(meta.director)}</p>
          </section>` : ''}
        ${writersHtml(meta)}
        ${castHtml(meta)}
        ${trailerHtml(meta)}
        ${watchSectionHtml(meta, data)}
      </div>`;

    root.querySelectorAll('.movie-add-btn').forEach((btn) => {
      btn.addEventListener('click', () => addToList(btn.dataset.status, data, btn));
    });

    root.querySelector('#movie-user-rating-btn')?.addEventListener('click', () => {
      openWatchedRatingEditor(data);
    });

    refreshListStatus(data);

    // Баннер и постер открываются на весь экран с возможностью увеличения.
    const heroEl = root.querySelector('.movie-hero--zoomable');
    if (heroEl && backdrop) {
      heroEl.addEventListener('click', (e) => {
        if (e.target.closest('.movie-hero-poster')) return;
        openImageLightbox(backdrop, data.title);
      });
    }
    const posterEl = root.querySelector('.movie-hero-poster');
    if (posterEl && meta.poster) {
      posterEl.style.cursor = 'zoom-in';
      posterEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openImageLightbox(meta.poster, data.title);
      });
    }

    document.title = `${data.title} — ${t('nav.brand')}`;
  }

  async function addToList(status, data, btn) {
    if (!isLoggedIn()) {
      toast(t('auth.loginToAdd'));
      setTimeout(() => { location.href = '/'; }, 1500);
      return;
    }

    let rating = null;
    if (status === 'watched') {
      rating = await window.promptWatchedRating?.({ title: data.title });
      if (!rating) return;
    }

    btn.disabled = true;
    btn.textContent = t('movie.adding');
    try {
      const res = await fetch('/api/movies/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          tmdbId: data.tmdbId,
          mediaType: data.mediaType,
          status,
          rating,
          title: data.title,
          genres: data.genres,
          poster: data.meta?.poster
        })
      });
      if (res.status === 401) {
        toast(t('auth.sessionExpired'));
        applyAddButtonState(listEntry?.status || null, listEntry);
        return;
      }
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || t('common.error'));
      listEntry = out.movie || { status, rating, tmdbId: data.tmdbId, mediaType: data.mediaType };
      applyAddButtonState(status, listEntry);
      toast(status === 'watched' ? t('movie.addedWatched') : t('movie.addedWant'));
    } catch (err) {
      applyAddButtonState(listEntry?.status || null, listEntry);
      toast(err.message || t('movie.addFailed'));
    }
  }

  // Подгружаем «доп-данные» (рейтинги IMDb/Кинопоиск + ссылка на Kinogo)
  // отдельно и дорисовываем их на уже отрендеренной странице. Так основная
  // страница появляется мгновенно, а медленный скрейпинг не блокирует показ.
  async function loadExtras(data) {
    const meta = data.meta || (data.meta = {});
    try {
      const res = await fetch(`/api/movie/extras/${encodeURIComponent(tmdbId)}?type=${mediaType}&lang=${lang()}`, {
        headers: authHeaders()
      });
      if (res.ok) {
        const extras = await res.json();
        if (extras.imdb) meta.imdb = extras.imdb;
        if (extras.kinopoisk) meta.kinopoisk = extras.kinopoisk;
        if (extras.hdrezkaUrl) meta.hdrezkaUrl = extras.hdrezkaUrl;
        if (extras.kinogoUrl) meta.kinogoUrl = extras.kinogoUrl;
        meta.hdrezkaMatched = Boolean(extras.hdrezkaMatched);
        meta.kinogoMatched = Boolean(extras.kinogoMatched);
      }
    } catch { /* доп-данные необязательны — молча игнорируем */ }
    finally {
      // Проверка завершена (успешно или нет) — обновляем кнопки и рейтинги.
      meta._extrasLoaded = true;
      const ratingsSlot = document.getElementById('movie-ratings-slot');
      if (ratingsSlot) ratingsSlot.innerHTML = ratingsHtml(meta);
      const watchSlot = document.getElementById('movie-watch-slot');
      if (watchSlot) watchSlot.innerHTML = watchLinksHtml(meta, data);
    }
  }

  // ── Нативный плеер HDRezka ───────────────────────────────────────
  let playerState = null;

  function pickDefaultQuality(qualities) {
    const byLabel = qualities.find((q) => /(^|\D)720p/i.test(q.label));
    return (byLabel || qualities[0])?.label || null;
  }

  function playerApiUrl(overrides = {}) {
    const s = { ...playerState, ...overrides };
    const params = new URLSearchParams({ type: s.type });
    if (s.activeVoice) params.set('translator', s.activeVoice);
    if (s.isSeries && s.activeSeason) params.set('season', s.activeSeason);
    if (s.isSeries && s.activeEpisode) params.set('episode', s.activeEpisode);
    return `/api/movie/player/${encodeURIComponent(s.id)}?${params}`;
  }

  function renderPlayerError(slot) {
    const body = slot.querySelector('.movie-player-status');
    if (body) {
      body.textContent = t('movie.playerUnavailable');
      body.classList.add('movie-player-status--error');
    }
  }

  function seasonLabel(season) {
    return season.label && !/^\d+$/.test(season.label)
      ? season.label
      : t('movie.seasonN', { n: season.id });
  }

  function episodeLabel(ep) {
    return ep.label && !/^\d+$/.test(ep.label)
      ? ep.label
      : t('movie.episodeN', { n: ep.id });
  }

  function playerChip(active, attrs, label, { multiline = false } = {}) {
    const titleAttr = multiline ? ` title="${esc(label)}"` : '';
    const content = multiline
      ? `<span class="movie-player-chip__label">${esc(label)}</span>`
      : esc(label);
    return `<button type="button" class="movie-player-chip${multiline ? ' movie-player-chip--multiline' : ''}${active ? ' is-active' : ''}" ${attrs}${titleAttr}>${content}</button>`;
  }

  function subtitleSrclang(lang) {
    const l = String(lang || '').toLowerCase();
    if (/рус|rus|russian/.test(l)) return 'ru';
    if (/eng|англ|english/.test(l)) return 'en';
    if (/каз|kaz|қазақ|qazaq/.test(l)) return 'kk';
    return 'ru';
  }

  function subtitleTracksHtml(subtitles) {
    if (!subtitles?.length) return '';
    return subtitles.map((s, i) => {
      const src = String(s.url || '').trim();
      if (!src) return '';
      return `<track kind="captions" label="${esc(s.lang)}" srclang="${esc(subtitleSrclang(s.lang))}" src="${esc(src)}"${i === 0 ? ' default' : ''}>`;
    }).join('');
  }

  function playerLayoutHtml() {
    const { voices, activeVoice, qualities, activeQuality, isSeries, seasons, activeSeason, activeEpisode, subtitles } = playerState;

    const voiceSection = voices.length > 1
      ? `<div class="movie-player-voices">
           <div class="movie-player-voices__head">
             <span class="movie-player-voices__title">${esc(t('movie.selectVoice'))}</span>
           </div>
           <div class="movie-player-voices__grid">
             ${voices.map((v) => playerChip(
               String(v.id) === String(activeVoice),
               `data-voice-id="${esc(v.id)}"`,
               v.name,
               { multiline: true }
             )).join('')}
           </div>
         </div>`
      : '';

    const seasonSection = isSeries && seasons.length
      ? `<div class="movie-player-seasons" role="tablist" aria-label="${esc(t('movie.season'))}">
           ${seasons.map((s) => playerChip(
             s.id === activeSeason,
             `data-season-id="${s.id}"`,
             seasonLabel(s)
           )).join('')}
         </div>`
      : '';

    const activeSeasonData = seasons.find((s) => s.id === activeSeason);
    const episodeSection = isSeries && activeSeasonData?.episodes?.length
      ? `<div class="movie-player-episodes" role="tablist" aria-label="${esc(t('movie.episode'))}">
           ${activeSeasonData.episodes.map((e) => playerChip(
             e.id === activeEpisode,
             `data-episode-id="${e.id}"`,
             episodeLabel(e)
           )).join('')}
         </div>`
      : '';

    return `
      ${voiceSection}
      ${seasonSection}
      <div class="movie-player">
        <div class="custom-player-shell">
          <video class="movie-player-video" playsinline preload="metadata" crossorigin="anonymous">
            ${subtitleTracksHtml(subtitles)}
          </video>
        </div>
      </div>
      ${episodeSection}`;
  }

  function currentQualityUrl() {
    const q = playerState.qualities.find((x) => x.label === playerState.activeQuality)
      || playerState.qualities[0];
    return q?.url || '';
  }

  function playbackUrl(directUrl) {
    if (!directUrl) return '';
    return `/api/movie/stream?url=${encodeURIComponent(directUrl)}`;
  }

  function bindVideoElement(video, slot) {
    if (!video || video.dataset.bound) return;
    video.dataset.bound = '1';
    video.crossOrigin = 'anonymous';
    video.addEventListener('error', () => {
      const code = video.error?.code;
      if (code === 4 || code === 2) {
        toast(t('movie.playerStreamError'));
      }
      const block = slot?.querySelector('.movie-player-block');
      const status = block?.querySelector('.movie-player-status');
      if (status) {
        status.textContent = t('movie.playerStreamError');
        status.classList.add('movie-player-status--error');
        status.hidden = false;
      }
    });

    const captionLang = (window.I18N?.getLang?.() === 'en') ? 'en'
      : (window.I18N?.getLang?.() === 'kk') ? 'kk' : 'ru';

    window.MoviePlyr?.init(video, {
      qualities: playerState?.qualities || [],
      activeQuality: playerState?.activeQuality,
      captionLanguage: captionLang,
      onQualityChange: (plyrQ) => {
        const label = window.MoviePlyr?.qualityLabelFromPlyr?.(plyrQ, playerState?.qualities);
        if (!label || label === playerState.activeQuality) return;
        playerState.activeQuality = label;
        swapVideoSource(video, currentQualityUrl(), {
          resumeTime: video.currentTime,
          wasPlaying: !video.paused
        });
      }
    });

    bindViewingProgressTracking(video, slot);
  }

  function buildViewingPayload(video, { ended = false } = {}) {
    if (!currentData || !playerState) return null;
    const meta = currentData.meta || {};
    return {
      tmdbId: currentData.tmdbId || Number(tmdbId),
      mediaType: currentData.mediaType || mediaType,
      title: currentData.title,
      year: meta.year || null,
      poster: meta.poster || null,
      genres: currentData.genres || [],
      originalLanguage: meta.originalLanguage || null,
      position: video?.currentTime || 0,
      duration: video?.duration || 0,
      season: playerState.isSeries ? playerState.activeSeason : null,
      episode: playerState.isSeries ? playerState.activeEpisode : null,
      ended
    };
  }

  function saveViewingProgress(video, options) {
    const payload = buildViewingPayload(video, options);
    if (!payload || !window.ViewingHistory) return;
    if (!payload.duration && !options?.ended) return;
    window.ViewingHistory.upsertEntry(payload);
  }

  function bindViewingProgressTracking(video, slot) {
    if (!video || video.dataset.viewingBound) return;
    video.dataset.viewingBound = '1';

    let lastSavedAt = 0;
    const maybeSave = (options = {}) => {
      const now = Date.now();
      if (!options.force && now - lastSavedAt < 15000) return;
      lastSavedAt = now;
      saveViewingProgress(video, options);
    };

    video.addEventListener('timeupdate', () => {
      if (video.paused || !video.duration) return;
      maybeSave();
    });
    video.addEventListener('pause', () => maybeSave({ force: true }));
    video.addEventListener('ended', () => saveViewingProgress(video, { ended: true, force: true }));
    window.addEventListener('beforeunload', () => {
      window.ViewingHistory?.flushSave?.();
    });
  }

  function swapVideoSource(video, url, { resumeTime = 0, wasPlaying = false } = {}) {
    if (!url) return;
    video.src = playbackUrl(url);
    const restore = () => {
      video.removeEventListener('loadedmetadata', restore);
      let targetTime = resumeTime;
      if ((!targetTime || targetTime <= 0) && window.ViewingHistory && playerState) {
        targetTime = window.ViewingHistory.getResumePosition(
          currentData?.tmdbId || Number(tmdbId),
          currentData?.mediaType || mediaType,
          playerState.activeSeason,
          playerState.activeEpisode
        );
      }
      if (targetTime > 0 && Number.isFinite(targetTime)) {
        try { video.currentTime = targetTime; } catch {}
      }
      if (wasPlaying) video.play().catch(() => {});
    };
    video.addEventListener('loadedmetadata', restore);
    video.load();
  }

  function applyPlayerData(data, slot, video, { resumeTime = 0, wasPlaying = false } = {}) {
    window.MoviePlyr?.destroy();

    playerState.voices = data.voices || playerState.voices;
    playerState.activeVoice = data.activeVoice || playerState.activeVoice;
    playerState.qualities = data.qualities;
    playerState.isSeries = Boolean(data.isSeries);
    playerState.seasons = data.seasons || playerState.seasons || [];
    playerState.activeSeason = data.activeSeason ?? playerState.activeSeason;
    playerState.activeEpisode = data.activeEpisode ?? playerState.activeEpisode;
    playerState.subtitles = data.subtitles || [];

    if (!playerState.qualities.some((q) => q.label === playerState.activeQuality)) {
      playerState.activeQuality = pickDefaultQuality(playerState.qualities);
    }

    const block = slot.querySelector('.movie-player-block');
    const wrap = block.querySelector('.movie-player-wrap');
    if (wrap) {
      wrap.innerHTML = playerLayoutHtml();
      video = wrap.querySelector('.movie-player-video');
      bindVideoElement(video, slot);
      bindPlayerControls(slot);
    }

    swapVideoSource(video, currentQualityUrl(), { resumeTime, wasPlaying });
  }

  function bindPlayerControls(slot) {
    const wrap = slot.querySelector('.movie-player-wrap');
    if (!wrap || wrap.dataset.controlsBound) return;
    wrap.dataset.controlsBound = '1';

    wrap.addEventListener('click', (e) => {
      const video = wrap.querySelector('.movie-player-video');
      if (!video) return;

      const voiceBtn = e.target.closest('[data-voice-id]');
      if (voiceBtn) {
        e.preventDefault();
        if (voiceBtn.classList.contains('is-active')) return;
        reloadPlayer(slot, video, { translator: voiceBtn.dataset.voiceId });
        return;
      }

      const seasonBtn = e.target.closest('[data-season-id]');
      if (seasonBtn) {
        e.preventDefault();
        if (seasonBtn.classList.contains('is-active')) return;
        const season = Number(seasonBtn.dataset.seasonId);
        const firstEp = playerState.seasons.find((s) => s.id === season)?.episodes?.[0]?.id;
        reloadPlayer(slot, video, { season, episode: firstEp });
        return;
      }

      const episodeBtn = e.target.closest('[data-episode-id]');
      if (episodeBtn) {
        e.preventDefault();
        if (episodeBtn.classList.contains('is-active')) return;
        reloadPlayer(slot, video, { episode: Number(episodeBtn.dataset.episodeId) });
      }
    });
  }

  async function reloadPlayer(slot, video, { translator, season, episode } = {}) {
    if (video) saveViewingProgress(video, { force: true });
    const resumeTime = video?.currentTime || 0;
    const wasPlaying = video ? !video.paused : false;
    try {
      const params = {
        type: playerState.type,
        activeVoice: translator || playerState.activeVoice,
        activeSeason: season ?? playerState.activeSeason,
        activeEpisode: episode ?? playerState.activeEpisode
      };
      const res = await fetch(playerApiUrl(params), { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!data?.qualities?.length) {
        toast(translator ? t('movie.voiceFailed') : t('movie.episodeFailed'));
        return;
      }
      applyPlayerData(data, slot, video, { resumeTime, wasPlaying });
    } catch {
      toast(translator ? t('movie.voiceFailed') : t('movie.episodeFailed'));
    }
  }

  function mountPlayerUI(slot) {
    window.MoviePlyr?.destroy();
    const block = slot.querySelector('.movie-player-block');
    block.querySelector('.movie-player-status')?.remove();

    const wrap = document.createElement('div');
    wrap.className = 'movie-player-wrap';
    wrap.innerHTML = playerLayoutHtml();
    block.appendChild(wrap);

    const video = block.querySelector('.movie-player-video');
    bindVideoElement(video, slot);
    bindPlayerControls(slot);
    swapVideoSource(video, currentQualityUrl());
  }

  function playerSourceLabel(source) {
    const map = {
      youtube: 'YouTube',
      rutube: 'Rutube',
      vk: 'VK Видео',
      dailymotion: 'Dailymotion',
      hdrezka: 'HDRezka'
    };
    return map[source] || source || '—';
  }

  function mediaLangBadge(langCode) {
    if (!langCode) return '';
    const label = langCode === 'ru' ? 'RU' : (langCode === 'en' ? 'EN' : 'RU+EN');
    return `<span class="media-badge media-badge--lang" title="${esc(label)}">${esc(label)}</span>`;
  }

  function mediaIndicatorsHtml(payload) {
    const parts = [];
    if (payload?.hasCaptions) parts.push('<span class="media-badge media-badge--sub" title="Субтитры">SUB</span>');
    if (payload?.audioLang) parts.push(mediaLangBadge(payload.audioLang));
    if (payload?.dub) parts.push('<span class="media-badge media-badge--dub" title="Дубляж">DUB</span>');
    if (!parts.length) return '';
    return `<div class="media-indicators">${parts.join('')}</div>`;
  }

  function torrentIndicatorsHtml(meta) {
    const parts = [];
    if (meta?.subtitles) parts.push('<span class="media-badge media-badge--sub" title="Субтитры">SUB</span>');
    if (meta?.audioLang) parts.push(mediaLangBadge(meta.audioLang));
    if (meta?.dub) parts.push('<span class="media-badge media-badge--dub" title="Дубляж">DUB</span>');
    if (!parts.length) return '';
    return `<span class="torrent-item__media">${parts.join('')}</span>`;
  }

  function sourceRatingHtml(percent) {
    if (percent == null || !Number.isFinite(percent)) return '';
    return `<span class="source-rating" title="Положительные оценки источника">${percent}% 👍</span>`;
  }

  let currentPlayerPayload = null;

  async function sendVideoFeedback(rating) {
    if (!currentPlayerPayload?.source) return;
    try {
      const res = await fetch('/api/video/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          tmdbId: currentData?.tmdbId || tmdbId,
          source: currentPlayerPayload.source,
          videoUrl: currentPlayerPayload.embedUrl || '',
          rating
        })
      });
      const out = await res.json().catch(() => null);
      if (out?.ok) {
        toast(rating === 'up' ? 'Спасибо за оценку' : 'Оценка учтена');
        const ratingEl = document.querySelector('.video-feedback__rating');
        if (ratingEl && out.rating?.percent != null) {
          ratingEl.textContent = `${out.rating.percent}% 👍`;
        }
      }
    } catch {
      toast('Не удалось отправить оценку');
    }
  }

  function bindVideoFeedback(slot) {
    slot.querySelector('.video-feedback__up')?.addEventListener('click', () => sendVideoFeedback('up'));
    slot.querySelector('.video-feedback__down')?.addEventListener('click', () => sendVideoFeedback('down'));
  }

  function renderOfflineMessage(slot, titleKey) {
    slot.innerHTML = `
      <section class="movie-block movie-player-block">
        <h2 class="movie-block-title">${esc(t(titleKey))}</h2>
        <div class="movie-player-status movie-player-status--offline">Нет сети</div>
      </section>`;
  }

  function renderIframePlayer(slot, payload) {
    currentPlayerPayload = payload || null;
    const { source, embedUrl, title, duration, sourceRating, hasCaptions, audioLang, dub } = payload || {};
    const label = playerSourceLabel(source);
    const durLabel = Number.isFinite(duration) && duration > 0
      ? `${Math.round(duration / 60)} мин`
      : '';

    slot.innerHTML = `
      <section class="movie-block movie-player-block">
        <div class="movie-player-block__head">
          <h2 class="movie-block-title">${esc(t('movie.player'))}</h2>
          ${mediaIndicatorsHtml({ hasCaptions, audioLang, dub })}
        </div>
        <div style="width:100%;aspect-ratio:16/9;background:#000;position:relative;overflow:hidden;">
          <iframe
            src="${esc(embedUrl)}"
            title="${esc(label)}"
            frameborder="0"
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen
            style="position:absolute;inset:0;width:100%;height:100%;"></iframe>
        </div>
        <div class="movie-player-meta">
          <div><b>Источник:</b> ${esc(label)} ${sourceRatingHtml(sourceRating)}</div>
          ${durLabel ? `<div><b>Длительность:</b> ${esc(durLabel)}</div>` : ''}
          ${title ? `<div class="movie-player-meta__title">${esc(title)}</div>` : ''}
        </div>
        <div class="video-feedback">
          <span class="video-feedback__label">Оцените источник:</span>
          <button type="button" class="video-feedback__btn video-feedback__up" aria-label="Нравится">👍</button>
          <button type="button" class="video-feedback__btn video-feedback__down" aria-label="Не нравится">👎</button>
          ${sourceRating != null ? `<span class="video-feedback__rating">${esc(String(sourceRating))}% 👍</span>` : ''}
        </div>
      </section>`;
    bindVideoFeedback(slot);
  }

  async function loadSmartIframePlayer(data) {
    const slot = document.getElementById('player-section');
    if (!slot) return false;

    if (isOffline()) {
      renderOfflineMessage(slot, 'movie.player');
      return false;
    }

    slot.innerHTML = `
      <section class="movie-block movie-player-block">
        <h2 class="movie-block-title">${esc(t('movie.player'))}</h2>
        <div class="movie-player-status">${esc(t('common.loading'))}</div>
      </section>`;

    const meta = data?.meta || {};
    const params = new URLSearchParams({
      tmdbId: String(data.tmdbId || tmdbId),
      type: data.mediaType || 'movie',
      title: String(data.title || ''),
      year: String(meta.year || '')
    });

    try {
      const res = await fetch(`/api/video/lookup?${params.toString()}`, { headers: authHeaders() });
      const out = await res.json().catch(() => null);
      if (!out) return false;

      if (out?.error === 'not found') {
        slot.innerHTML = `
          <section class="movie-block movie-player-block">
            <h2 class="movie-block-title">${esc(t('movie.player'))}</h2>
            <div class="movie-player-status">${esc(t('movie.playerUnavailable'))}</div>
          </section>`;
        return false;
      }
      if (!out?.embedUrl || !res.ok) {
        toast(out?.error ? String(out.error) : t('movie.playerUnavailable'));
        return false;
      }

      renderIframePlayer(slot, out);
      return true;
    } catch {
      return false;
    }
  }

  async function loadPlayer(id, type) {
    const slot = document.getElementById('player-section');
    if (!slot) return;
    if (isOffline()) {
      renderOfflineMessage(slot, 'movie.player');
      return;
    }
    slot.innerHTML = `
      <section class="movie-block movie-player-block">
        <h2 class="movie-block-title">${esc(t('movie.player'))}</h2>
        <div class="movie-player-status">${esc(t('common.loading'))}</div>
      </section>`;
    try {
      const res = await fetch(`/api/movie/player/${encodeURIComponent(id)}?type=${type}`, {
        headers: authHeaders()
      });
      const data = await res.json().catch(() => ({}));
      if (!data?.qualities?.length) { renderPlayerError(slot); return; }
      playerState = {
        id,
        type,
        voices: data.voices || [],
        activeVoice: data.activeVoice || null,
        qualities: data.qualities,
        activeQuality: pickDefaultQuality(data.qualities),
        isSeries: Boolean(data.isSeries),
        seasons: data.seasons || [],
        activeSeason: data.activeSeason || null,
        activeEpisode: data.activeEpisode || null,
        subtitles: data.subtitles || []
      };
      mountPlayerUI(slot);
    } catch {
      renderPlayerError(slot);
    }
  }

  function attrEsc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');
  }

  async function copyMagnetLink(magnetUrl) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(magnetUrl);
      } else {
        const ta = document.createElement('textarea');
        ta.value = magnetUrl;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast(t('movie.magnetCopied'));
      return true;
    } catch {
      toast(t('movie.magnetFailed'));
      return false;
    }
  }

  function openMagnetLink(magnetUrl) {
    if (!magnetUrl) return;
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches;

    if (mobile || standalone) {
      copyMagnetLink(magnetUrl);
      try { window.location.href = magnetUrl; } catch { /* ignore */ }
      return;
    }

    try {
      const a = document.createElement('a');
      a.href = magnetUrl;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      copyMagnetLink(magnetUrl);
    }
  }

  // Ленивая загрузка torrentPlayer.js (вместе с WebTorrent при первом «Смотреть»).
  function loadTorrentPlayerScript() {
    if (window.TorrentPlayer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/torrentPlayer.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('torrentPlayer load failed'));
      document.body.appendChild(script);
    });
  }

  async function openTorrentStream(btn) {
    const magnet = btn.dataset.watchMagnet || '';
    const torrentUrl = btn.dataset.watchTorrentUrl || '';
    const title = btn.dataset.watchTitle || '';
    if (!magnet && !torrentUrl) return;

    const slot = document.getElementById('torrents-section');
    const panel = slot?.querySelector('#torrents-panel');
    const toggle = slot?.querySelector('.torrents-section__toggle');
    if (!panel) return;

    try {
      await loadTorrentPlayerScript();
    } catch {
      if (magnet) openMagnetLink(magnet);
      else toast(t('movie.torrentStreamError'));
      return;
    }

    const enabled = await window.TorrentPlayer.isEnabled();
    if (!enabled || !window.TorrentPlayer.isWebRTCSupported()) {
      toast(t('movie.torrentStreamUnsupported'));
      if (magnet) openMagnetLink(magnet);
      return;
    }

    if (toggle) {
      toggle.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
      const label = toggle.querySelector('.torrents-section__label');
      if (label) label.textContent = t('movie.torrentsCollapse');
    }

    const listHtml = panel.innerHTML;
    window.TorrentPlayer.open({
      panelEl: panel,
      listHtml,
      magnet: magnet || null,
      torrentUrl: torrentUrl || null,
      title,
      authHeaders: authHeaders(),
      onMagnetFallback: (m) => openMagnetLink(m),
      onBack: () => bindTorrentAccordion(slot)
    });
  }

  function torrentSearchQuery(data) {
    const meta = data.meta || {};
    const original = (meta.originalTitle || meta.matchedTitle || '').trim();
    const title = (data.title || '').trim();
    const year = meta.year || (meta.releaseDate ? String(meta.releaseDate).slice(0, 4) : '');

    // Rutor лучше ищет по английскому названию + году; длинные двуязычные запросы часто пустые.
    if (original && year) return `${original} ${year}`;
    if (original) return original;
    if (title && year) return `${title} ${year}`;
    return title;
  }

  function torrentMetaRows(item) {
    const m = item.meta || {};
    const rows = [];
    if (m.year) rows.push(`<div class="torrent-detail"><span class="torrent-detail__k">${esc(t('movie.torrentYear'))}</span><span class="torrent-detail__v">${esc(m.year)}</span></div>`);
    if (m.quality) rows.push(`<div class="torrent-detail"><span class="torrent-detail__k">${esc(t('movie.quality'))}</span><span class="torrent-detail__v">${esc(m.quality)}</span></div>`);
    if (m.format) rows.push(`<div class="torrent-detail"><span class="torrent-detail__k">${esc(t('movie.torrentFormat'))}</span><span class="torrent-detail__v">${esc(m.format)}</span></div>`);
    if (m.audio) rows.push(`<div class="torrent-detail"><span class="torrent-detail__k">${esc(t('movie.torrentAudio'))}</span><span class="torrent-detail__v">${esc(m.audio)}</span></div>`);
    if (m.subtitles) rows.push(`<div class="torrent-detail"><span class="torrent-detail__k">${esc(t('movie.torrentSubtitles'))}</span><span class="torrent-detail__v">✓</span></div>`);
    if (item.size) rows.push(`<div class="torrent-detail"><span class="torrent-detail__k">${esc(t('movie.torrentSize'))}</span><span class="torrent-detail__v">${esc(item.size)}</span></div>`);
    rows.push(`<div class="torrent-detail"><span class="torrent-detail__k">${esc(t('movie.torrentSeeds'))}</span><span class="torrent-detail__v torrent-seeds">▲ ${Number(item.seeds || 0)}</span></div>`);
    rows.push(`<div class="torrent-detail"><span class="torrent-detail__k">${esc(t('movie.torrentLeechs'))}</span><span class="torrent-detail__v torrent-leechs">▼ ${Number(item.leechs || 0)}</span></div>`);
    return rows.join('');
  }

  function torrentRow(item, index) {
    const m = item.meta || {};
    const displayTitle = m.cleanTitle || item.title;
    const badge = [m.quality, m.format].filter(Boolean).join(' · ');
    const magnetBtn = item.magnet
      ? `<button type="button" class="btn-magnet" data-magnet="${attrEsc(item.magnet)}">${esc(t('movie.magnet'))}</button>`
      : '';
    const watchBtn = (item.magnet || item.torrentUrl)
      ? `<button type="button" class="btn-watch-torrent"
          data-watch-magnet="${attrEsc(item.magnet || '')}"
          data-watch-torrent-url="${attrEsc(item.torrentUrl || '')}"
          data-watch-title="${attrEsc(displayTitle)}">${esc(t('movie.watchTorrent'))}</button>`
      : '';
    const fileBtn = item.torrentUrl
      ? `<button type="button" class="btn-download" data-torrent-url="${attrEsc(item.torrentUrl)}">${esc(t('movie.downloadTorrent'))}</button>`
      : '';
    return `
      <li class="torrent-item">
        <button type="button" class="torrent-item__head" aria-expanded="false" aria-controls="torrent-body-${index}">
          <span class="torrent-item__chevron" aria-hidden="true"></span>
          <span class="torrent-item__main">
            <span class="torrent-title">${esc(displayTitle)}</span>
            ${badge ? `<span class="torrent-badge">${esc(badge)}</span>` : ''}
            ${torrentIndicatorsHtml(m)}
          </span>
          <span class="torrent-item__seeds torrent-seeds" title="${esc(t('movie.torrentSeeds'))}">▲ ${Number(item.seeds || 0)}</span>
        </button>
        <div class="torrent-item__body" id="torrent-body-${index}" hidden>
          <div class="torrent-details">${torrentMetaRows(item)}</div>
          <div class="torrent-actions">${magnetBtn}${fileBtn}${watchBtn}</div>
        </div>
      </li>`;
  }

  function bindTorrentAccordion(slot) {
    slot.querySelectorAll('.torrent-item__head').forEach((btn) => {
      btn.addEventListener('click', () => {
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        const body = btn.nextElementSibling;
        btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        if (body) body.hidden = expanded;
      });
    });
    slot.querySelectorAll('.btn-magnet').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMagnetLink(btn.dataset.magnet || '');
      });
    });
    slot.querySelectorAll('.btn-watch-torrent').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openTorrentStream(btn);
      });
    });
    slot.querySelectorAll('.btn-download').forEach((btn) => {
      btn.addEventListener('click', () => downloadTorrent(btn));
    });
  }

  function bindTorrentsSectionToggle(slot) {
    const toggle = slot.querySelector('.torrents-section__toggle');
    const panel = slot.querySelector('.torrents-section__panel');
    if (!toggle || !panel) return;
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      panel.hidden = open;
      toggle.querySelector('.torrents-section__label').textContent = open
        ? t('movie.torrentsExpand')
        : t('movie.torrentsCollapse');
    });
  }

  async function downloadTorrent(btn) {
    const url = btn.dataset.torrentUrl;
    if (!url) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('movie.downloading');
    try {
      const res = await fetch(`/api/torrents/download?url=${encodeURIComponent(url)}`, {
        headers: authHeaders()
      });
      if (!res.ok) throw new Error('download');
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const name = disposition.match(/filename="?([^"]+)"?/i)?.[1] || 'download.torrent';
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
    } catch {
      toast(t('movie.downloadFailed'));
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  async function fetchMovieDetails() {
    const url = `/api/movie/details/${encodeURIComponent(tmdbId)}?type=${mediaType}&lang=${lang()}`;
    try {
      const res = await fetch(url, { headers: authHeaders() });
      if (res.ok) return await res.json();
    } catch { /* offline fallback below */ }
    if ('caches' in window) {
      const cached = await caches.match(url);
      if (cached) return await cached.json().catch(() => null);
    }
    return null;
  }

  async function loadTorrents(data) {
    const slot = document.getElementById('torrents-section');
    if (!slot || !data?.title) return;
    if (isOffline()) {
      slot.innerHTML = `
        <section class="movie-block movie-torrents-block">
          <h2 class="movie-block-title">${esc(t('movie.torrents'))}</h2>
          <div class="movie-player-status movie-player-status--offline">Нет сети</div>
        </section>`;
      return;
    }
    const query = torrentSearchQuery(data);
    slot.innerHTML = `
      <section class="movie-block movie-torrents-block">
        <div class="torrents-section__header">
          <h2 class="movie-block-title">${esc(t('movie.torrents'))}</h2>
          <button type="button" class="torrents-section__toggle" aria-expanded="false" aria-controls="torrents-panel">
            <span class="torrents-section__chevron" aria-hidden="true"></span>
            <span class="torrents-section__label">${esc(t('movie.torrentsExpand'))}</span>
          </button>
        </div>
        <div class="torrents-section__panel" id="torrents-panel" hidden>
          <div class="movie-torrents-status">${esc(t('common.loading'))}</div>
        </div>
      </section>`;
    bindTorrentsSectionToggle(slot);
    const statusEl = slot.querySelector('.movie-torrents-status');
    let items = [];
    try {
      const res = await fetch(`/api/torrents/search?query=${encodeURIComponent(query)}&type=${data.mediaType || 'movie'}`, {
        headers: authHeaders()
      });
      items = await res.json().catch(() => []);
      if (!Array.isArray(items) || !items.length) {
        const fallbacks = [
          data.meta?.originalTitle && data.meta?.year ? `${data.meta.originalTitle} ${data.meta.year}` : null,
          data.meta?.originalTitle || null,
          data.title || null
        ].filter((q, i, arr) => q && arr.indexOf(q) === i && q !== query);
        for (const alt of fallbacks) {
          const r2 = await fetch(`/api/torrents/search?query=${encodeURIComponent(alt)}&type=${data.mediaType || 'movie'}`, {
            headers: authHeaders()
          });
          const altItems = await r2.json().catch(() => []);
          if (Array.isArray(altItems) && altItems.length) {
            items = altItems;
            break;
          }
        }
      }
      if (!Array.isArray(items) || !items.length) {
        statusEl.textContent = t('movie.torrentsEmpty');
        return;
      }
      const list = items.slice(0, 25).map((item, i) => torrentRow(item, i)).join('');
      statusEl.outerHTML = `<ul class="torrent-list">${list}</ul>`;
      bindTorrentAccordion(slot);
    } catch {
      if (statusEl) statusEl.textContent = t('movie.torrentsError');
    }
  }

  let currentData = null;

  async function load() {
    try {
      const data = await fetchMovieDetails();
      if (!data?.title) throw new Error('not found');
      data.mediaType = data.mediaType || mediaType;
      data.tmdbId = data.tmdbId || Number(tmdbId);
      currentData = data;
      render(data);
      if (!isOffline()) {
        loadExtras(data);
        loadSmartIframePlayer(data).then((ok) => {
          if (!ok) loadPlayer(data.tmdbId, data.mediaType);
        });
        loadTorrents(data);
      } else {
        renderOfflineMessage(document.getElementById('player-section'), 'movie.player');
        const torrentsSlot = document.getElementById('torrents-section');
        if (torrentsSlot) {
          torrentsSlot.innerHTML = `
            <section class="movie-block movie-torrents-block">
              <h2 class="movie-block-title">${esc(t('movie.torrents'))}</h2>
              <div class="movie-player-status movie-player-status--offline">Нет сети</div>
            </section>`;
        }
      }
    } catch (err) {
      root.innerHTML = `<p class="moviepage-error">${esc(t('movie.loadError'))}</p>`;
    }
  }

  // Смена языка: перезагружаем данные (описание/жанры/название из TMDB зависят
  // от языка) и заново рендерим страницу.
  document.addEventListener('i18n:change', () => { load(); });

  load();
})();
