let movies = [];
let nextId = 1;
let battleSessions = [];
let battleMatches = [];
let pendingDeletedMovieIds = [];
let moviesRevision = 0;
let saveChain = Promise.resolve();
let activeFilters = { status: '', genre: '', tag: '', mediaType: 'movie', search: '', release: 'all', sort: 'added' };

function isAnimatedListItem(movie) {
  return window.MediaCategories?.isAnimatedContent?.(movie) ?? false;
}

function movieMatchesMediaTab(movie, tabType = activeFilters.mediaType) {
  return window.MediaCategories?.matchesListCategory?.(movie, tabType) ?? true;
}

function countMoviesInMediaTab(tabType) {
  return movies.filter((m) => movieMatchesMediaTab(m, tabType)).length;
}

function compactMovieForSave(movie) {
  const meta = { ...(movie.meta || {}) };
  delete meta.castDetails;
  if (typeof meta.overview === 'string' && meta.overview.length > 600) {
    meta.overview = `${meta.overview.slice(0, 600).trim()}…`;
  }
  return { ...movie, meta };
}

function compactMoviesForSave(list) {
  return (list || []).map(compactMovieForSave);
}

function bumpMoviesRevision() {
  moviesRevision += 1;
  window.dispatchEvent(new CustomEvent('movie-list:change'));
}

function syncWatchedViewingHistory(movie) {
  if (!movie?.tmdbId || movie.status !== 'watched') return;
  window.ViewingHistory?.markWatchedFromList?.(movie.tmdbId, movie.mediaType || 'movie');
}

const T = (key, fallback, vars) => (window.t ? window.t(key, vars) : fallback);

function buildStatusLabels() {
  return {
    want: T('status.want', 'Хочу посмотреть'),
    watching: T('status.watching', 'Смотрю'),
    watched: T('status.watched', 'Посмотрел')
  };
}

let statusLabels = buildStatusLabels();

function normalizeStatus(raw) {
  if (!raw) return 'want';
  const lower = String(raw).trim().toLowerCase();
  if (lower === 'want' || lower === 'watching' || lower === 'watched') return lower;
  const map = {
    'хочу посмотреть': 'want',
    'смотрю': 'watching',
    'посмотрел': 'watched',
    'want to watch': 'want',
    'көргім келеді': 'want',
    'көріп жатырмын': 'watching',
    'көрдім': 'watched'
  };
  return map[lower] || 'want';
}

function buildHistoryEventLabels() {
  return {
    added: T('history.added', 'Добавлен в список'),
    status: T('history.status', 'Изменён статус'),
    rating: T('history.rating', 'Изменена оценка')
  };
}

let historyEventLabels = buildHistoryEventLabels();

function formatOriginalTitleHtml(originalTitle, displayTitle, className = 'movie-original-title') {
  return window.MovieDisplay?.formatOriginalTitleHtml(originalTitle, displayTitle, className) || '';
}

function formatDateTime(iso) {
  return window.MovieDisplay?.formatDateTime(iso) || '—';
}

function createHistoryEntry(type, details = {}) {
  const { at, ...rest } = details;
  return { at: at || new Date().toISOString(), type, ...rest };
}

function migrateMovieHistory(movie) {
  if (!Array.isArray(movie.history)) movie.history = [];

  if (!movie.addedAt) {
    movie.addedAt = movie.watchedAt || null;
  }

  if (movie.history.length === 0 && movie.addedAt) {
    movie.history.push(createHistoryEntry('added', { status: 'want', at: movie.addedAt }));

    if (movie.status && movie.status !== 'want') {
      movie.history.push(createHistoryEntry('status', {
        at: movie.watchedAt || movie.addedAt,
        from: 'want',
        to: movie.status,
        rating: movie.rating ?? null
      }));
    }
  }

  return movie;
}

function recordHistory(movie, entry) {
  if (!Array.isArray(movie.history)) movie.history = [];
  movie.history.push(entry);
}

function describeHistoryEntry(entry) {
  if (!entry) return '';

  if (entry.type === 'added') {
    return T('history.addedStatus', `Статус при добавлении: ${statusLabels[entry.status] || entry.status}`, {
      status: statusLabels[entry.status] || entry.status
    });
  }

  if (entry.type === 'status') {
    const from = statusLabels[entry.from] || entry.from;
    const to = statusLabels[entry.to] || entry.to;
    const rating = entry.rating != null
      ? T('history.ratingSuffix', `, оценка ${entry.rating}/10`, { rating: entry.rating })
      : '';
    return T('history.statusChange', `${from} → ${to}${rating}`, { from, to, rating });
  }

  if (entry.type === 'rating') {
    const from = entry.from != null ? `${entry.from}/10` : '—';
    const to = entry.to != null ? `${entry.to}/10` : '—';
    return T('history.ratingChange', `${from} → ${to}`, { from, to });
  }

  return historyEventLabels[entry.type] || entry.type;
}

const WATCH_SITE = 'https://hdrezka.name';
const OVERVIEW_PREVIEW_LENGTH = 140;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function movieDisplayTitle(movie) {
  return window.MovieDisplay?.displayTitle(movie) || movie.title || '';
}

function movieDisplayGenre(genre) {
  return window.MovieDisplay?.displayGenre(genre) || genre || '';
}

function movieDisplayGenres(movie) {
  return window.MovieDisplay?.displayGenres(movie) || movie.genres || [];
}

function normalizeDisplay(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function formatVoteCount(count) {
  if (count == null) return null;
  if (count >= 1_000_000) {
    const value = (count / 1_000_000).toFixed(1).replace(/\.0$/, '');
    return `${value} млн`;
  }
  if (count >= 1000) return `${Math.round(count / 1000)} тыс.`;
  return String(count);
}

function renderExternalRatings(meta) {
  if (!meta) return '';

  const items = [];

  if (meta.imdb?.rating) {
    const votes = formatVoteCount(meta.imdb.votes);
    const votesText = votes ? `<span class="rating-badge__votes">${votes} отзывов</span>` : '';
    const tag = meta.imdb.url ? 'a' : 'span';
    const attrs = meta.imdb.url
      ? ` href="${meta.imdb.url}" target="_blank" rel="noopener noreferrer"`
      : '';
    items.push(
      `<${tag} class="rating-badge rating-badge--imdb"${attrs}>` +
      `<span class="rating-badge__source">IMDb</span> ${meta.imdb.rating}/10 ${votesText}` +
      `</${tag}>`
    );
  }

  if (meta.kinopoisk?.rating) {
    const votes = formatVoteCount(meta.kinopoisk.votes);
    const votesText = votes ? `<span class="rating-badge__votes">${votes} отзывов</span>` : '';
    const tag = meta.kinopoisk.url ? 'a' : 'span';
    const attrs = meta.kinopoisk.url
      ? ` href="${meta.kinopoisk.url}" target="_blank" rel="noopener noreferrer"`
      : '';
    items.push(
      `<${tag} class="rating-badge rating-badge--kp"${attrs}>` +
      `<span class="rating-badge__source">Кинопоиск</span> ${meta.kinopoisk.rating}/10 ${votesText}` +
      `</${tag}>`
    );
  }

  return items.length ? `<div class="external-ratings">${items.join('')}</div>` : '';
}

function renderOverview(movie) {
  const text = window.MovieDisplay?.displayOverview(movie) || movie.meta?.overview;
  if (!text) return '';

  const readMore = window.t ? window.t('movie.readMore', 'Читать полностью') : 'Читать полностью';

  if (text.length <= OVERVIEW_PREVIEW_LENGTH) {
    return `<p class="movie-overview">${escapeHtml(text)}</p>`;
  }

  const preview = `${escapeHtml(text.slice(0, OVERVIEW_PREVIEW_LENGTH).trim())}…`;
  return `
    <p class="movie-overview">${preview}</p>
    <button type="button" class="overview-toggle" data-id="${movie.id}">${escapeHtml(readMore)}</button>
  `;
}

function getWatchUrl(movie) {
  if (typeof movie !== 'string' && movie.meta?.hdrezkaUrl) {
    return movie.meta.hdrezkaUrl;
  }

  const searchTitle = typeof movie === 'string'
    ? movie
    : (movie.meta?.matchedTitle || movie.title);
  const query = encodeURIComponent(searchTitle.trim());
  return `${WATCH_SITE}/index.php?do=search&subaction=search&q=${query}`;
}

const emptyNotes = () => ({
  personal: '', liked: '', disliked: '', favoriteScene: '', rewatch: '', review: ''
});

const movieList = document.getElementById('movie-list');
const emptyMessage = document.getElementById('empty-message');
const filterStatus = document.getElementById('filter-status');
const filterGenre = document.getElementById('filter-genre');
const filterTag = document.getElementById('filter-tag');
const sortBy = document.getElementById('sort-by');
const listSearch = document.getElementById('list-search');
const listCountEl = document.getElementById('list-count');

const LIST_VIEW_STORAGE_KEY = 'movieListView';
const LIST_SORT_STORAGE_KEY = 'movieListSort';
const LIST_SEARCH_SESSION_KEY = 'mf_list_search_v1';
const VALID_SORTS = ['added', 'rating', 'year', 'title'];
const COLLAPSED_GROUPS_KEY = 'collapsedStatusGroups';
const STATUS_ORDER = ['want', 'watched'];

let listViewMode = 'grid';

const storedSort = localStorage.getItem(LIST_SORT_STORAGE_KEY);
if (VALID_SORTS.includes(storedSort)) activeFilters.sort = storedSort;

const storedListSearch = sessionStorage.getItem(LIST_SEARCH_SESSION_KEY);
if (storedListSearch) activeFilters.search = storedListSearch;

let collapsedStatusGroups = new Set(
  JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) || '[]')
);

