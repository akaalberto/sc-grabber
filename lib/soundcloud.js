// Cliente mínimo de api-v2.soundcloud.com (no pública): client_id, resolve,
// pistas por id, URL de stream y selección de transcoding.

import { ScgError, CODES } from './errors.js';
import { fetchWithRetry } from './hls.js';

const API = 'https://api-v2.soundcloud.com';
const HOME = 'https://soundcloud.com/';
const ID_RE = /^[0-9A-Za-z]{32}$/;

export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^(www|m)\./, '')}${parsed.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch (error) {
    return '';
  }
}

export function isSoundCloudUrl(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && /(^|\.)soundcloud\.com$/.test(parsed.hostname);
  } catch (error) {
    return false;
  }
}

export class SoundCloud {
  // options: { cachedId, override, onNewId(id) }
  constructor(options = {}) {
    this.cachedId = ID_RE.test(options.cachedId || '') ? options.cachedId : null;
    this.override = null;
    this.onNewId = options.onNewId || (() => {});
    this.setOverride(options.override);
    this.scraping = null;
  }

  setOverride(value) {
    const id = String(value || '').trim();
    this.override = ID_RE.test(id) ? id : null;
  }

  // Un client_id visto en la hydration de la página es el más fresco posible.
  offerId(id) {
    if (ID_RE.test(id || '') && id !== this.cachedId) {
      this.cachedId = id;
      this.onNewId(id);
    }
  }

  forgetId() {
    this.cachedId = null;
  }

  async clientId(signal) {
    if (this.override) return this.override;
    if (this.cachedId) return this.cachedId;
    return this.refreshId(signal, null);
  }

  refreshId(signal, rejected) {
    if (!this.scraping) {
      this.scraping = this.scrapeId(signal, rejected).finally(() => {
        this.scraping = null;
      });
    }
    return this.scraping;
  }

