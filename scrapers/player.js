/* ===================================================================
   scrapers/player.js — нативный плеер HDRezka (без iframe).

   Фильмы: action=get_movie, потоки из initCDNMoviesEvents или AJAX.
   Сериалы: action=get_episodes (список сезонов/серий) + action=get_stream
   (поток выбранной серии). Прямые .mp4 — обычный <video>.
   =================================================================== */
import {
  buildDefaultHeaders,
  ensureHdrezkaBase,
  fetchHdrezkaHtml,
  resolveHdrezkaMovie
} from '../hdrezka.js';
import { invalidateMirror, rewriteMirrorUrl } from '../rezkaMirrors.js';

const PAGE_META_TTL_MS = 6 * 60 * 60 * 1000;
const STREAM_TTL_MS = 30 * 60 * 1000;
const EPISODE_TTL_MS = 6 * 60 * 60 * 1000;
const AJAX_TIMEOUT_MS = Number(process.env.HDREZKA_TIMEOUT_MS) || 5000;

const pageMetaCache = new Map();
const streamCache = new Map();
const episodeCache = new Map();

function cacheGet(cache, key, ttl) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.at < ttl) return entry.data;
  return undefined;
}

function cacheSet(cache, key, data) {
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
}

function unescapeSlashes(text) {
  return String(text || '').replace(/\\\//g, '/').replace(/\\"/g, '"');
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function qualityWeight(label) {
  const num = Number(String(label).match(/(\d{3,4})/)?.[1] || 0);
  return /4k|2160/i.test(label) ? 2160 : num;
}

function parseQualities(streamsRaw) {
  const streams = unescapeSlashes(streamsRaw);
  if (!streams) return [];

  const out = [];
  const seen = new Set();
  const re = /\[([^\]]+)\]\s*([^[]+?)(?=,\[|$)/g;
  let m;
  while ((m = re.exec(streams)) !== null) {
    const label = stripTags(m[1]) || m[1].trim();
    let value = m[2].trim().replace(/,+$/, '');
    if (!value) continue;

    const parts = value.split(/\s+or\s+/);
    let url = (parts[parts.length - 1] || '').trim();
    url = url.replace(/:hls:manifest\.m3u8$/i, '');
    if (!/^https?:\/\//i.test(url) || seen.has(label)) continue;

    seen.add(label);
    out.push({ label, url });
  }

  out.sort((a, b) => qualityWeight(b.label) - qualityWeight(a.label));
  return out;
}

function parseVoices(html) {
  // HDRezka: раньше <li class="b-translator__item">, сейчас часто <a class="b-translator__item">
  const items = html.match(/<(?:li|a)[^>]*class="[^"]*b-translator__item[^"]*"[^>]*>[\s\S]*?<\/(?:li|a)>/gi) || [];
  const voices = [];
  for (const li of items) {
    const id = li.match(/data-translator_id="(\d+)"/i)?.[1];
    if (!id) continue;
    voices.push({
      id,
      name: stripTags(li.replace(/<img[^>]*>/gi, '')) || `Озвучка ${id}`,
      active: /\bactive\b/.test(li.match(/class="([^"]*)"/i)?.[1] || ''),
      camrip: li.match(/data-camrip="(\d+)"/i)?.[1] || '0',
      ads: li.match(/data-ads="(\d+)"/i)?.[1] || '0',
      director: li.match(/data-director="(\d+)"/i)?.[1] || '0'
    });
  }
  return voices;
}

function parseCdnCall(html) {
  const call = html.match(/initCDN(?:Movies|Series)Events\(([\s\S]*?)\);/i)?.[1] || '';
  const filmId = call.match(/^\s*(\d+)/)?.[1] || null;
  const defaultTranslator = call.split(',')[1]?.trim() || null;
  const streams = call.match(/"streams":"((?:[^"\\]|\\.)*)"/)?.[1] || '';
  const isSeries = /initCDNSeriesEvents/i.test(html);
  return { filmId, defaultTranslator, streams, isSeries };
}

function parseSeasonTabs(html) {
  const tabs = [];
  const items = html.match(/<[^>]*class="[^"]*b-simple_season__item[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi) || [];
  for (const item of items) {
    const id = item.match(/data-tab_id="(\d+)"/i)?.[1];
    if (!id) continue;
    tabs.push({ id: Number(id), label: stripTags(item) || String(id) });
  }
  return tabs;
}

function parseEpisodesFromHtml(episodesHtml, seasonTabs = []) {
  const seasonMap = new Map();
  const tabLabels = new Map(seasonTabs.map((t) => [t.id, t.label]));
  const items = episodesHtml.match(/<li[^>]*class="[^"]*b-simple_episode__item[^"]*"[^>]*>[\s\S]*?<\/li>/gi) || [];

  for (const li of items) {
    const seasonId = Number(li.match(/data-season_id="(\d+)"/i)?.[1] || 0);
    const episodeId = Number(li.match(/data-episode_id="(\d+)"/i)?.[1] || 0);
    if (!seasonId || !episodeId) continue;
    if (!seasonMap.has(seasonId)) {
      seasonMap.set(seasonId, {
        id: seasonId,
        label: tabLabels.get(seasonId) || String(seasonId),
        episodes: []
      });
    }
    seasonMap.get(seasonId).episodes.push({
      id: episodeId,
      label: stripTags(li) || String(episodeId)
    });
  }

  const seasons = [...seasonMap.values()]
    .sort((a, b) => a.id - b.id)
    .map((s) => ({
      ...s,
      episodes: s.episodes.sort((a, b) => a.id - b.id)
    }));

  return seasons;
}

function parseSubtitles(subtitleField) {
  if (!subtitleField || subtitleField === 'false' || subtitleField === 'null') return [];
  const raw = typeof subtitleField === 'string' ? subtitleField : '';
  if (!raw.trim()) return [];
  const out = [];
  const re = /\[([^\]]+)\](https?:\/\/[^\s,\]]+)/g;
  let m;
  while ((m = re.exec(unescapeSlashes(raw))) !== null) {
    out.push({ lang: stripTags(m[1]) || m[1], url: m[2] });
  }
  return out;
}