function getTodayIso() {
  return window.MovieDisplay?.getTodayIso() || new Date().toISOString().slice(0, 10);
}

function parseReleaseDateIso(value) {
  return window.MovieDisplay?.parseReleaseDateIso(value) || null;
}

function getMovieReleaseKind(movie) {
  const today = getTodayIso();
  const currentYear = new Date().getFullYear();
  const releaseDate = parseReleaseDateIso(movie.meta?.releaseDate);
  const year = movie.meta?.year ? Number(movie.meta.year) : null;

  if (releaseDate) {
    return releaseDate > today ? 'unreleased' : 'released';
  }

  if (movie.status === 'watched') return 'released';
  if (year && year < currentYear) return 'released';

  const hasPremiereTag = (movie.tags || []).includes('премьера');
  if (hasPremiereTag || (year && year > currentYear)) return 'unreleased';

  return 'released';
}

function formatReleaseBadge(movie) {
  const kind = getMovieReleaseKind(movie);
  if (kind !== 'unreleased') return '';

  const releaseDate = parseReleaseDateIso(movie.meta?.releaseDate);
  const label = releaseDate
    ? `Премьера ${new Date(`${releaseDate}T12:00:00`).toLocaleDateString('ru-RU')}`
    : 'Ещё не вышло';

  return `<span class="release-badge release-badge--upcoming">${escapeHtml(label)}</span>`;
}

function matchesListSearch(movie, query) {
  const q = normalizeDisplay(query);
  if (!q) return true;

  const parts = [
    movie.title,
    movie.meta?.originalTitle,
    movie.meta?.director,
    movie.meta?.cast,
    ...(movie.genres || []),
    ...(movie.tags || [])
  ].filter(Boolean);

  const haystack = normalizeDisplay(parts.join(' '));
  return haystack.includes(q);
}

function normalizeMovie(movie) {
  const normalized = {
    id: movie.id,
    title: movie.title,
    status: normalizeStatus(movie.status),
    rating: movie.rating ?? null,
    watchedAt: movie.watchedAt ?? null,
    addedAt: movie.addedAt ?? null,
    history: Array.isArray(movie.history) ? movie.history : [],
    genres: movie.genres || [],
    tags: movie.tags || [],
    tmdbId: movie.tmdbId ?? null,
    mediaType: movie.mediaType || 'movie',
    episodeProgress: movie.episodeProgress || null,
    meta: movie.meta || {},
    notes: { ...emptyNotes(), ...(movie.notes || {}) },
    battleWins: movie.battleWins ?? 0,
    battleLosses: movie.battleLosses ?? 0,
    battleScore: movie.battleScore ?? 0,
    lastBattleAt: movie.lastBattleAt ?? null
  };

  return migrateMovieHistory(normalized);
}

function findDuplicateCandidate(candidate) {
  return window.Dedupe?.findDuplicate(movies, candidate) || null;
}

function findMovieByTitle(title, mediaType = null) {
  const lower = title.toLowerCase().trim();
  const pool = mediaType
    ? movies.filter((m) => (m.mediaType || 'movie') === mediaType)
    : movies;
  return (
    pool.find((m) => m.title.toLowerCase() === lower) ||
    pool.find((m) => m.title.toLowerCase().includes(lower)) ||
    (!mediaType && (
      movies.find((m) => m.title.toLowerCase() === lower) ||
      movies.find((m) => m.title.toLowerCase().includes(lower))
    ))
  );
}

function findMovieById(id) {
  return movies.find((m) => m.id === id);
}

function applyWatchedDate(movie, status) {
  if (status === 'watched' && !movie.watchedAt) {
    movie.watchedAt = new Date().toISOString();
  }
  if (status !== 'watched') {
    movie.watchedAt = null;
  }
}

function statusRank(status) {
  return { want: 0, watching: 1, watched: 2 }[status] ?? -1;
}

function shouldMergeDuplicate(existing, data) {
  const newStatus = data.status || 'want';
  const cur = existing.status;
  if (statusRank(newStatus) > statusRank(cur)) return true;
  if (newStatus === cur && newStatus !== 'want' && data.rating != null && existing.rating == null) return true;
  return false;
}

function mergeIntoExistingMovie(existing, data) {
  const prevStatus = existing.status;
  const prevRating = existing.rating;
  const newStatus = data.status || 'want';
  let rating = data.rating ?? existing.rating;

  if (newStatus === 'want') {
    rating = null;
  }
  if (newStatus === 'watched' && (rating == null || rating < 1 || rating > 10)) {
    return { success: false, error: 'Для «посмотрел» нужна оценка 1–10' };
  }
  if (newStatus === 'watching' && rating != null && (rating < 1 || rating > 10)) {
    return { success: false, error: 'Оценка должна быть от 1 до 10' };
  }

  const statusChanged = newStatus !== prevStatus;
  existing.status = newStatus;
  applyWatchedDate(existing, newStatus);
  existing.rating = newStatus === 'want' ? null : rating;

  if (statusChanged) {
    recordHistory(existing, createHistoryEntry('status', {
      from: prevStatus,
      to: newStatus,
      rating: existing.rating ?? null
    }));
    if (newStatus === 'watched') syncWatchedViewingHistory(existing);
  } else if (existing.rating !== prevRating && newStatus !== 'want') {
    recordHistory(existing, createHistoryEntry('rating', {
      from: prevRating,
      to: existing.rating
    }));
  }

  if (data.genres?.length) existing.genres = data.genres;
  if (data.tags?.length) existing.tags = data.tags;
  if (data.tmdbId && !existing.tmdbId) existing.tmdbId = data.tmdbId;
  if (data.meta && Object.keys(data.meta).length) {
    existing.meta = { ...existing.meta, ...data.meta };
  }

  bumpMoviesRevision();
  return { success: true, movie: existing, merged: true };
}

