// Расширенные фичи — работают на клиенте, API только как дополнение

(function () {
  let premiereSort = 'date-asc';
  let premiereMainItems = [];
  let premiereAutoScrollTimer = null;
  let premiereUserPausedUntil = 0;
  let initialized = false;
  let premiereLoadPromise = null;

  const PREMIERES_CACHE_KEY = 'mf_premieres_cache_v1';
  const PREMIERES_CACHE_TTL_MS = 30 * 60 * 1000;

  function esc(text) {
    return window.MovieDisplay?.escapeHtml(String(text ?? '')) || String(text ?? '');
  }

  function XT(key, fallback, vars) {
    return window.t ? window.t(key, vars) : fallback;
  }

  function posterSrc(url) {
    return window.MovieDisplay?.posterUrl(url) || url;
  }

  function getMediaType() {
    return document.querySelector('.media-tab--active')?.dataset.media || 'movie';
  }

  function getMovies() {
    return window.MovieApp?.getMovies() || [];
  }

  function statusLabel(status) {
    return window.MovieApp?.statusLabels?.[status] || status;
  }

  function openModal(title, html) {
    if (typeof window.openModal === 'function') {
      window.openModal(title, html);
    }
  }

  function closeModal() {
    if (typeof window.closeModal === 'function') window.closeModal();
  }

  function renderPickItems(container, items) {
    if (!container) return;
    container.innerHTML = '';
    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'pick-item';
      const poster = item.poster
        ? `<img class="pick-poster-img" src="${esc(posterSrc(item.poster))}" alt="" loading="lazy" decoding="async">`
        : '<span class="pick-poster-empty">🎬</span>';
      const why = item.whyDetailed ? `<p class="pick-why">💡 ${esc(item.whyDetailed)}</p>` : '';
      const year = item.year ? `<span class="pick-year">${esc(item.year)}</span>` : '';
      const badge = item.fromList
        ? '<span class="from-list-badge">из списка</span>'
        : '<span class="from-list-badge from-list-badge--new">новое</span>';
      li.innerHTML = `
        <div class="pick-poster">${poster}</div>
        <div class="pick-info">
          <div class="pick-title-row"><strong>${esc(item.title)}</strong>${year}${badge}</div>
          <p class="pick-reason">${esc(item.reason || '')}${item.runtime ? ` · ~${item.runtime} мин` : ''}</p>
          ${why}
        </div>
        ${item.fromList ? '' : '<button type="button" class="rec-add-btn pick-add-btn" title="Добавить">+</button>'}
      `;
      li.querySelector('.pick-add-btn')?.addEventListener('click', function () {
        const r = window.MovieApp.addMovie({
          title: item.title,
          status: 'want',
          mediaType: item.mediaType || 'movie'
        });
        if (r.success) {
          this.textContent = '✓';
          this.disabled = true;
        }
      });
      container.appendChild(li);
    });
  }

  const EXPORT_LABELS = {
    csv: 'CSV',
    json: 'JSON',
    pdf: 'PDF',
    backup: 'резервную копию'
  };

  function confirmExport(format) {
    const label = EXPORT_LABELS[format] || format.toUpperCase();
    const count = getMovies().length;
    const countLine = count
      ? `Будет экспортировано записей: ${count}.`
      : 'Список пуст — файл всё равно будет создан.';

    let details = '';
    if (format === 'pdf') {
      details = '\n\nОткроется окно печати. Сохраните файл через «Печать → Сохранить как PDF».';
    } else if (format === 'backup') {
      details = '\n\nБудет сохранён полный бэкап: фильмы, настройки и результаты психологического теста.';
    }

    return window.confirm(`Экспортировать список в формате ${label}?\n\n${countLine}${details}`);
  }

  async function exportData(format) {
    const movies = getMovies();
    const username = sessionStorage.getItem('username') || 'list';
    const date = new Date().toISOString().slice(0, 10);

    if (format === 'pdf') {
      const rows = movies.map((m) => `
        <tr>
          <td>${esc(m.title)}</td>
          <td>${m.mediaType === 'tv' ? 'Сериал' : 'Фильм'}</td>
          <td>${esc(statusLabel(m.status))}</td>
          <td>${m.rating ?? '—'}</td>
          <td>${esc(m.meta?.year || '—')}</td>
          <td>${esc((window.MovieDisplay?.displayGenres(m) || m.genres || []).join(', '))}</td>
        </tr>`).join('');
      const win = window.open('', '_blank');
      if (!win) {
        window.alert('Разрешите всплывающие окна для PDF-экспорта');
        return;
      }
      win.document.write(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Kinder</title>
        <style>body{font-family:Arial,sans-serif;padding:2rem}table{width:100%;border-collapse:collapse}
        th,td{border:1px solid #333;padding:8px}th{background:#e50914;color:#fff}</style></head>
        <body><h1>Kinder</h1><table><thead><tr>
        <th>Название</th><th>Тип</th><th>Статус</th><th>Оценка</th><th>Год</th><th>Жанры</th>
        </tr></thead><tbody>${rows}</tbody></table>
        <p><small>${date} — Ctrl+P для сохранения в PDF</small></p></body></html>`);
      win.document.close();
      win.focus();
      win.print();
      return;
    }

    let content = '';
    let mime = 'application/json';
    let filename = `my-list-${date}`;

    if (format === 'csv') {
      mime = 'text/csv;charset=utf-8';
      filename += '.csv';
      const header = 'title,status,rating,mediaType,year,genres,tags,runtime';
      const rows = movies.map((m) => [
        `"${(m.title || '').replace(/"/g, '""')}"`,
        m.status,
        m.rating ?? '',
        m.mediaType || 'movie',
        m.meta?.year || '',
        `"${(m.genres || []).join('; ')}"`,
        `"${(m.tags || []).join('; ')}"`,
        m.meta?.runtime || ''
      ].join(','));
      content = '\uFEFF' + [header, ...rows].join('\n');
    } else if (format === 'backup') {
      filename += '.backup.json';
      try {
        const res = await fetch('/api/export?format=backup', { headers: window.authHeaders() });
        const data = await res.json();
        if (!res.ok) {
          window.alert(data.error || 'Не удалось создать резервную копию');
          return;
        }
        content = JSON.stringify({
          movies: data.movies,
          nextId: data.nextId,
          prefs: data.prefs,
          exportedAt: data.exportedAt,
          username
        }, null, 2);
      } catch {
        window.alert('Сервер недоступен');
        return;
      }
    } else {
      filename += '.json';
      content = JSON.stringify({
        movies,
        exportedAt: new Date().toISOString(),
        username
      }, null, 2);
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importFromText(text, format) {
    const mediaType = format === 'series' ? 'tv' : 'movie';
    const parsed = window.ImportParsers.parse(text, format, mediaType);
    if (!parsed.length) return { added: 0, dupes: 0, error: 'Не удалось распознать список' };

    let added = 0;
    let dupes = 0;
    parsed.forEach((m) => {
      const r = window.MovieApp.addMovie(m);
      if (r.success) added++;
      else if (r.duplicate) dupes++;
    });
    return { added, dupes, total: parsed.length };
  }

  function parsePremiereDateIso(value) {
    return window.MovieDisplay?.parseReleaseDateIso(value) || null;
  }

  function isUpcomingPremiereItem(item, today) {
    const releaseDate = parsePremiereDateIso(item.releaseDate);
    return Boolean(releaseDate && releaseDate > today);
  }

  function formatPremiereDate(item) {
    const releaseDate = parsePremiereDateIso(item.releaseDate);
    if (releaseDate) {
      return new Date(`${releaseDate}T12:00:00`).toLocaleDateString('ru-RU');
    }
    return item.year ? String(item.year) : 'дата уточняется';
  }

  function sortPremiereItems(items, sortKey) {
    const sorted = [...items];
    const cmpTitle = (a, b) => a.title.localeCompare(b.title, 'ru');
    const dateVal = (item) => parsePremiereDateIso(item.releaseDate) || '';

    if (sortKey === 'date-desc') {
      return sorted.sort((a, b) => {
        const da = dateVal(a);
        const db = dateVal(b);
        if (!da && !db) return cmpTitle(a, b);
        if (!da) return 1;
        if (!db) return -1;
        return db.localeCompare(da) || cmpTitle(a, b);
      });
    }
    if (sortKey === 'title-asc') {
      return sorted.sort(cmpTitle);
    }
    if (sortKey === 'title-desc') {
      return sorted.sort((a, b) => cmpTitle(b, a));
    }
    return sorted.sort((a, b) => {
      const da = dateVal(a);
      const db = dateVal(b);
      if (!da && !db) return cmpTitle(a, b);
      if (!da) return 1;
      if (!db) return -1;
      return da.localeCompare(db) || cmpTitle(a, b);
    });
  }

  function isMovieInList(title) {
    const lower = title.toLowerCase().trim();
    return getMovies().some((m) => m.title.toLowerCase() === lower);
  }

  function createPremiereAddButton(title, mediaType) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'premiere-add-btn';
    btn.title = 'Добавить в список';

    if (isMovieInList(title)) {
      btn.textContent = '✓';
      btn.disabled = true;
      btn.classList.add('premiere-add-btn--added');
      return btn;
    }

    btn.textContent = '+';
    btn.addEventListener('click', function () {
      const r = window.MovieApp.addMovie({ title, status: 'want', mediaType: mediaType || 'movie' });
      if (r.success) {
        btn.textContent = '✓';
        btn.disabled = true;
        btn.classList.add('premiere-add-btn--added');
        loadPremieres();
      }
    });
    return btn;
  }

  function pausePremiereAutoScroll(ms = 10000) {
    premiereUserPausedUntil = Date.now() + ms;
  }

  function clearPremiereAutoScroll() {
    if (premiereAutoScrollTimer) {
      clearInterval(premiereAutoScrollTimer);
      premiereAutoScrollTimer = null;
    }
  }

  function setupPremiereRibbonScroll() {
    const viewport = document.getElementById('premiere-ribbon-viewport');
    const prev = document.getElementById('premiere-ribbon-prev');
    const next = document.getElementById('premiere-ribbon-next');
    if (!viewport) return;

    clearPremiereAutoScroll();

    const getStep = () => {
      // Один шаг = ровно ширина видимой области (один фильм на экран). В
      // app-режиме у карточки есть боковые margin'ы, входящие в «слот»,
      // поэтому ориентируемся на ширину вьюпорта, а не карточки — иначе
      // листание «сползает». Карточный расчёт оставлен как фолбэк.
      if (viewport.clientWidth) return viewport.clientWidth;
      const card = viewport.querySelector('.premiere-ribbon-card');
      if (!card) return 360;
      const track = viewport.querySelector('.premiere-ribbon-track');
      const gap = track ? (parseFloat(getComputedStyle(track).columnGap) || 0) : 0;
      const cs = getComputedStyle(card);
      const mx = (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
      return card.offsetWidth + mx + gap;
    };

    const scrollByDir = (dir) => {
      pausePremiereAutoScroll();
      viewport.scrollBy({ left: dir * getStep(), behavior: 'smooth' });
      window.setTimeout(updatePremiereRibbonProgress, 350);
    };

    prev?.replaceWith(prev.cloneNode(true));
    next?.replaceWith(next.cloneNode(true));
    document.getElementById('premiere-ribbon-prev')
      ?.addEventListener('click', () => scrollByDir(-1));
    document.getElementById('premiere-ribbon-next')
      ?.addEventListener('click', () => scrollByDir(1));

    viewport.onwheel = () => pausePremiereAutoScroll();
    viewport.onpointerdown = () => pausePremiereAutoScroll();
    viewport.onscroll = updatePremiereRibbonProgress;

    premiereAutoScrollTimer = window.setInterval(() => {
      if (Date.now() < premiereUserPausedUntil) return;
      const max = viewport.scrollWidth - viewport.clientWidth;
      if (max <= 4) return;
      if (viewport.scrollLeft >= max - 6) {
        viewport.scrollTo({ left: 0, behavior: 'smooth' });
      } else {
        viewport.scrollBy({ left: getStep(), behavior: 'smooth' });
      }
      window.setTimeout(updatePremiereRibbonProgress, 350);
    }, 5500);
  }

  function updatePremiereRibbonProgress() {
    const viewport = document.getElementById('premiere-ribbon-viewport');
    const bar = document.getElementById('premiere-ribbon-progress');
    if (!viewport || !bar) return;
    const max = viewport.scrollWidth - viewport.clientWidth;
    const pct = max > 0 ? (viewport.scrollLeft / max) * 100 : 0;
    bar.style.setProperty('--ribbon-progress', `${pct}%`);
  }

  function premierePosterUrl(item) {
    return window.MovieDisplay?.posterUrl(item.poster) || item.poster || null;
  }

  function normalizePremiereItem(item) {
    return {
      ...item,
      poster: premierePosterUrl(item)
    };
  }

  // Минимальная плитка премьеры: постер, название, жанр+год, рейтинг.
  // Вся остальная инфа — на странице фильма (открывается по тапу).
  function premiereDisplayTitle(item) {
    return window.MovieDisplay?.displayTitle(item) || item.title || '';
  }

  function renderPremiereRibbonCard(item) {
    const displayTitle = premiereDisplayTitle(item);
    const href = item.tmdbId ? `/movie.html?type=${item.mediaType === 'tv' ? 'tv' : 'movie'}&id=${item.tmdbId}` : null;
    const card = document.createElement(href ? 'a' : 'article');
    card.className = 'premiere-ribbon-card premiere-ribbon-card--mini';
    card.dataset.release = item.releaseDate || '';
    if (href) { card.href = href; }

    const posterWrap = document.createElement('div');
    posterWrap.className = 'premiere-ribbon-poster';
    const img = document.createElement('img');
    img.className = 'premiere-ribbon-poster-img';
    img.src = premierePosterUrl(item);
    img.alt = displayTitle;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      card.remove();
      updatePremiereRibbonProgress();
    });
    posterWrap.appendChild(img);

    const badges = document.createElement('div');
    badges.className = 'premiere-ribbon-poster-badges';

    const vote = Number(item.voteAverage);
    const ratingText = Number.isFinite(vote) && vote > 0 ? vote.toFixed(1) : '—';
    const r = document.createElement('span');
    r.className = 'premiere-ribbon-rating';
    r.textContent = `★ ${ratingText}`;
    badges.appendChild(r);
    if (item.siteRating?.average) {
      const sr = document.createElement('span');
      sr.className = 'premiere-ribbon-rating premiere-ribbon-rating--site';
      sr.title = `Оценка пользователей сайта (${item.siteRating.count})`;
      sr.textContent = `★ ${item.siteRating.average}`;
      badges.appendChild(sr);
    }
    if (item.mediaType === 'tv') {
      const tv = document.createElement('span');
      tv.className = 'premiere-ribbon-typebadge';
      tv.textContent = 'Сериал';
      badges.appendChild(tv);
    }
    if (badges.childElementCount) posterWrap.appendChild(badges);
    card.appendChild(posterWrap);

    const body = document.createElement('div');
    body.className = 'premiere-ribbon-body';

    const title = document.createElement('h3');
    title.className = 'premiere-ribbon-card-title';
    title.textContent = displayTitle;
    body.appendChild(title);

    const meta = document.createElement('p');
    meta.className = 'premiere-ribbon-meta';
    const year = item.year || (item.releaseDate ? item.releaseDate.slice(0, 4) : '');
    const metaParts = [];
    if (item.genres?.length) metaParts.push((window.MovieDisplay?.displayGenres(item) || item.genres).slice(0, 1).join(', '));
    if (year) metaParts.push(String(year));
    meta.textContent = metaParts.join(' · ') || formatPremiereDate(item);
    body.appendChild(meta);

    card.appendChild(body);
    return card;
  }

  function renderPremiereRibbon(items) {
    const track = document.getElementById('premiere-ribbon-track');
    const section = document.getElementById('premiere-ribbon-section');
    if (!track) return;

    track.innerHTML = '';
    if (!items.length) {
      track.innerHTML = '<p class="premiere-ribbon-empty">Нет предстоящих премьер с известной датой</p>';
      section?.classList.add('premiere-ribbon--empty');
      clearPremiereAutoScroll();
      return;
    }

    section?.classList.remove('premiere-ribbon--empty');
    items.forEach((item) => {
      track.appendChild(renderPremiereRibbonCard(item));
    });

    const viewport = document.getElementById('premiere-ribbon-viewport');
    if (viewport) viewport.scrollLeft = 0;
    updatePremiereRibbonProgress();
    setupPremiereRibbonScroll();
  }

  function renderCompactPremiereItem(item, options = {}) {
    const { showAdd = false } = options;
    const displayTitle = premiereDisplayTitle(item);
    const li = document.createElement('li');
    li.className = 'premiere-compact-item';

    const poster = document.createElement('div');
    poster.className = 'premiere-compact-poster';
    if (item.poster) {
      const img = document.createElement('img');
      img.className = 'premiere-compact-poster-img';
      img.src = premierePosterUrl(item);
      img.alt = displayTitle;
      img.loading = 'lazy';
      poster.appendChild(img);
    } else {
      poster.classList.add('premiere-compact-poster--empty');
      poster.textContent = '🎬';
    }
    li.appendChild(poster);

    const info = document.createElement('div');
    info.className = 'premiere-compact-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'premiere-compact-title-row';
    const titleEl = document.createElement('strong');
    titleEl.textContent = displayTitle;
    titleRow.appendChild(titleEl);
    if (item.year) {
      const yearEl = document.createElement('span');
      yearEl.className = 'premiere-compact-year';
      yearEl.textContent = item.year;
      titleRow.appendChild(yearEl);
    }
    info.appendChild(titleRow);

    const originalHtml = window.MovieDisplay?.formatOriginalTitleHtml(
      item.originalTitle,
      displayTitle,
      'premiere-compact-original'
    );
    if (originalHtml) info.insertAdjacentHTML('beforeend', originalHtml);

    const metaParts = [formatPremiereDate(item)];
    if (item.inList) metaParts.push('в списке');
    const metaEl = document.createElement('span');
    metaEl.className = 'premiere-compact-meta';
    metaEl.textContent = metaParts.join(' · ');
    info.appendChild(metaEl);

    if (item.reason) {
      const reasonEl = document.createElement('span');
      reasonEl.className = 'premiere-compact-reason';
      reasonEl.textContent = item.reason;
      info.appendChild(reasonEl);
    }

    const whyText = item.whyDetailed && item.whyDetailed !== item.reason
      ? item.whyDetailed
      : null;
    const whyToggle = window.MovieDisplay?.createWhyToggle(whyText);
    if (whyToggle) info.appendChild(whyToggle);

    li.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'premiere-compact-actions';

    if (showAdd && item.title !== 'Начните с просмотра' && !item.inList) {
      actions.appendChild(createPremiereAddButton(item.title, item.mediaType));
    }

    if (actions.childElementCount) li.appendChild(actions);

    return li;
  }

  function renderPremiereList(container, items, options) {
    if (!container) return false;
    container.innerHTML = '';
    if (!items.length) return false;
    items.forEach((item) => {
      container.appendChild(renderCompactPremiereItem(item, options));
    });
    return true;
  }

  function renderPremiereSublist(container, titleEl, hintEl, items, options, emptyText) {
    const hasItems = renderPremiereList(container, items, options);
    const block = container?.closest('.premiere-sublist');
    if (block) block.classList.toggle('premiere-sublist--empty', !hasItems);
    if (!hasItems && container) {
      container.innerHTML = `<li class="rec-empty">${emptyText}</li>`;
    }
    return hasItems;
  }

  function renderMainPremieres() {
    const today = new Date().toISOString().slice(0, 10);
    const sorted = sortPremiereItems(
      premiereMainItems.filter((item) => isUpcomingPremiereItem(item, today) && item.poster),
      premiereSort
    );
    renderPremiereRibbon(sorted);
  }

  function premieresCacheKey() {
    const lang = window.I18N?.getLang?.() || 'ru';
    const auth = (typeof window.isLoggedIn === 'function' && window.isLoggedIn()) ? '1' : '0';
    return `${lang}:${auth}`;
  }

  function readPremieresCache() {
    try {
      const raw = sessionStorage.getItem(PREMIERES_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed?.payload || Date.now() - parsed.at > PREMIERES_CACHE_TTL_MS) return null;
      if (parsed.key !== premieresCacheKey()) return null;
      return parsed.payload;
    } catch {
      return null;
    }
  }

  function writePremieresCache(payload) {
    try {
      sessionStorage.setItem(PREMIERES_CACHE_KEY, JSON.stringify({
        at: Date.now(),
        key: premieresCacheKey(),
        payload
      }));
    } catch { /* quota */ }
  }

  function buildPremieresFromList(movies, today) {
    return movies
      .filter((m) => window.MovieDisplay?.isFutureReleaseDate(m.meta?.releaseDate, today))
      .map((m) => normalizePremiereItem({
        id: m.id,
        tmdbId: m.tmdbId || null,
        title: m.title,
        releaseDate: parsePremiereDateIso(m.meta?.releaseDate),
        year: m.meta?.year,
        poster: window.MovieDisplay?.posterUrl(m.meta?.poster) || m.meta?.poster,
        originalTitle: m.meta?.originalTitle,
        mediaType: m.mediaType || 'movie',
        inList: true,
        reminded: false,
        overview: (m.meta?.overview || '').slice(0, 320),
        genres: m.genres || [],
        voteAverage: m.meta?.kpRating || m.meta?.imdbRating || null
      }));
  }

  function mergePremiereApiData(fromListScheduled, apiData) {
    let items = [...fromListScheduled];
    if (!apiData) return items;

    const seen = new Set(items.map((i) => i.title.toLowerCase()));
    (apiData.upcoming || []).forEach((p) => {
      const normalized = normalizePremiereItem(p);
      if (!seen.has(p.title.toLowerCase())) {
        seen.add(p.title.toLowerCase());
        items.push({ ...normalized, reminded: p.reminded || false });
      } else {
        const existing = items.find((i) => i.title.toLowerCase() === p.title.toLowerCase());
        if (existing) {
          existing.reminded = p.reminded || existing.reminded;
          if (normalized.poster) existing.poster = normalized.poster;
          if (normalized.overview && !existing.overview) existing.overview = normalized.overview;
        }
      }
    });
    (apiData.tmdbUpcoming || []).filter((t) => !t.inList).forEach((t) => {
      const normalized = normalizePremiereItem(t);
      if (!seen.has(t.title.toLowerCase())) {
        seen.add(t.title.toLowerCase());
        items.push({
          ...normalized,
          inList: false
        });
      } else {
        const existing = items.find((i) => i.title.toLowerCase() === t.title.toLowerCase());
        if (existing?.poster && normalized.poster) {
          existing.poster = normalized.poster;
        }
        if (existing && normalized.overview && !existing.overview) {
          existing.overview = normalized.overview;
        }
      }
    });
    return items;
  }

  function applyPremiereMainItems(items, today) {
    premiereMainItems = items
      .filter((item) => isUpcomingPremiereItem(item, today))
      .map(normalizePremiereItem);
    renderMainPremieres();
  }

  function hydratePremieresFromCache() {
    const cached = readPremieresCache();
    if (!cached || premiereMainItems.length) return;
    const today = new Date().toISOString().slice(0, 10);
    const merged = mergePremiereApiData([], cached);
    if (merged.length) applyPremiereMainItems(merged, today);
  }

  async function loadPremieres() {
    if (premiereLoadPromise) return premiereLoadPromise;
    premiereLoadPromise = loadPremieresInternal().finally(() => {
      premiereLoadPromise = null;
    });
    return premiereLoadPromise;
  }

  async function loadPremieresInternal() {
    const track = document.getElementById('premiere-ribbon-track');
    if (!track) return;

    const movies = getMovies();
    const today = new Date().toISOString().slice(0, 10);
    const fromListScheduled = buildPremieresFromList(movies, today);
    const cached = readPremieresCache();

    if (cached) {
      applyPremiereMainItems(mergePremiereApiData(fromListScheduled, cached), today);
    } else if (fromListScheduled.length) {
      applyPremiereMainItems(fromListScheduled, today);
    } else if (!premiereMainItems.length) {
      track.innerHTML = window.LoadingUI.ai('Загрузка премьер...', { tag: 'p', wrapClass: 'premiere-ribbon-empty rec-loading' });
    }

    try {
      const res = await fetch('/api/premieres', { headers: window.authHeaders() });
      if (res.ok) {
        const data = await res.json();
        writePremieresCache(data);
        applyPremiereMainItems(mergePremiereApiData(fromListScheduled, data), today);
      }
    } catch { /* оставляем кэш или локальные премьеры */ }
  }

  function getWatchNowPrefs(form) {
    return {
      duration: form.duration.value,
      mood: form.mood.value,
      mediaType: form.mediaType.value
    };
  }

  async function fetchWatchNowPicks(prefs, excludeTitles = []) {
    try {
      const res = await fetch('/api/watch-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...window.authHeaders() },
        body: JSON.stringify({ ...prefs, excludeTitles })
      });
      if (res.ok) {
        const data = await res.json();
        const serverPicks = (data.picks || []).slice(0, 5);
        if (serverPicks.length === 5) return serverPicks;
      }
    } catch { /* fallback ниже */ }

    let picks = window.WatchNow.pickWatchNowLocal(getMovies(), prefs, 5);
    picks = window.WatchNow.topUpWatchNowFromList(picks, getMovies(), prefs, { excludeTitles });
    return picks.slice(0, 5);
  }

  function renderWatchNowResults(picks, prefs) {
    const resultsEl = document.getElementById('watch-now-results');
    if (!resultsEl) return;

    if (!window.WatchNow.isWatchNowComplete(picks)) {
      resultsEl.innerHTML = `<p class="rec-empty">Не удалось подобрать ровно 5 вариантов. Добавьте больше фильмов в список или смените фильтры.</p>`;
      return;
    }

    resultsEl.innerHTML = `
      <div class="watch-now-results-header">
        <span class="watch-now-results-count">5 вариантов</span>
        <button type="button" id="watch-now-refresh" class="rec-refresh-btn">Обновить</button>
      </div>
      <ul class="pick-results" id="watch-now-list"></ul>
    `;
    renderPickItems(document.getElementById('watch-now-list'), picks.slice(0, 5));

    document.getElementById('watch-now-refresh')?.addEventListener('click', async () => {
      const form = document.getElementById('watch-now-form');
      const btn = document.getElementById('watch-now-refresh');
      if (!form || !btn) return;

      btn.disabled = true;
      btn.textContent = 'Подбираю...';
      resultsEl.innerHTML = window.LoadingUI.ai('Подбираю...', { tag: 'p', wrapClass: '' });

      const nextPrefs = getWatchNowPrefs(form);
      const excludeTitles = picks.map((item) => item.title);
      const nextPicks = await fetchWatchNowPicks(nextPrefs, excludeTitles);
      renderWatchNowResults(nextPicks, nextPrefs);
    });
  }

  async function submitWatchNowForm(form) {
    const resultsEl = document.getElementById('watch-now-results');
    if (!resultsEl) return;

    resultsEl.innerHTML = window.LoadingUI.ai('Подбираю...', { tag: 'p', wrapClass: '' });
    const prefs = getWatchNowPrefs(form);
    const picks = await fetchWatchNowPicks(prefs);
    renderWatchNowResults(picks, prefs);
  }

  function showWatchNowModal() {
    const mediaType = getMediaType();
    openModal('Что посмотреть прямо сейчас?', `
      <form id="watch-now-form" class="watch-now-form">
        <fieldset><legend>Длительность</legend>
          <label><input type="radio" name="duration" value="short" checked> До полутора часов</label>
          <label><input type="radio" name="duration" value="long"> Больше полутора часов</label>
        </fieldset>
        <fieldset><legend>Настроение</legend>
          <label><input type="radio" name="mood" value="light" checked> Лёгкое</label>
          <label><input type="radio" name="mood" value="heavy"> Тяжёлое</label>
          <label><input type="radio" name="mood" value="romance"> Романтика</label>
          <label><input type="radio" name="mood" value="puzzle"> Мозголомка</label>
          <label><input type="radio" name="mood" value="action"> Экшен</label>
        </fieldset>
        <input type="hidden" name="mediaType" value="${mediaType}">
        <button type="submit" class="btn-primary">Подобрать ровно 5 вариантов</button>
      </form>
      <div id="watch-now-results"></div>
    `);

    document.getElementById('watch-now-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await submitWatchNowForm(e.target);
    });
  }

  window.showDuplicateModal = function (dup, newData) {
    const existing = dup.movie;
    openModal('Похоже, уже есть в списке', `
      <div class="dup-modal">
        <p>«<strong>${esc(newData.title)}</strong>» похоже на:</p>
        <div class="dup-existing">
          <strong>${esc(existing.title)}</strong>
          <span>${esc(statusLabel(existing.status))}</span>
        </div>
        <div class="dup-actions">
          <button type="button" class="btn-primary" id="dup-update">Обновить статус</button>
          <button type="button" class="btn-secondary" id="dup-add-anyway">Всё равно добавить</button>
          <button type="button" class="btn-cancel-pick" id="dup-cancel">Отмена</button>
        </div>
      </div>
    `);
    document.getElementById('dup-update')?.addEventListener('click', () => {
      window.MovieApp.updateMovie({
        title: existing.title,
        status: newData.status || existing.status,
        rating: newData.rating
      });
      closeModal();
    });
    document.getElementById('dup-add-anyway')?.addEventListener('click', () => {
      const r = window.MovieApp.addMovieInternal(newData, { skipDuplicateCheck: true });
      if (r.success) {
        window.MovieApp.saveMovies();
        window.MovieApp.enrichMovie(r.movie).then(() => window.MovieApp.saveMovies());
      }
      closeModal();
    });
    document.getElementById('dup-cancel')?.addEventListener('click', closeModal);
  };

  // Переход на отдельную страницу человека (актёр/режиссёр/сценарист и др.).
  // Раньше открывалась модалка; теперь у каждого человека есть своя страница.
  window.openPersonModal = function (personId) {
    if (!personId) return;
    location.href = `/person.html?id=${encodeURIComponent(personId)}`;
  };

  window.renderPickListWithWhy = function (container, items) {
    renderPickItems(container, items);
  };

  function bindEvents() {
    const app = document.getElementById('app-content');
    if (!app || initialized) return;
    initialized = true;

    app.addEventListener('click', async (e) => {
      const exportBtn = e.target.closest('.export-btn');
      if (exportBtn) {
        const format = exportBtn.dataset.format;
        if (format && confirmExport(format)) await exportData(format);
        return;
      }

      const mediaTab = e.target.closest('.media-tab');
      if (mediaTab) {
        window.MovieApp.setMediaFilter(mediaTab.dataset.media);
        return;
      }

      if (e.target.closest('#add-series-btn')) {
        const title = window.prompt('Название сериала:');
        if (title?.trim()) window.MovieApp.addMovie({ title: title.trim(), status: 'want', mediaType: 'tv' });
      }
    });

    document.getElementById('import-formats-btn')?.addEventListener('click', async () => {
      const statusEl = document.getElementById('import-formats-status');
      const textEl = document.getElementById('import-text');
      const fileEl = document.getElementById('import-file');
      const formatEl = document.getElementById('import-format');
      let text = textEl?.value.trim() || '';
      if (!text && fileEl?.files?.[0]) {
        try { text = await fileEl.files[0].text(); } catch {
          if (statusEl) statusEl.textContent = 'Не удалось прочитать файл';
          return;
        }
      }
      if (!text) {
        if (statusEl) statusEl.textContent = 'Вставьте список или выберите файл';
        return;
      }
      const result = importFromText(text, formatEl?.value || 'plain');
      if (result.error) {
        if (statusEl) statusEl.textContent = result.error;
        return;
      }
      if (statusEl) statusEl.textContent = `Добавлено: ${result.added}, дубликатов: ${result.dupes} из ${result.total}`;
      if (textEl) textEl.value = '';
      if (fileEl) fileEl.value = '';
      loadPremieres();
    });

    document.getElementById('premiere-sort')?.addEventListener('change', (e) => {
      premiereSort = e.target.value;
      renderMainPremieres();
    });

    document.getElementById('blacklist-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const split = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
      try {
        await fetch('/api/blacklist', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...window.authHeaders() },
          body: JSON.stringify({
            genres: split(form.genres.value),
            actors: split(form.actors.value),
            directors: split(form.directors.value),
            countries: split(form.countries.value),
            excludeHorror: form.excludeHorror.checked,
            maxRuntime: form.maxRuntime.value ? Number(form.maxRuntime.value) : null,
            minYear: form.minYear.value ? Number(form.minYear.value) : null
          })
        });
        const st = document.getElementById('blacklist-status');
        if (st) { st.textContent = 'Сохранено'; setTimeout(() => { st.textContent = ''; }, 2000); }
      } catch {
        const st = document.getElementById('blacklist-status');
        if (st) st.textContent = 'Сохранено локально (сервер недоступен)';
      }
    });
  }

  async function loadBlacklist() {
    try {
      const res = await fetch('/api/blacklist', { headers: window.authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      const form = document.getElementById('blacklist-form');
      if (!form) return;
      form.genres.value = (data.genres || []).join(', ');
      form.actors.value = (data.actors || []).join(', ');
      form.directors.value = (data.directors || []).join(', ');
      form.countries.value = (data.countries || []).join(', ');
      form.excludeHorror.checked = !!data.excludeHorror;
      form.maxRuntime.value = data.maxRuntime || '';
      form.minYear.value = data.minYear || '';
    } catch { /* skip */ }
  }

  window.refreshExtendedFeatures = function () {
    bindEvents();
    loadPremieres();
    loadBlacklist();
    window.refreshContinueWatching?.();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      bindEvents();
      hydratePremieresFromCache();
    });
  } else {
    bindEvents();
    hydratePremieresFromCache();
  }
})();