async function postCdnAjax(body, pageUrl, allowRetry = true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AJAX_TIMEOUT_MS);
  let base;
  try {
    base = await ensureHdrezkaBase();
    const referer = rewriteMirrorUrl(pageUrl, base) || `${base}/`;
    const res = await fetch(`${base}/ajax/get_cdn_series/?t=${Date.now()}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        ...buildDefaultHeaders(base),
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: referer
      },
      body: body.toString()
    });
    if (!res.ok) {
      if (allowRetry) {
        clearTimeout(timer);
        await invalidateMirror();
        return postCdnAjax(body, pageUrl, false);
      }
      return null;
    }
    return await res.json().catch(() => null);
  } catch {
    if (allowRetry) {
      clearTimeout(timer);
      await invalidateMirror();
      return postCdnAjax(body, pageUrl, false);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEpisodes(filmId, voice, pageUrl, seasonTabs = []) {
  const key = `${filmId}:${voice.id}`;
  const cached = cacheGet(episodeCache, key, EPISODE_TTL_MS);
  if (cached !== undefined) return cached;

  const body = new URLSearchParams({
    id: filmId,
    translator_id: voice.id,
    action: 'get_episodes'
  });
  const json = await postCdnAjax(body, pageUrl);
  const seasons = json?.success && json?.episodes
    ? parseEpisodesFromHtml(json.episodes, seasonTabs)
    : [];

  cacheSet(episodeCache, key, seasons);
  return seasons;
}

async function fetchMovieStreams(filmId, voice, pageUrl) {
  const body = new URLSearchParams({
    id: filmId,
    translator_id: voice.id,
    is_camrip: voice.camrip || '0',
    is_ads: voice.ads || '0',
    is_director: voice.director || '0',
    action: 'get_movie'
  });
  const json = await postCdnAjax(body, pageUrl);
  return { streams: json?.url || '', subtitles: parseSubtitles(json?.subtitle) };
}

async function fetchSeriesStream(filmId, voice, pageUrl, season, episode) {
  const body = new URLSearchParams({
    id: filmId,
    translator_id: voice.id,
    season: String(season),
    episode: String(episode),
    action: 'get_stream'
  });
  const json = await postCdnAjax(body, pageUrl);
  return { streams: json?.url || '', subtitles: parseSubtitles(json?.subtitle) };
}

function pickVoice(voices, translatorId, defaultTranslator) {
  return voices.find((v) => String(v.id) === String(translatorId))
    || voices.find((v) => String(v.id) === String(defaultTranslator))
    || voices[0]
    || { id: translatorId || defaultTranslator, camrip: '0', ads: '0', director: '0', name: '' };
}

function pickSeasonEpisode(seasons, seasonId, episodeId) {
  if (!seasons.length) return { season: null, episode: null };
  const season = seasons.find((s) => s.id === Number(seasonId)) || seasons[0];
  const episode = season.episodes.find((e) => e.id === Number(episodeId)) || season.episodes[0];
  return { season: season.id, episode: episode?.id || null };
}

async function resolvePageMeta(tmdbId, type, title, year, originalTitle) {
  const key = `${type}:${tmdbId}`;
  const cached = cacheGet(pageMetaCache, key, PAGE_META_TTL_MS);
  if (cached !== undefined) return cached;

  let meta = null;
  try {
    await ensureHdrezkaBase();
    const resolved = await resolveHdrezkaMovie({
      title,
      year,
      matchedTitle: title,
      originalTitle
    });
    const pageUrl = resolved?.hdrezkaUrl || resolved?.url || null;
    if (pageUrl) {
      const html = await fetchHdrezkaHtml(pageUrl, { headers: { 'X-Requested-With': undefined } });
      if (html) {
        const cdn = parseCdnCall(html);
        meta = {
          pageUrl,
          filmId: cdn.filmId,
          defaultTranslator: cdn.defaultTranslator,
          defaultStreams: cdn.streams,
          voices: parseVoices(html),
          seasonTabs: parseSeasonTabs(html),
          isSeries: cdn.isSeries || type === 'tv',
          title: resolved?.title || title
        };
      }
    }
  } catch {
    meta = null;
  }

  cacheSet(pageMetaCache, key, meta);
  return meta;
}

/**
 * getPlayer — данные нативного плеера HDRezka.
 * @param {number|string|null} season — номер сезона (сериалы)
 * @param {number|string|null} episode — номер серии (сериалы)
 */
export async function getPlayer(
  tmdbId,
  type = 'movie',
  title = '',
  year = null,
  originalTitle = null,
  translatorId = null,
  season = null,
  episode = null
) {
  const meta = await resolvePageMeta(tmdbId, type, title, year, originalTitle);
  if (!meta || !meta.filmId) return null;

  const activeVoiceId = translatorId || meta.defaultTranslator || null;
  const voice = pickVoice(meta.voices, activeVoiceId, meta.defaultTranslator);
  let isSeries = meta.isSeries && type === 'tv';

  let seasons = [];
  let activeSeason = null;
  let activeEpisode = null;
  let subtitles = [];

  if (isSeries) {
    seasons = await fetchEpisodes(meta.filmId, voice, meta.pageUrl, meta.seasonTabs);
    if (!seasons.length) isSeries = false;
  }

  if (isSeries) {
    const picked = pickSeasonEpisode(seasons, season, episode);
    activeSeason = picked.season;
    activeEpisode = picked.episode;
    if (!activeSeason || !activeEpisode) return null;
  }

  const streamKey = isSeries
    ? `${type}:${tmdbId}:${voice.id}:${activeSeason}:${activeEpisode}`
    : `${type}:${tmdbId}:${voice.id}`;
  let qualities = cacheGet(streamCache, streamKey, STREAM_TTL_MS);

  if (!qualities) {
    let streamsRaw = '';
    if (isSeries) {
      const streamData = await fetchSeriesStream(meta.filmId, voice, meta.pageUrl, activeSeason, activeEpisode);
      streamsRaw = streamData.streams;
      subtitles = streamData.subtitles;
    } else if (!translatorId || String(translatorId) === String(meta.defaultTranslator)) {
      streamsRaw = meta.defaultStreams;
    } else {
      const streamData = await fetchMovieStreams(meta.filmId, voice, meta.pageUrl);
      streamsRaw = streamData.streams;
      subtitles = streamData.subtitles;
    }
    qualities = parseQualities(streamsRaw);
    if (qualities.length) cacheSet(streamCache, streamKey, qualities);
  }

  if (!qualities.length) return null;

  return {
    title: meta.title,
    isSeries,
    voices: meta.voices.map((v) => ({ id: v.id, name: v.name })),
    activeVoice: voice.id,
    qualities,
    seasons: seasons.map((s) => ({
      id: s.id,
      label: s.label,
      episodes: s.episodes.map((e) => ({ id: e.id, label: e.label }))
    })),
    activeSeason,
    activeEpisode,
    subtitles
  };
}