function addMovieInternal(data, { skipDuplicateCheck = false } = {}) {
  // Статус «Смотрю» удалён — мигрируем в «Хочу посмотреть».
  let status = data.status || 'want';
  if (status === 'watching') status = 'want';
  const rating = status === 'want' ? null : (data.rating ?? null);

  // «Посмотрел» можно добавить без оценки (например, через свайп
  // «Уже смотрел»). Оценку можно проставить позже.
  if (status === 'watched' && rating !== null && (rating < 1 || rating > 10)) {
    return { success: false, error: 'Оценка должна быть от 1 до 10' };
  }

  if (!skipDuplicateCheck) {
    const dup = findDuplicateCandidate({
      title: data.title,
      tmdbId: data.tmdbId,
      mediaType: data.mediaType || 'movie',
      meta: data.meta
    });
    if (dup) {
      if (shouldMergeDuplicate(dup.movie, data)) {
        return mergeIntoExistingMovie(dup.movie, data);
      }
      return { success: false, duplicate: dup, error: `Похоже, уже есть: «${dup.movie.title}»` };
    }
  }

  const now = new Date().toISOString();
  const movie = normalizeMovie({
    id: nextId++,
    title: data.title.trim(),
    status,
    rating,
    addedAt: now,
    history: [createHistoryEntry('added', { status, at: now })],
    genres: data.genres || [],
    tags: data.tags || [],
    tmdbId: data.tmdbId || null,
    mediaType: data.mediaType || 'movie',
    episodeProgress: data.episodeProgress || null,
    meta: data.meta || {},
    notes: data.notes || emptyNotes()
  });

  applyWatchedDate(movie, status);
  movies.push(movie);
  bumpMoviesRevision();
  if (status === 'watched') syncWatchedViewingHistory(movie);
  return { success: true, movie };
}

async function matchTmdb(title, mediaType = 'movie') {
  const res = await fetch(`/api/movie/match?q=${encodeURIComponent(title)}&type=${mediaType}`, {
    headers: window.authHeaders()
  });
  if (!res.ok) return null;
  return res.json();
}

