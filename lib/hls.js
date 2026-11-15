// HLS: fetch con reintentos, parseo de m3u8 y descarga paralela de segmentos.

import { ScgError, CanceledError, CODES } from './errors.js';

export const NET_DEFAULTS = Object.freeze({
  retries: 4,
  baseDelay: 1000,
  timeout: 30000,
});

const RETRIABLE_STATUS = new Set([408, 425, 429]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CanceledError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CanceledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Backoff exponencial con jitter: base * 2^intento + [0, base).
export function backoffDelay(attempt, baseDelay) {
  return baseDelay * 2 ** attempt + Math.random() * baseDelay;
}

// as: 'arrayBuffer' | 'text' | 'json'. El timeout cubre cabeceras y cuerpo.
export async function fetchWithRetry(url, options = {}) {
  const {
    signal,
    as = 'arrayBuffer',
    headers,
    retries = NET_DEFAULTS.retries,
    baseDelay = NET_DEFAULTS.baseDelay,
    timeout = NET_DEFAULTS.timeout,
  } = options;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new CanceledError();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers,
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!response.ok) {
        const retriable = response.status >= 500 || RETRIABLE_STATUS.has(response.status);
        throw new ScgError(CODES.HTTP, 'Request failed', {
          status: response.status,
          fatal: !retriable,
        });
      }
      const body = await response[as]();
      return body;
    } catch (error) {
      if (signal?.aborted) throw new CanceledError();
      if (error instanceof ScgError) {
        if (error.fatal) throw error;
        lastError = error;
      } else if (timedOut) {
        lastError = new ScgError(CODES.TIMEOUT, 'Request timed out', { cause: error });
      } else if (error instanceof SyntaxError) {
        throw new ScgError(CODES.HTTP, 'Unexpected response', { fatal: true, cause: error });
      } else {
        lastError = new ScgError(CODES.NETWORK, 'Network error', { cause: error });
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (attempt < retries) await sleep(backoffDelay(attempt, baseDelay), signal);
  }
  throw lastError;
}

function parseAttributes(text) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    attrs[match[1]] = match[3] !== undefined ? match[3] : match[2];
  }
  return attrs;
}

function parseByteRange(value, previousEnd) {
  const [lengthText, offsetText] = String(value).split('@');
  const length = Number(lengthText);
  const offset = offsetText !== undefined ? Number(offsetText) : previousEnd;
  if (!Number.isFinite(length) || !Number.isFinite(offset)) return null;
  return { offset, length };
}

// Devuelve { type: 'master', variants } o { type: 'media', map, segments, encrypted }.
export function parsePlaylist(text, baseUrl) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[0] !== '#EXTM3U') {
    throw new ScgError(CODES.PLAYLIST_PARSE, 'Not an HLS playlist', { fatal: true });
  }
  const resolve = (uri) => new URL(uri, baseUrl).href;

  const variants = [];
  const segments = [];
  let map = null;
  let encrypted = false;
  let pendingVariant = null;
  let pendingRange = null;
  let lastRangeEnd = 0;
  let sawExtinf = false;

  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariant = parseAttributes(line.slice(18));
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice(11));
      if (attrs.METHOD && attrs.METHOD !== 'NONE') encrypted = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice(11));
      if (attrs.URI) {
        map = {
          url: resolve(attrs.URI),
          range: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, 0) : null,
        };
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice(17), lastRangeEnd);
    } else if (line.startsWith('#EXTINF:')) {
      sawExtinf = true;
    } else if (!line.startsWith('#')) {
      if (pendingVariant) {
        variants.push({
          url: resolve(line),
          bandwidth: Number(pendingVariant.BANDWIDTH) || 0,
          codecs: pendingVariant.CODECS || '',
        });
        pendingVariant = null;
      } else {
        segments.push({ url: resolve(line), range: pendingRange });
        if (pendingRange) lastRangeEnd = pendingRange.offset + pendingRange.length;
        pendingRange = null;
      }
    }
  }

  if (variants.length && !sawExtinf) return { type: 'master', variants };
  if (!segments.length) {
    throw new ScgError(CODES.PLAYLIST_PARSE, 'Playlist has no segments', { fatal: true });
  }
  return { type: 'media', map, segments, encrypted };
}

// Descarga el m3u8 y, si es un master, baja a la variante de mayor bitrate.
export async function fetchMediaPlaylist(url, options = {}) {
  let current = url;
  for (let depth = 0; depth < 3; depth += 1) {
    const text = await fetchWithRetry(current, { ...options, as: 'text' });
    const parsed = parsePlaylist(text, current);
    if (parsed.type === 'media') {
      if (parsed.encrypted) {
        throw new ScgError(CODES.DRM, 'Encrypted stream', { fatal: true });
      }
      return parsed;
    }
    const best = [...parsed.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
    current = best.url;
  }
  throw new ScgError(CODES.PLAYLIST_PARSE, 'Too many nested playlists', { fatal: true });
}

function rangeHeaders(range) {
  if (!range) return undefined;
  return { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` };
}

// Descarga init (EXT-X-MAP) + segmentos en paralelo y los concatena en orden.
export async function downloadSegments(playlist, options = {}) {
  const { signal, onProgress, concurrency = 8 } = options;
  const parts = playlist.map ? [playlist.map, ...playlist.segments] : [...playlist.segments];
  const total = parts.length;
  const buffers = new Array(total);
  const group = new AbortController();
  const onAbort = () => group.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let next = 0;
  let done = 0;
  let failure = null;
  onProgress?.(0, total);

  const worker = async () => {
    while (!failure) {
      const index = next;
      next += 1;
      if (index >= total) return;
      try {
        const buffer = await fetchWithRetry(parts[index].url, {
          signal: group.signal,
          headers: rangeHeaders(parts[index].range),
          retries: options.retries,
          baseDelay: options.baseDelay,
          timeout: options.timeout,
        });
        buffers[index] = new Uint8Array(buffer);
        done += 1;
        onProgress?.(done, total);
      } catch (error) {
        if (!failure) failure = error;
        group.abort();
        return;
      }
    }
  };

  const size = Math.max(1, Math.min(Number(concurrency) || 1, 16, total));
  try {
    await Promise.all(Array.from({ length: size }, worker));
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw new CanceledError();
  if (failure) throw failure;

  return concatBytes(buffers);
}

export function concatBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// 'mp4' (fMP4: SoundCloud AAC actual), 'ts', 'mp3', 'adts' o 'bin'.
export function sniffContainer(bytes) {
  if (!bytes || bytes.byteLength < 12) return 'bin';
  const tag = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (['ftyp', 'styp', 'moov', 'moof', 'sidx'].includes(tag)) return 'mp4';
  if (bytes[0] === 0x47 && (bytes.byteLength < 189 || bytes[188] === 0x47)) return 'ts';
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'mp3';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return (bytes[1] & 0x06) === 0 ? 'adts' : 'mp3';
  }
  return 'bin';
}

export function sniffImage(bytes) {
  if (!bytes || bytes.byteLength < 8) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}