  // Igual que un scraper: hydration de la home y, si no, los bundles JS.
  async scrapeId(signal, rejected) {
    const html = await fetchWithRetry(HOME, { signal, as: 'text', retries: 2 });
    const candidates = [];

    const hydration = html.match(/"hydratable"\s*:\s*"apiClient"\s*,\s*"data"\s*:\s*\{\s*"id"\s*:\s*"([0-9A-Za-z]{32})"/);
    if (hydration) candidates.push(hydration[1]);

    if (!candidates.length || candidates[0] === rejected) {
      const bundles = [...html.matchAll(/<script[^>]+src="(https:\/\/[^"]*sndcdn\.com\/[^"]+\.js)"/g)]
        .map((match) => match[1])
        .reverse();
      for (const bundle of bundles) {
        let source = '';
        try {
          source = await fetchWithRetry(bundle, { signal, as: 'text', retries: 1 });
        } catch (error) {
          if (signal?.aborted) throw error;
          continue;
        }
        const found = source.match(/[{,]client_id:"([0-9A-Za-z]{32})"/) || source.match(/client_id=([0-9A-Za-z]{32})/);
        if (found) {
          candidates.push(found[1]);
          break;
        }
      }
    }

    const id = candidates.find((candidate) => candidate !== rejected);
    if (!id) throw new ScgError(CODES.CLIENT_ID, 'Could not obtain a client_id', { fatal: true });
    this.cachedId = id;
    this.onNewId(id);
    return id;
  }

  // GET JSON con client_id; si la API lo rechaza (401/403) se renueva una vez.
  async apiGet(urlOrPath, params = {}, signal) {
    const request = async (id) => {
      const url = new URL(urlOrPath.startsWith('http') ? urlOrPath : `${API}${urlOrPath}`);
      for (const [key, value] of Object.entries(params)) {
        if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, value);
      }
      url.searchParams.set('client_id', id);
      return fetchWithRetry(url.href, { signal, as: 'json' });
    };

    const id = await this.clientId(signal);
    try {
      return await request(id);
    } catch (error) {
      const rejected = error instanceof ScgError && (error.status === 401 || error.status === 403);
      if (!rejected) throw error;
      if (this.override) {
        throw new ScgError(CODES.CLIENT_ID, 'The configured client_id was rejected', { status: error.status, fatal: true });
      }
      this.forgetId();
      const fresh = await this.refreshId(signal, id);
      try {
        return await request(fresh);
      } catch (second) {
        if (second instanceof ScgError && second.status === 401) {
          throw new ScgError(CODES.CLIENT_ID, 'client_id rejected', { status: 401, fatal: true });
        }
        throw second;
      }
    }
  }

  async resolve(url, signal) {
    if (!isSoundCloudUrl(url)) {
      throw new ScgError(CODES.UNSUPPORTED_URL, 'Not a SoundCloud URL', { fatal: true });
    }
    try {
      return await this.apiGet('/resolve', { url }, signal);
    } catch (error) {
      if (error instanceof ScgError && error.status === 404) {
        throw new ScgError(CODES.NOT_FOUND, 'Track or playlist not found', { status: 404, fatal: true });
      }
      throw error;
    }
  }

  async tracksByIds(ids, signal) {
    const byId = new Map();
    for (let offset = 0; offset < ids.length; offset += 50) {
      const chunk = ids.slice(offset, offset + 50);
      const list = await this.apiGet('/tracks', { ids: chunk.join(',') }, signal);
      for (const track of Array.isArray(list) ? list : []) byId.set(track.id, track);
    }
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  // Las playlists traen completas solo las primeras pistas; el resto son stubs con id.
  async playlistTracks(playlist, signal) {
    const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    const stubs = tracks.filter((track) => !track.media || !track.title).map((track) => track.id);
    if (!stubs.length) return tracks;
    const full = await this.tracksByIds(stubs, signal);
    const byId = new Map(full.map((track) => [track.id, track]));
    return tracks.map((track) => (track.media && track.title ? track : byId.get(track.id))).filter(Boolean);
  }

  async streamUrl(transcoding, track, signal) {
    const data = await this.apiGet(transcoding.url, { track_authorization: track.track_authorization }, signal);
    if (!data || typeof data.url !== 'string') {
      throw new ScgError(CODES.NO_STREAM, 'Stream URL missing in response');
    }
    return data.url;
  }
}

function bitrateOf(transcoding) {
  const match = /(\d+)k/.exec(transcoding.preset || '');
  if (match) return Number(match[1]);
  return transcoding.quality === 'hq' ? 256 : 128;
}

function mimeOf(transcoding) {
  return String(transcoding.format?.mime_type || '').toLowerCase();
}

// Orden estricto: a) AAC por HLS  b) MP3 progresivo  c) MP3 por HLS.
// quality: 'best' | 'standard' (<=160k) | 'low' (el AAC más ligero).
// Devuelve [{ transcoding, codec: 'aac'|'mp3', protocol }].
export function pickTranscodings(track, quality = 'best') {
  const all = Array.isArray(track?.media?.transcodings) ? track.media.transcodings : [];
  const isMp3 = (t) => /^audio\/mpeg(\s*;|$)/.test(mimeOf(t));

  let aac = all.filter((t) => /aac/i.test(t.preset || '') && t.format?.protocol === 'hls');
  aac.sort((a, b) => bitrateOf(b) - bitrateOf(a));
  if (quality === 'low') aac.reverse();
  if (quality === 'standard') {
    aac = [...aac.filter((t) => bitrateOf(t) <= 160), ...aac.filter((t) => bitrateOf(t) > 160)];
  }

  const progressive = all.filter((t) => t.format?.protocol === 'progressive' && isMp3(t));
  const hlsMp3 = all.filter((t) => t.format?.protocol === 'hls' && isMp3(t));

  return [
    ...aac.map((transcoding) => ({ transcoding, codec: 'aac', protocol: 'hls' })),
    ...progressive.map((transcoding) => ({ transcoding, codec: 'mp3', protocol: 'progressive' })),
    ...hlsMp3.map((transcoding) => ({ transcoding, codec: 'mp3', protocol: 'hls' })),
  ];
}

export function hasOnlyEncrypted(track) {
  const all = Array.isArray(track?.media?.transcodings) ? track.media.transcodings : [];
  return all.length > 0 && all.every((t) => /encrypted/i.test(t.format?.protocol || '') || /mpegurl/.test(mimeOf(t)));
}

export function isPreview(track, transcoding) {
  return Boolean(transcoding?.snipped) || track?.policy === 'SNIP';
}

// -original primero; t500x500 y la propia URL como respaldo.
export function artworkCandidates(track) {
  const base = track?.artwork_url || track?.user?.avatar_url || '';
  if (!base) return [];
  const list = [base.replace('-large.', '-original.'), base.replace('-large.', '-t500x500.'), base];
  return [...new Set(list)];
}

export function trackMeta(track, extra = {}) {
  const created = track.release_date || track.created_at || track.display_date || '';
  const year = /^\d{4}/.test(created) ? created.slice(0, 4) : '';
  return {
    id: track.id,
    title: track.title || `track ${track.id}`,
    artist: track.user?.username || track.publisher_metadata?.artist || '',
    album: extra.album || track.publisher_metadata?.album_title || '',
    genre: track.genre || '',
    year,
    date: created ? created.slice(0, 10) : '',
    index: extra.index ? String(extra.index).padStart(2, '0') : '',
    url: track.permalink_url || extra.url || '',
  };
}