async function searchTmdb(title, mediaType = 'movie') {
  const res = await fetch(`/api/movie/search?q=${encodeURIComponent(title)}&type=${mediaType}`, {
    headers: window.authHeaders()
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

async function pickAndApplyTmdb(movie, { interactive = false, force = false } = {}) {
  if (movie.meta?.matchSource === 'manual' && !force) return movie;
  const mediaType = movie.mediaType || 'movie';

  try {
    const match = await matchTmdb(movie.title, mediaType);
    if (!match?.results?.length) return movie;

    if (match.autoPick && match.best) {
      return applyTmdbData(movie, match.best.tmdbId, 'auto');
    }

    if (match.best?.score >= 52) {
      return applyTmdbData(movie, match.best.tmdbId, 'auto');
    }

    if (interactive) {
      const picked = await window.showTmdbPicker(match.results);
      if (picked) return applyTmdbData(movie, picked, 'manual');
      return movie;
    }

    if (match.results.length === 1) {
      return applyTmdbData(movie, match.results[0].tmdbId, 'auto');
    }
  } catch (e) { /* skip */ }

  return movie;
}

async function enrichMovieAuto(movie) {
  if (movie.meta?.matchSource === 'manual' && movie.meta?.poster) return movie;
  return pickAndApplyTmdb(movie, { interactive: false });
}

async function enrichMovie(movie) {
  if (movie.meta?.matchSource === 'manual' && movie.meta?.poster) return movie;
  return pickAndApplyTmdb(movie, { interactive: true });
}

async function enrichAllMovies() {
  const coreBefore = new Map(movies.map((m) => [m.id, snapshotMovieCore(m)]));
  let changed = false;

  for (const movie of movies) {
    if (movie.meta?.matchSource === 'manual') {
      if (movie.tmdbId && !movie.meta?.imdb?.rating && !movie.meta?.kinopoisk?.rating) {
        await applyTmdbData(movie, movie.tmdbId, 'manual');
        changed = true;
        renderMovies();
      }
      continue;
    }

    try {
      const match = await matchTmdb(movie.title, movie.mediaType || 'movie');
      const needsRatings = movie.tmdbId && (
        !movie.meta?.imdb?.rating
        || !movie.meta?.kinopoisk?.rating
        || movie.meta?.imdb?.source !== 'hdrezka'
      );

      if (needsRatings) {
        await applyTmdbData(movie, movie.tmdbId, movie.meta?.matchSource || 'auto');
        changed = true;
        renderMovies();
        continue;
      }

      if (!match?.results?.length) continue;

      const hasPoster = !!movie.meta?.poster;
      const currentId = movie.tmdbId;

      if (match.autoPick && match.best) {
        if (!hasPoster || match.best.tmdbId !== currentId) {
          await applyTmdbData(movie, match.best.tmdbId, 'auto');
          changed = true;
          renderMovies();
        }
      } else if (!hasPoster && match.results.length === 1) {
        await applyTmdbData(movie, match.results[0].tmdbId, 'auto');
        changed = true;
        renderMovies();
      }
    } catch (e) { /* skip */ }
  }

  const coreChanged = movies.some((m) => coreBefore.get(m.id) !== snapshotMovieCore(m));
  if (changed && !coreChanged) {
    await saveMovies();
  } else if (changed && coreChanged) {
    console.warn('Обогащение TMDB: изменения статуса/типа не сохранены автоматически');
    renderMovies();
  }
}

async function applyTmdbData(movie, tmdbId, matchSource = 'auto') {
  const mediaType = movie.mediaType || 'movie';
  const appLang = window.I18N?.getLang?.() || 'ru';
  const res = await fetch(`/api/movie/details/${tmdbId}?type=${mediaType}&lang=${encodeURIComponent(appLang)}`, {
    cache: 'no-store',
    headers: window.authHeaders()
  });
  if (!res.ok) return movie;
  const data = await res.json();
  const lockedMediaType = movie.mediaType || 'movie';
  const lockedStatus = movie.status;
  const lockedRating = movie.rating;
  const lockedWatchedAt = movie.watchedAt;

  movie.tmdbId = data.tmdbId;
  if (!data.mediaType || data.mediaType === lockedMediaType) {
    movie.mediaType = data.mediaType || lockedMediaType;
  }
  movie.meta = { ...movie.meta, ...data.meta, matchSource };
  if (data.title) movie.title = data.title;
  if (!movie.genres.length) movie.genres = data.genres || [];

  movie.status = lockedStatus;
  movie.rating = lockedRating;
  movie.watchedAt = lockedWatchedAt;

  return movie;
}

async function relinkMoviePoster(movieId) {
  const movie = findMovieById(movieId);
  if (!movie) return;

  const results = await searchTmdb(movie.title, movie.mediaType || 'movie');
  if (!results.length) {
    window.alert?.(`${movie.mediaType === 'tv' ? 'Сериал' : 'Фильм'} не найден в TMDB. Попробуйте изменить название в списке.`);
    return;
  }

  const label = movie.mediaType === 'tv' ? 'сериал' : 'фильм';
  const picked = await window.showTmdbPicker(results, `Выберите правильный ${label}: «${movie.title}»`);
  if (!picked) return;

  await applyTmdbData(movie, picked, 'manual');
  await saveMovies();
}

async function enrichMoviesBatch(items) {
  for (const movie of items) {
    if (movie.meta?.poster && movie.tmdbId) continue;
    await enrichMovieAuto(movie);
    renderMovies();
  }
}

function buildAddMovieData(title, status, genres, tags, resolved, rating = null, mediaType = 'movie') {
  const effectiveMediaType = resolved?.mediaType || mediaType || 'movie';
  if (resolved?.unresolved) {
    return {
      title,
      status: status || 'want',
      rating: (status || 'want') === 'want' ? null : rating,
      genres: genres || [],
      tags: tags || [],
      mediaType: effectiveMediaType
    };
  }
  const effectiveRating = (status || 'want') === 'want' ? null : rating;
  if (resolved?.tmdbId) {
    return {
      title: resolved.title || title,
      status: status || 'want',
      rating: effectiveRating,
      genres: resolved.genres?.length ? resolved.genres : (genres || []),
      tags: tags || [],
      tmdbId: resolved.tmdbId,
      mediaType: effectiveMediaType,
      meta: { ...(resolved.meta || {}), matchSource: 'auto' }
    };
  }

  return {
    title,
    status: status || 'want',
    rating: effectiveRating,
    genres: genres || [],
    tags: tags || [],
    mediaType: effectiveMediaType
  };
}

async function addMovie(data) {
  const result = addMovieInternal(data);
  if (result.duplicate) {
    window.showDuplicateModal?.(result.duplicate, data);
    return result;
  }
  if (result.success) {
    if ((result.movie.meta?.poster && result.movie.tmdbId)
      || (result.movie.tmdbId && data.meta?.matchSource === 'discover')) {
      renderMovies();
    } else {
      await enrichMovie(result.movie);
      renderMovies();
    }
  }
  return result;
}

async function addMovies(titles, status, genres, tags, resolved = [], rating = null, mediaType = 'movie') {
  const added = [];
  const skipped = [];
  titles.forEach((title, index) => {
    const data = buildAddMovieData(
      title,
      status,
      genres,
      tags,
      resolved[index],
      rating,
      mediaType
    );
    if (!data) {
      skipped.push({ title, reason: 'Не найден в TMDB — проверьте название' });
      return;
    }
    const result = addMovieInternal(data);
    if (result.success) added.push(result.movie);
    else skipped.push({ title, reason: result.error });
  });
  if (added.length > 0) {
    renderMovies();
    await enrichMoviesBatch(added);
  }
  return { success: added.length > 0, added, skipped, count: added.length };
}

function deleteMovieById(id) {
  const movie = findMovieById(id);
  if (!movie) return { success: false, error: 'Фильм не найден' };
  if (Number.isInteger(movie.id) && movie.id > 0) {
    pendingDeletedMovieIds.push(movie.id);
  }
  movies = movies.filter((m) => m.id !== id);
  bumpMoviesRevision();
  saveMovies();
  return { success: true, movie };
}

function deleteMovieByTitle(title, mediaType = null) {
  const movie = findMovieByTitle(title, mediaType);
  if (!movie) {
    const label = mediaType === 'tv' ? 'Сериал' : 'Фильм';
    return { success: false, error: `${label} «${title}» не найден` };
  }
  return deleteMovieById(movie.id);
}

function confirmDeleteMovie(movieId) {
  const movie = findMovieById(movieId);
  if (!movie) return;
  if (!window.confirm(`Удалить «${movie.title}» из списка?`)) return;
  deleteMovieById(movieId);
}

function updateMovie(data) {
  const movie = findMovieByTitle(data.title, data.mediaType || null);
  if (!movie) {
    const label = data.mediaType === 'tv' ? 'Сериал' : 'Фильм';
    return { success: false, error: `${label} «${data.title}» не найден` };
  }

  const prevStatus = movie.status;
  const prevRating = movie.rating;
  const statusChanged = data.status && data.status !== prevStatus;
  const ratingProvided = data.rating !== undefined && data.rating !== null;
  const ratingChanged = ratingProvided && data.rating !== prevRating;

  if (statusChanged) {
    movie.status = data.status;
    applyWatchedDate(movie, data.status);
    if (data.status === 'want') {
      movie.rating = null;
    } else if (ratingProvided) {
      if (data.rating < 1 || data.rating > 10) return { success: false, error: 'Оценка 1–10' };
      movie.rating = data.rating;
    }

    recordHistory(movie, createHistoryEntry('status', {
      from: prevStatus,
      to: data.status,
      rating: movie.rating ?? null
    }));
    if (data.status === 'watched') syncWatchedViewingHistory(movie);
  }

  if (ratingChanged && movie.status !== 'want' && !statusChanged) {
    if (data.rating < 1 || data.rating > 10) return { success: false, error: 'Оценка 1–10' };
    recordHistory(movie, createHistoryEntry('rating', {
      from: prevRating,
      to: data.rating
    }));
    movie.rating = data.rating;
  }

  if (data.genres) movie.genres = data.genres;
  if (data.tags) movie.tags = data.tags;

  bumpMoviesRevision();
  saveMovies();
  return { success: true, movie };
}

function updateMovieNotes(data) {
  const movie = findMovieByTitle(data.title, data.mediaType || null);
  if (!movie) return { success: false, error: 'Не найден в списке' };
  Object.keys(emptyNotes()).forEach((key) => {
    if (data[key] !== undefined) movie.notes[key] = data[key];
  });
  bumpMoviesRevision();
  saveMovies();
  return { success: true, movie };
}

async function executeAction(action) {
  switch (action.type) {
    case 'add_movies':
      return addMovies(
        action.titles,
        action.status,
        action.genres,
        action.tags,
        action.resolved,
        action.rating,
        action.mediaType || 'movie'
      );
    case 'add_movie':
      return addMovie({
        title: action.title,
        status: action.status,
        rating: action.rating,
        genres: action.genres,
        tags: action.tags,
        tmdbId: action.tmdbId,
        mediaType: action.mediaType || 'movie',
        meta: action.meta
      });
    case 'delete_movie':
      return deleteMovieByTitle(action.title, action.mediaType || null);
    case 'update_movie':
      return updateMovie(action);
    case 'update_movie_notes':
      return updateMovieNotes(action);
    default:
      return { success: false, error: 'Неизвестное действие' };
  }
}

async function executeActions(actions) {
  const results = [];
  for (const action of actions || []) {
    results.push(await executeAction(action));
  }
  const saved = await saveMovies();
  if (!saved) {
    return results.map((result) => (
      result?.success === false
        ? result
        : { ...result, saveWarning: 'Не удалось сохранить на сервер. Перезапустите сервер и обновите страницу (Ctrl+F5).' }
    ));
  }
  return results;
}

function getTabFilteredMovies() {
  return movies.filter((m) => {
    if (!movieMatchesMediaTab(m)) return false;
    if (activeFilters.genre && !m.genres.some((g) => g.toLowerCase().includes(activeFilters.genre.toLowerCase()))) return false;
    if (activeFilters.tag && !m.tags.some((t) => t.toLowerCase().includes(activeFilters.tag.toLowerCase()))) return false;
    if (!matchesListSearch(m, activeFilters.search)) return false;

    const releaseKind = getMovieReleaseKind(m);
    if (activeFilters.release === 'premieres' && releaseKind !== 'unreleased') return false;
    if (activeFilters.release === 'released' && releaseKind !== 'released') return false;

    return true;
  });
}

function getFilteredMovies() {
  return getTabFilteredMovies().filter((m) => {
    if (activeFilters.status && m.status !== activeFilters.status) return false;
    return true;
  });
}

function movieAddedTime(m) {
  return m.addedAt ? Date.parse(m.addedAt) || 0 : 0;
}

function movieSortRating(m) {
  return Number(m.rating)
    || Number(m.meta?.imdb?.rating)
    || Number(m.meta?.kinopoisk?.rating)
    || 0;
}

function sortMovies(arr) {
  const list = [...arr];
  switch (activeFilters.sort) {
    case 'rating':
      list.sort((a, b) => movieSortRating(b) - movieSortRating(a) || movieAddedTime(b) - movieAddedTime(a));
      break;
    case 'year':
      list.sort((a, b) => (Number(b.meta?.year) || 0) - (Number(a.meta?.year) || 0) || movieAddedTime(b) - movieAddedTime(a));
      break;
    case 'title':
      list.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ru'));
      break;
    case 'added':
    default:
      list.sort((a, b) => movieAddedTime(b) - movieAddedTime(a));
      break;
  }
  return list;
}

function snapshotMovieCore(movie) {
  return `${movie.id}:${movie.status}:${movie.mediaType || 'movie'}:${movie.rating ?? ''}`;
}

function updateListViewToggle() {
  document.querySelectorAll('.list-view-btn').forEach((btn) => {
    btn.classList.toggle('list-view-btn--active', btn.dataset.view === listViewMode);
  });
  if (movieList) {
    movieList.classList.toggle('movie-list--grid', listViewMode === 'grid');
    movieList.classList.toggle('movie-list--list', listViewMode === 'list');
  }
}

function setListViewMode(mode) {
  listViewMode = mode === 'list' ? 'list' : 'grid';
  localStorage.setItem(LIST_VIEW_STORAGE_KEY, listViewMode);
  updateListViewToggle();
  renderMovies();
}

function toggleStatusGroup(status) {
  if (collapsedStatusGroups.has(status)) collapsedStatusGroups.delete(status);
  else collapsedStatusGroups.add(status);
  localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...collapsedStatusGroups]));
  const section = movieList?.querySelector(`.status-group[data-status="${status}"]`);
  section?.classList.toggle('status-group--collapsed', collapsedStatusGroups.has(status));
}

function closeAllMovieMenus() {
  document.querySelectorAll('.movie-card-menu-dropdown').forEach((el) => {
    el.classList.add('hidden');
  });
  document.querySelectorAll('.movie-card--menu-open').forEach((el) => {
    el.classList.remove('movie-card--menu-open');
  });
}

// Клик по постеру/названию открывает страницу фильма (/movie.html), если у
// фильма есть tmdbId. Иначе (нераспознанный фильм без tmdbId) — оставляем
// прежнее поведение: ссылку на поиск HDRezka в новой вкладке.
function getMoviePageHref(movie) {
  return window.MovieDisplay?.moviePageUrl(movie) || null;
}

function buildMovieGridPosterHtml(movie, watchUrl) {
  const safeTitle = escapeHtml(movieDisplayTitle(movie));
  const posterUrl = window.MovieDisplay?.posterUrl(movie.meta?.poster) || movie.meta?.poster;
  const posterInner = posterUrl
    ? `<img class="movie-poster--grid" src="${escapeHtml(posterUrl)}" alt="${safeTitle}" loading="lazy" decoding="async">`
    : '<div class="movie-poster--empty movie-poster--grid">🎬</div>';
  const pageHref = getMoviePageHref(movie);
  if (pageHref) {
    return `<a href="${pageHref}" class="movie-poster-link movie-poster-link--grid" title="Открыть страницу фильма">${posterInner}</a>`;
  }
  return `<a href="${watchUrl}" target="_blank" rel="noopener noreferrer" class="movie-poster-link movie-poster-link--grid" title="Смотреть на HDRezka">${posterInner}</a>`;
}

function buildMoviePosterHtml(movie, watchUrl) {
  const safeTitle = escapeHtml(movieDisplayTitle(movie));
  const posterUrl = window.MovieDisplay?.posterUrl(movie.meta?.poster) || movie.meta?.poster;
  const posterInner = posterUrl
    ? `<img class="movie-poster" src="${escapeHtml(posterUrl)}" alt="${safeTitle}" loading="lazy" decoding="async">`
    : '<div class="movie-poster movie-poster--empty">🎬</div>';
  const pageHref = getMoviePageHref(movie);
  if (pageHref) {
    return `<a href="${pageHref}" class="movie-poster-link" title="Открыть страницу фильма">${posterInner}</a>`;
  }
  return `<a href="${watchUrl}" target="_blank" rel="noopener noreferrer" class="movie-poster-link" title="Смотреть на HDRezka">${posterInner}</a>`;
}

function buildMovieDetailsHtml(movie, watchUrl) {
  const safeTitle = escapeHtml(movieDisplayTitle(movie));
  const isTv = movie.mediaType === 'tv';
  const originalTitleHtml = formatOriginalTitleHtml(movie.meta?.originalTitle, movieDisplayTitle(movie));
  const typeBadge = isTv ? '<span class="media-badge media-badge--tv">Сериал</span>' : '';
  const releaseBadge = formatReleaseBadge(movie);

  const metaLine = [
    movie.meta?.year,
    isTv && movie.meta?.seasons ? `${movie.meta.seasons} сез.` : null,
    movie.meta?.runtime ? `${movie.meta.runtime} мин` : null,
    isTv && movie.episodeProgress ? `с.${movie.episodeProgress.season} э.${movie.episodeProgress.episode}` : null
  ].filter(Boolean).join(' · ');

  const directorHtml = movie.meta?.directorId
    ? `<p class="movie-people-line">Режиссёр: <button type="button" class="person-link" data-person-id="${movie.meta.directorId}">${escapeHtml(movie.meta.director)}</button></p>`
    : (movie.meta?.director ? `<p class="movie-people-line">Режиссёр: ${escapeHtml(movie.meta.director)}</p>` : '');

  const castLinks = (movie.meta?.castDetails || []).slice(0, 3).map((c) =>
    `<button type="button" class="person-link" data-person-id="${c.id}">${escapeHtml(c.name)}</button>`
  ).join(', ');
  const castHtml = castLinks ? `<p class="movie-people-line">В ролях: ${castLinks}</p>` : '';

  const tagsHtml = [...movieDisplayGenres(movie), ...movie.tags]
    .map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('');

  const pageHref = getMoviePageHref(movie);
  const titleLink = pageHref
    ? `<a href="${pageHref}" class="movie-title-link" title="Открыть страницу фильма">${safeTitle}</a>`
    : `<a href="${watchUrl}" target="_blank" rel="noopener noreferrer" class="movie-title-link">${safeTitle}</a>`;

  return `
    <div class="movie-info">
      <h3 class="movie-title-row">
        ${titleLink}
        ${typeBadge}
        ${releaseBadge}
        ${originalTitleHtml}
      </h3>
      <a href="${watchUrl}" target="_blank" rel="noopener noreferrer" class="movie-watch-link">${isTv ? 'Смотреть сериал на HDRezka' : 'Смотреть на HDRezka'}</a>
      ${metaLine ? `<p class="movie-meta-line">${metaLine}</p>` : ''}
      ${directorHtml}
      ${castHtml}
      ${renderExternalRatings(movie.meta)}
      <span class="status-badge">${statusLabels[movie.status]}</span>
      ${movie.rating ? `<p class="rating rating--personal">Моя оценка: <strong>${movie.rating}/10</strong></p>` : ''}
      ${tagsHtml ? `<div class="tag-list">${tagsHtml}</div>` : ''}
      ${renderOverview(movie)}
    </div>
  `;
}

async function changeMovieStatus(movieId, newStatus) {
  const movie = findMovieById(movieId);
  if (!movie || movie.status === newStatus) return;

  let rating = movie.rating;
  if (newStatus === 'watched') {
    const value = await window.promptWatchedRating?.({
      title: movie.title,
      initialRating: rating ?? undefined
    });
    if (value == null) return;
    rating = value;
  }

  updateMovie({
    title: movie.title,
    mediaType: movie.mediaType || 'movie',
    status: newStatus,
    rating: newStatus === 'want' ? null : rating
  });
}

function buildMovieActionsHtml(movie, variant = 'list') {
  if (variant === 'grid') {
    return `
      <div class="movie-card-menu movie-card-menu--grid">
        <button type="button" class="movie-card-menu-btn" aria-label="Действия" aria-haspopup="true">⋮</button>
        <div class="movie-card-menu-dropdown hidden">
          <div class="movie-card-menu-section">Статус</div>
          <button type="button" class="menu-item menu-item--status${movie.status === 'want' ? ' menu-item--active' : ''}" data-status="want" data-id="${movie.id}">${statusLabels.want}</button>
          <button type="button" class="menu-item menu-item--status${movie.status === 'watched' ? ' menu-item--active' : ''}" data-status="watched" data-id="${movie.id}">${statusLabels.watched}</button>
          <div class="movie-card-menu-divider"></div>
          <button type="button" class="menu-item btn-fix-poster" data-id="${movie.id}">Исправить постер</button>
          <button type="button" class="menu-item btn-history" data-id="${movie.id}">История</button>
          <button type="button" class="menu-item btn-notes" data-id="${movie.id}">Заметки</button>
          <button type="button" class="menu-item btn-similar" data-id="${movie.id}">Похожие</button>
          <button type="button" class="menu-item menu-item--danger btn-delete" data-id="${movie.id}">Удалить</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="movie-actions">
      <button type="button" class="action-btn action-btn--poster btn-fix-poster" data-id="${movie.id}" title="Исправить постер" aria-label="Исправить постер">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
        <span>Постер</span>
      </button>
      <button type="button" class="action-btn action-btn--history btn-history" data-id="${movie.id}" title="История" aria-label="История">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
        <span>История</span>
      </button>
      <button type="button" class="action-btn action-btn--notes btn-notes" data-id="${movie.id}" title="Заметки" aria-label="Заметки">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
        <span>Заметки</span>
      </button>
    </div>
  `;
}

function buildMovieFooterHtml(movie) {
  return `
    <div class="movie-card__footer">
      <button type="button" class="footer-btn footer-btn--similar btn-similar" data-id="${movie.id}">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
        Похожие
      </button>
      <button type="button" class="footer-btn footer-btn--delete btn-delete" data-id="${movie.id}">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        Удалить
      </button>
    </div>
  `;
}

function attachMovieCardListeners(li, movie) {
  li.querySelectorAll('.menu-item--status').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllMovieMenus();
      changeMovieStatus(Number(btn.dataset.id), btn.dataset.status);
    });
  });
  li.querySelector('.btn-fix-poster')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMovieMenus();
    relinkMoviePoster(movie.id);
  });
  li.querySelector('.btn-history')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMovieMenus();
    window.openHistoryModal(movie.id);
  });
  li.querySelector('.btn-notes')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMovieMenus();
    window.openNotesModal(movie.id);
  });
  li.querySelector('.btn-similar')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMovieMenus();
    window.findSimilar(movie.id);
  });
  li.querySelector('.btn-delete')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMovieMenus();
    confirmDeleteMovie(movie.id);
  });
  li.querySelectorAll('.person-link').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.openPersonModal?.(btn.dataset.personId);
    });
  });
  li.querySelector('.overview-toggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.openMovieOverview(movie.id);
  });

  const menuBtn = li.querySelector('.movie-card-menu-btn');
  menuBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dropdown = li.querySelector('.movie-card-menu-dropdown');
    const wasOpen = dropdown && !dropdown.classList.contains('hidden');
    closeAllMovieMenus();
    if (dropdown && !wasOpen) {
      dropdown.classList.remove('hidden');
      li.classList.add('movie-card--menu-open');
    }
  });
}

function createMovieGridItem(movie) {
  const li = document.createElement('li');
  li.className = 'movie-card movie-card--grid';
  li.dataset.status = movie.status;

  const watchUrl = getWatchUrl(movie);
  const safeTitle = escapeHtml(movieDisplayTitle(movie));
  const isTv = movie.mediaType === 'tv';
  const typeBadge = isTv ? '<span class="media-badge media-badge--tv media-badge--grid">Сериал</span>' : '';
  const releaseBadge = formatReleaseBadge(movie);

  if (getMovieReleaseKind(movie) === 'unreleased') {
    li.classList.add('movie-card--unreleased');
  }

  const metaParts = [
    movie.meta?.year,
    movie.rating != null ? `${movie.rating}/10` : null
  ].filter(Boolean);

  li.innerHTML = `
    <div class="movie-grid-poster-wrap">
      ${buildMovieGridPosterHtml(movie, watchUrl)}
    </div>
    ${buildMovieActionsHtml(movie, 'grid')}
    <div class="movie-grid-body">
      ${getMoviePageHref(movie)
        ? `<a href="${getMoviePageHref(movie)}" class="movie-title-link movie-grid-title" title="${safeTitle}">${safeTitle}</a>`
        : `<a href="${watchUrl}" target="_blank" rel="noopener noreferrer" class="movie-title-link movie-grid-title" title="${safeTitle}">${safeTitle}</a>`}
      ${typeBadge || releaseBadge ? `<div class="movie-grid-tags">${typeBadge}${releaseBadge}</div>` : ''}
      ${metaParts.length ? `<p class="movie-grid-meta">${escapeHtml(metaParts.join(' · '))}</p>` : ''}
    </div>
  `;

  attachMovieCardListeners(li, movie);
  return li;
}

function createMovieListItem(movie) {
  const li = document.createElement('li');
  li.className = 'movie-card movie-card--list';
  li.dataset.status = movie.status;

  const watchUrl = getWatchUrl(movie);

  if (getMovieReleaseKind(movie) === 'unreleased') {
    li.classList.add('movie-card--unreleased');
  }

  li.innerHTML = `
    <div class="movie-card__body">
      ${buildMoviePosterHtml(movie, watchUrl)}
      ${buildMovieDetailsHtml(movie, watchUrl)}
      ${buildMovieActionsHtml(movie, 'list')}
    </div>
    ${buildMovieFooterHtml(movie)}
  `;

  attachMovieCardListeners(li, movie);
  return li;
}

function renderGroupedGrid(tabMovies) {
  STATUS_ORDER.forEach((status) => {
    if (activeFilters.status && activeFilters.status !== status) return;

    const items = sortMovies(tabMovies.filter((movie) => movie.status === status));

    const section = document.createElement('section');
    section.className = 'status-group';
    section.dataset.status = status;
    if (collapsedStatusGroups.has(status)) {
      section.classList.add('status-group--collapsed');
    }

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'status-group-header';
    header.innerHTML = `
      <span class="status-group-title">${statusLabels[status]}</span>
      <span class="status-group-count">${items.length}</span>
      <span class="status-group-chevron" aria-hidden="true">▾</span>
    `;
    header.addEventListener('click', () => toggleStatusGroup(status));

    const grid = document.createElement('ul');
    grid.className = 'status-group-grid';
    if (items.length) {
      items.forEach((movie) => grid.appendChild(createMovieGridItem(movie)));
    } else {
      const emptyItem = document.createElement('li');
      emptyItem.className = 'status-group-empty';
      emptyItem.textContent = 'Пока пусто';
      grid.appendChild(emptyItem);
    }

    section.appendChild(header);
    section.appendChild(grid);
    movieList.appendChild(section);
  });
}

function renderFlatList(filtered) {
  const list = document.createElement('ul');
  list.className = 'movie-list-flat';
  sortMovies(filtered).forEach((movie) => list.appendChild(createMovieListItem(movie)));
  movieList.appendChild(list);
}

function updateListCount(filteredCount) {
  if (!listCountEl) return;
  const totalInTab = countMoviesInMediaTab(activeFilters.mediaType);
  listCountEl.textContent = filteredCount === totalInTab
    ? T('list.inList', `${filteredCount} в списке`, { n: filteredCount })
    : T('list.shownOf', `Показано ${filteredCount} из ${totalInTab}`, { n: filteredCount, total: totalInTab });
}

function syncFilterUI() {
  if (filterStatus) filterStatus.value = activeFilters.status || '';
  if (sortBy) sortBy.value = activeFilters.sort || 'added';

  if (filterGenre) {
    const genre = activeFilters.genre || '';
    if (genre && [...filterGenre.options].some((o) => o.value === genre)) {
      filterGenre.value = genre;
    } else if (genre) {
      activeFilters.genre = '';
      filterGenre.value = '';
    }
  }

  if (filterTag) {
    const tag = activeFilters.tag || '';
    if (tag && [...filterTag.options].some((o) => o.value === tag)) {
      filterTag.value = tag;
    } else if (tag) {
      activeFilters.tag = '';
      filterTag.value = '';
    }
  }

  if (listSearch) listSearch.value = activeFilters.search || '';

  document.querySelectorAll('.release-filter-btn').forEach((btn) => {
    btn.classList.toggle(
      'release-filter-btn--active',
      btn.dataset.release === (activeFilters.release || 'all')
    );
  });

  document.querySelectorAll('.media-tab').forEach((tab) => {
    const type = tab.dataset.media;
    tab.classList.toggle('media-tab--active', type === activeFilters.mediaType);
    const count = countMoviesInMediaTab(type);
    const label = type === 'tv'
      ? T('list.tabSeries', 'Сериалы')
      : type === 'animation'
        ? T('list.tabAnimation', 'Мульт и аниме')
        : T('list.tabMovies', 'Фильмы');
    tab.textContent = count ? `${label} (${count})` : label;
  });

  const listTitle = document.getElementById('list-title');
  if (listTitle) {
    listTitle.textContent = activeFilters.mediaType === 'tv'
      ? T('list.titleSeries', 'Мои сериалы')
      : activeFilters.mediaType === 'animation'
        ? T('list.titleAnimation', 'Мультфильмы и аниме')
        : T('list.title', 'Мой список');
  }

  const addSeriesBtn = document.getElementById('add-series-btn');
  if (addSeriesBtn) {
    addSeriesBtn.classList.toggle('hidden', activeFilters.mediaType !== 'tv');
  }

  const resetFiltersBtn = document.getElementById('reset-filters-btn');
  if (resetFiltersBtn) {
    const hasActive = Boolean(
      activeFilters.status
      || activeFilters.genre
      || activeFilters.tag
      || activeFilters.search
      || (activeFilters.release && activeFilters.release !== 'all')
    );
    resetFiltersBtn.classList.toggle('hidden', !hasActive);
  }
}

function updateFilterOptions() {
  const genres = new Set();
  const tags = new Set();
  movies.filter((m) => movieMatchesMediaTab(m)).forEach((m) => {
    m.genres.forEach((g) => genres.add(g));
    m.tags.forEach((t) => tags.add(t));
  });

  if (filterGenre) {
    const allGenresLabel = window.t ? window.t('list.allGenres') : 'Все жанры';
    filterGenre.innerHTML = `<option value="">${escapeHtml(allGenresLabel)}</option>`;
    [...genres].sort().forEach((g) => {
      filterGenre.innerHTML += `<option value="${escapeHtml(g)}">${escapeHtml(movieDisplayGenre(g))}</option>`;
    });
  }
  if (filterTag) {
    filterTag.innerHTML = '<option value="">Все теги</option>';
    [...tags].sort().forEach((t) => {
      filterTag.innerHTML += `<option value="${t}">${t}</option>`;
    });
  }
}

function renderMovies() {
  if (!movieList) return;
  const filtered = getFilteredMovies();
  movieList.innerHTML = '';
  updateFilterOptions();
  syncFilterUI();
  updateListViewToggle();

  if (movies.length === 0) {
    if (emptyMessage) {
      emptyMessage.style.display = 'block';
      emptyMessage.textContent = T('list.emptyAll', 'Пока нет фильмов и сериалов. Импортируйте список или напишите AI-помощнику.');
    }
    if (listCountEl) listCountEl.textContent = '';
    return;
  }

  if (filtered.length === 0) {
    if (emptyMessage) {
      emptyMessage.style.display = 'block';
      const typeLabel = activeFilters.mediaType === 'tv'
        ? T('list.ofSeries', 'сериалов')
        : activeFilters.mediaType === 'animation'
          ? T('list.ofAnimation', 'мультфильмов и аниме')
          : T('list.ofMovies', 'фильмов');
      if (activeFilters.search) {
        emptyMessage.textContent = T('list.noSearch', `По запросу «${activeFilters.search}» ничего не найдено.`, { q: activeFilters.search });
      } else if (activeFilters.release === 'premieres') {
        emptyMessage.textContent = T('list.noPremieres', `Нет предстоящих премьер среди ${typeLabel}.`, { type: typeLabel });
      } else if (activeFilters.release === 'released') {
        emptyMessage.textContent = T('list.noReleased', `Нет вышедших ${typeLabel} по выбранным фильтрам.`, { type: typeLabel });
      } else if (activeFilters.status) {
        const statusLabel = statusLabels[activeFilters.status] || activeFilters.status;
        emptyMessage.textContent = T('list.noStatus', `Нет ${typeLabel} со статусом «${statusLabel}». Выберите «Все статусы» в фильтре выше.`, { type: typeLabel, status: statusLabel });
      } else {
        emptyMessage.textContent = T('list.noFilters', `Нет ${typeLabel} по выбранным фильтрам.`, { type: typeLabel });
      }
    }
    updateListCount(0);
    return;
  }

  if (emptyMessage) emptyMessage.style.display = 'none';
  updateListCount(filtered.length);

  if (listViewMode === 'grid') {
    renderGroupedGrid(getTabFilteredMovies());
  } else {
    renderFlatList(filtered);
  }
}

// Смена языка: пересобираем подписи статусов и перерисовываем список и
// зависимые блоки, чтобы динамический интерфейс тоже переводился.
document.addEventListener('i18n:change', async () => {
  statusLabels = buildStatusLabels();
  historyEventLabels = buildHistoryEventLabels();
  try {
    await window.MovieDisplay?.localizeTitles?.(movies);
    renderMovies();
  } catch (e) { /* список ещё не готов */ }
  window.refreshExtendedFeatures?.();
  window.BattleUI?.refresh?.();
});

function saveMovies() {
  saveChain = saveChain
    .then(() => flushSaveMovies())
    .catch((error) => {
      console.error('Ошибка сохранения', error);
      return false;
    });
  return saveChain;
}

async function flushSaveMovies() {
  // Гостевой режим: сохраняем список локально (перенесётся в аккаунт при входе).
  if (window.GuestStore && window.GuestStore.isActive()) {
    window.GuestStore.saveMovies(
      compactMoviesForSave(movies),
      nextId,
      battleSessions,
      battleMatches
    );
    pendingDeletedMovieIds = [];
    renderMovies();
    window.refreshStats?.();
    window.refreshAccountPage?.();
    window.refreshExtendedFeatures?.();
    window.BattleUI?.refresh?.();
    return true;
  }

  let staleRetries = 0;

  while (true) {
    const revisionAtStart = moviesRevision;
    const deletedMovieIds = [...new Set(pendingDeletedMovieIds)];
    const localCount = movies.length;

    try {
      const res = await fetch('/api/movies', {
        method: 'PUT',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', ...window.authHeaders() },
        body: JSON.stringify({
          movies: compactMoviesForSave(movies),
          nextId,
          battleSessions,
          battleMatches,
          deletedMovieIds
        })
      });
      if (res.status === 413) {
        console.error('Список слишком большой для сохранения');
        return false;
      }
      if (res.status === 401) {
        window.handleAuthExpired?.('Сессия истекла. Войдите снова — последние изменения не сохранены.');
        return false;
      }
      if (!res.ok) {
        console.error('Ошибка сохранения:', res.status);
        return false;
      }

      const data = await res.json();
      if (moviesRevision !== revisionAtStart) {
        staleRetries = 0;
        continue;
      }

      pendingDeletedMovieIds = pendingDeletedMovieIds.filter((id) => !deletedMovieIds.includes(id));

      if (Array.isArray(data.movies)) {
        const staleResponse = data.movies.length < localCount && deletedMovieIds.length === 0;
        if (staleResponse) {
          staleRetries += 1;
          if (staleRetries > 5) {
            console.error('Не удалось синхронизировать список с сервером');
            return false;
          }
          console.warn('Ответ сервера устарел — повторяю сохранение');
          continue;
        }

        movies = data.movies.map(normalizeMovie);
        nextId = data.nextId || nextId;
        if (Array.isArray(data.battleSessions)) battleSessions = data.battleSessions;
        if (Array.isArray(data.battleMatches)) battleMatches = data.battleMatches;
      }

      renderMovies();
      window.refreshStats?.();
      window.refreshAccountPage?.();
      window.refreshExtendedFeatures?.();
      window.BattleUI?.refresh?.();
      return true;
    } catch (e) {
      console.error('Ошибка сохранения');
      return false;
    }
  }
}

async function loadMovies(options = {}) {
  // Гостевой режим: список читается из локального гостевого хранилища.
  if (window.GuestStore && window.GuestStore.isActive()) {
    const data = window.GuestStore.load();
    movies = (data.movies || []).map(normalizeMovie);
    nextId = data.nextId || 1;
    battleSessions = Array.isArray(data.battleSessions) ? data.battleSessions : [];
    battleMatches = Array.isArray(data.battleMatches) ? data.battleMatches : [];
    pendingDeletedMovieIds = [];
    moviesRevision = 0;
    saveChain = Promise.resolve();

    activeFilters.status = '';
    activeFilters.genre = '';
    activeFilters.tag = '';
    activeFilters.search = '';
    activeFilters.release = 'all';

    await window.MovieDisplay?.localizeTitles?.(movies);
    renderMovies();
    window.refreshContinueWatching?.();
    return;
  }

  const response = await fetch('/api/movies', {
    cache: 'no-store',
    headers: window.authHeaders()
  });
  if (!response.ok) throw new Error('Не удалось загрузить');
  const data = await response.json();
  const rawMovies = data.movies || [];
  const needsHistoryMigration = rawMovies.some(
    (m) => !m.addedAt || !Array.isArray(m.history) || m.history.length === 0
  );
  movies = rawMovies.map(normalizeMovie);
  nextId = data.nextId || 1;
  battleSessions = Array.isArray(data.battleSessions) ? data.battleSessions : [];
  battleMatches = Array.isArray(data.battleMatches) ? data.battleMatches : [];
  pendingDeletedMovieIds = [];
  moviesRevision = 0;
  saveChain = Promise.resolve();

  activeFilters.status = '';
  activeFilters.genre = '';
  activeFilters.tag = '';
  activeFilters.search = '';
  activeFilters.release = 'all';

  await window.MovieDisplay?.localizeTitles?.(movies);
  renderMovies();
  if (needsHistoryMigration) {
    const putRes = await fetch('/api/movies', {
      method: 'PUT',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...window.authHeaders() },
      body: JSON.stringify({ movies, nextId, battleSessions, battleMatches })
    });
    if (putRes.ok) {
      const saved = await putRes.json();
      if (Array.isArray(saved.movies)) {
        movies = saved.movies.map(normalizeMovie);
        nextId = saved.nextId || nextId;
        renderMovies();
      }
    }
  }
  if (!options.skipEnrich) enrichAllMovies();
  window.refreshContinueWatching?.();
}

function getMovies() {
  return movies.map((m) => ({ ...m }));
}

function setFilter(type, value) {
  activeFilters[type] = value;
  if (type === 'search') {
    try {
      if (value) sessionStorage.setItem(LIST_SEARCH_SESSION_KEY, value);
      else sessionStorage.removeItem(LIST_SEARCH_SESSION_KEY);
    } catch { /* ignore */ }
  }
  renderMovies();
}

function resetListFilters() {
  activeFilters.status = '';
  activeFilters.genre = '';
  activeFilters.tag = '';
  activeFilters.search = '';
  activeFilters.release = 'all';
  try { sessionStorage.removeItem(LIST_SEARCH_SESSION_KEY); } catch { /* ignore */ }
  syncFilterUI();
  renderMovies();
}

if (filterStatus) filterStatus.addEventListener('change', (e) => setFilter('status', e.target.value));
if (filterGenre) filterGenre.addEventListener('change', (e) => setFilter('genre', e.target.value));
if (filterTag) filterTag.addEventListener('change', (e) => setFilter('tag', e.target.value));
const resetFiltersBtn = document.getElementById('reset-filters-btn');
if (resetFiltersBtn) resetFiltersBtn.addEventListener('click', resetListFilters);
if (listSearch) {
  listSearch.addEventListener('input', (e) => setFilter('search', e.target.value.trim()));
}

document.querySelectorAll('.release-filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => setFilter('release', btn.dataset.release));
});

if (sortBy) {
  sortBy.addEventListener('change', (e) => {
    const value = VALID_SORTS.includes(e.target.value) ? e.target.value : 'added';
    localStorage.setItem(LIST_SORT_STORAGE_KEY, value);
    setFilter('sort', value);
  });
}

document.querySelectorAll('.media-tab').forEach((tab) => {
  tab.addEventListener('click', () => setMediaFilter(tab.dataset.media));
});

document.querySelectorAll('.list-view-btn').forEach((btn) => {
  btn.addEventListener('click', () => setListViewMode(btn.dataset.view));
});

document.addEventListener('click', closeAllMovieMenus);

updateListViewToggle();

async function init() {
  await loadMovies();
}

function setMediaFilter(type) {
  activeFilters.mediaType = type;
  renderMovies();
}

function getBattleSessions() {
  return battleSessions.map((s) => ({ ...s }));
}

async function saveBattleResults({ mode, genre, mediaType, results, matches }) {
  if (!results?.length) return { success: false, error: 'Пустой результат' };

  const now = new Date().toISOString();
  const sessionId = `battle_session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const resultIds = results.map((r) => r.movie.id);
  const resolvedMediaType = mediaType || (mode === 'series' ? 'tv' : 'movie');

  const winCounts = {};
  const lossCounts = {};

  (matches || []).forEach((m) => {
    if (m.skipped) return;
    const loserId = m.winnerId === m.leftId ? m.rightId : m.leftId;
    lossCounts[loserId] = (lossCounts[loserId] || 0) + 1;
    winCounts[m.winnerId] = (winCounts[m.winnerId] || 0) + 1;
  });

  movies.forEach((movie) => {
    const w = winCounts[movie.id] || 0;
    const l = lossCounts[movie.id] || 0;
    if (!w && !l) return;
    movie.battleWins = (movie.battleWins || 0) + w;
    movie.battleLosses = (movie.battleLosses || 0) + l;
    const resultItem = results.find((r) => r.movie.id === movie.id);
    if (resultItem?.score != null) {
      movie.battleScore = Math.round(resultItem.score);
    } else if (w > 0) {
      movie.battleScore = (movie.battleScore || 0) + w * 5;
    }
    movie.lastBattleAt = now;
  });

  (matches || []).forEach((m) => {
    battleMatches.push({
      id: `battle_match_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      mode,
      genre: genre || null,
      mediaType: resolvedMediaType,
      leftId: m.leftId,
      rightId: m.rightId,
      winnerId: m.winnerId,
      playedAt: now,
      skipped: m.skipped || false
    });
  });

  battleSessions.push({
    id: sessionId,
    mode,
    genre: genre || null,
    mediaType: resolvedMediaType,
    createdAt: now,
    result: resultIds
  });

  if (battleMatches.length > 500) battleMatches = battleMatches.slice(-500);
  if (battleSessions.length > 50) battleSessions = battleSessions.slice(-50);

  try {
    const ok = await saveMovies();
    if (!ok) return { success: false, error: 'Ошибка сохранения' };
    return { success: true };
  } catch (e) {
    return { success: false, error: 'Ошибка сохранения' };
  }
}

function isAuthenticated() {
  return typeof window.isLoggedIn === 'function' && window.isLoggedIn();
}

window.MovieApp = {
  init,
  isAuthenticated,
  getMovies,
  executeActions,
  addMovie,
  addMovies,
  addMovieInternal,
  findMovieById,
  findMovieByTitle,
  updateMovie,
  updateMovieNotes,
  enrichMovie,
  applyTmdbData,
  relinkMoviePoster,
  describeHistoryEntry,
  formatDateTime,
  historyEventLabels,
  statusLabels,
  setMediaFilter,
  setFilter,
  resetListFilters,
  saveMovies,
  renderMovies,
  saveBattleResults,
  getBattleSessions
};
