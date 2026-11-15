// Offscreen document: dueño de la cola, de las descargas de segmentos y de ffmpeg.wasm.
// Solo dispone de chrome.runtime: el almacenamiento y chrome.downloads los hace el
// service worker, al que habla por RPC (sendMessage) y por un puerto persistente.

import { TARGET, CMD, PUSH, RPC, PORT, PORT_NAME, STATUS, isActive } from './lib/messages.js';
import { ScgError, CanceledError, CODES, toErrorInfo, isCanceled } from './lib/errors.js';
import { formatName, joinPath } from './lib/naming.js';
import { fetchMediaPlaylist, downloadSegments, fetchWithRetry, sniffContainer } from './lib/hls.js';
import { mux, isFfmpegUnavailable, disposeMux } from './lib/mux.js';
import {
  SoundCloud,
  pickTranscodings,
  hasOnlyEncrypted,
  isPreview,
  artworkCandidates,
  trackMeta,
  normalizeUrl,
  isSoundCloudUrl,
} from './lib/soundcloud.js';
import { normalizeSettings } from './lib/settings.js';

const TRACK_CONCURRENCY = 2;
const SNAPSHOT_INTERVAL_MS = 300;
const PING_INTERVAL_MS = 20000;

let settings = normalizeSettings(null);
let soundcloud = new SoundCloud();
const items = []; // elementos ligeros y serializables (lo que se persiste)
const trackData = new Map(); // id de item -> objeto track completo (solo en memoria)
const controllers = new Map(); // id de item -> AbortController
const pendingSaves = new Map(); // id de item -> { resolve, reject, blobUrl }
let running = 0;

// ---------------------------------------------------------------- canal con el SW

let port = null;
let snapshotTimer = null;
let pingTimer = null;
let idleTimer = null;
const MUX_IDLE_MS = 60000;

function connectPort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: PORT_NAME });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null;
    // El service worker murió o se reinició. Si hay trabajo, se reconecta (y lo despierta).
    if (items.some((item) => isActive(item.status))) {
      setTimeout(() => {
        connectPort();
        sendSnapshot();
      }, 250);
    }
  });
  return port;
}

function postToWorker(message) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      connectPort().postMessage(message);
      return;
    } catch (error) {
      port = null;
    }
  }
}

function sendSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = null;
  postToWorker({ type: PORT.SNAPSHOT, queue: items });
  updateKeepAlive();
}

// immediate = cambios de estado; el progreso se agrupa cada SNAPSHOT_INTERVAL_MS.
function emit(immediate = false) {
  if (immediate) {
    sendSnapshot();
  } else if (!snapshotTimer) {
    snapshotTimer = setTimeout(sendSnapshot, SNAPSHOT_INTERVAL_MS);
  }
}

function updateKeepAlive() {
  const busy = items.some((item) => isActive(item.status));
  // Con la cola vacía un minuto se libera la instancia de ffmpeg (memoria wasm).
  clearTimeout(idleTimer);
  idleTimer = busy ? null : setTimeout(disposeMux, MUX_IDLE_MS);
  if (busy && !pingTimer) {
    pingTimer = setInterval(() => postToWorker({ type: PORT.PING }), PING_INTERVAL_MS);
  } else if (!busy && pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

async function rpc(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target: TARGET.BACKGROUND, type, ...payload });
  if (!response || response.ok === false) {
    const info = response?.error;
    throw new ScgError(info?.code || CODES.UNKNOWN, info?.message || 'Service worker did not answer');
  }
  return response;
}

// ---------------------------------------------------------------- cola

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function findItem(id) {
  return items.find((item) => item.id === id);
}

function makeItem(fields) {
  return {
    id: newId(),
    url: '',
    title: '',
    artist: '',
    artwork: '',
    album: '',
    index: 0,
    quality: settings.quality,
    status: STATUS.QUEUED,
    segDone: 0,
    segTotal: 0,
    error: null,
    warning: null,
    filename: '',
    addedAt: Date.now(),
    ...fields,
  };
}

function isDuplicate(url) {
  const key = normalizeUrl(url);
  return items.some((item) => isActive(item.status) && normalizeUrl(item.url) === key);
}

function addTrack(track, extra = {}) {
  const url = track.permalink_url || extra.url || '';
  if (url && isDuplicate(url)) return null;
  const item = makeItem({
    url,
    title: track.title || url,
    artist: track.user?.username || '',
    artwork: track.artwork_url || track.user?.avatar_url || '',
    album: extra.album || '',
    index: extra.index || 0,
    quality: extra.quality || settings.quality,
  });
  trackData.set(item.id, track);
  items.push(item);
  return item;
}

function setError(item, error) {
  if (isCanceled(error)) {
    item.status = STATUS.CANCELED;
    item.error = null;
  } else {
    item.status = STATUS.ERROR;
    item.error = toErrorInfo(error);
  }
}

// Expande una playlist (o una URL sin resolver) sustituyendo el marcador de posición.
async function expandPlaceholder(placeholder, playlistHint, quality) {
  const controller = new AbortController();
  controllers.set(placeholder.id, controller);
  try {
    let resource = playlistHint || (await soundcloud.resolve(placeholder.url, controller.signal));
    if (resource.kind === 'track') {
      const position = items.indexOf(placeholder);
      if (position >= 0) items.splice(position, 1);
      addTrack(resource, { url: placeholder.url, quality });
    } else if (resource.kind === 'playlist' || resource.kind === 'system-playlist') {
      placeholder.title = resource.title || placeholder.title;
      emit(true);
      const tracks = await soundcloud.playlistTracks(resource, controller.signal);
      if (controller.signal.aborted) throw new CanceledError();
      const position = items.indexOf(placeholder);
      if (position >= 0) items.splice(position, 1);
      if (!tracks.length) throw new ScgError(CODES.NOT_FOUND, 'Playlist is empty', { fatal: true });
      tracks.forEach((track, offset) => {
        addTrack(track, { album: resource.title || '', index: offset + 1, quality });
      });
    } else {
      throw new ScgError(CODES.UNSUPPORTED_URL, 'URL is not a track or playlist', { fatal: true });
    }
  } catch (error) {
    const canceled = isCanceled(error) || controller.signal.aborted;
    if (!canceled && !items.includes(placeholder)) items.push(placeholder);
    setError(placeholder, canceled ? new CanceledError() : error);
  } finally {
    controllers.delete(placeholder.id);
    emit(true);
    pump();
  }
}

function enqueue(message) {
  const { url, hint = {}, quality } = message;
  if (hint.clientId) soundcloud.offerId(hint.clientId);
  if (!hint.track && !hint.playlist && !isSoundCloudUrl(url)) {
    throw new ScgError(CODES.UNSUPPORTED_URL, 'Not a SoundCloud URL', { fatal: true });
  }

  if (hint.track && hint.track.kind === 'track' && hint.track.media) {
    const item = addTrack(hint.track, { url, quality });
    emit(true);
    pump();
    return { added: item ? 1 : 0, duplicate: !item };
  }

  if (isDuplicate(url)) return { added: 0, duplicate: true };
  const playlist = hint.playlist && Array.isArray(hint.playlist.tracks) ? hint.playlist : null;
  const placeholder = makeItem({
    url,
    title: playlist?.title || url,
    artist: playlist?.user?.username || '',
    artwork: playlist?.artwork_url || '',
    status: STATUS.RESOLVING,
    quality: quality || settings.quality,
  });
  items.push(placeholder);
  emit(true);
  expandPlaceholder(placeholder, playlist, quality);
  return { added: 1, duplicate: false };
}

function pump() {
  while (running < TRACK_CONCURRENCY) {
    const item = items.find((entry) => entry.status === STATUS.QUEUED && !controllers.has(entry.id));
    if (!item) break;
    running += 1;
    processItem(item).finally(() => {
      running -= 1;
      emit(true);
      pump();
    });
  }
}

// ---------------------------------------------------------------- pipeline por pista

function setStatus(item, status) {
  item.status = status;
  emit(true);
}

async function fetchCover(track, signal) {
  for (const url of artworkCandidates(track)) {
    try {
      const buffer = await fetchWithRetry(url, { signal, retries: 1, timeout: 20000 });
      if (buffer.byteLength > 0) return new Uint8Array(buffer);
    } catch (error) {
      if (signal.aborted) throw new CanceledError();
    }
  }
  return null;
}

async function fetchAudio(candidate, track, item, signal) {
  const streamUrl = await soundcloud.streamUrl(candidate.transcoding, track, signal);
  if (candidate.protocol === 'progressive') {
    item.segDone = 0;
    item.segTotal = 1;
    emit();
    const buffer = await fetchWithRetry(streamUrl, { signal, timeout: 120000 });
    item.segDone = 1;
    emit();
    return new Uint8Array(buffer);
  }
  const playlist = await fetchMediaPlaylist(streamUrl, { signal });
  return downloadSegments(playlist, {
    signal,
    concurrency: settings.concurrency,
    onProgress: (done, total) => {
      item.segDone = done;
      item.segTotal = total;
      emit();
    },
  });
}

// Prueba los candidatos en orden hasta que uno entregue audio.
async function downloadFirstAvailable(candidates, track, item, signal) {
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const data = await fetchAudio(candidate, track, item, signal);
      return { data, candidate };
    } catch (error) {
      if (isCanceled(error) || signal.aborted) throw new CanceledError();
      if (error instanceof ScgError && error.code === CODES.CLIENT_ID) throw error;
      lastError = error;
    }
  }
  throw lastError || new ScgError(CODES.NO_STREAM, 'No downloadable stream');
}

// Sin ffmpeg: mp3 progresivo directo; si no existe, el audio tal cual llegó.
async function fallbackWithoutFfmpeg({ candidates, track, item, signal, downloaded }) {
  const progressive = candidates.find((candidate) => candidate.protocol === 'progressive');
  if (progressive && downloaded.candidate !== progressive) {
    try {
      const data = await fetchAudio(progressive, track, item, signal);
      return { blob: new Blob([data], { type: 'audio/mpeg' }), ext: 'mp3', warning: 'mp3' };
    } catch (error) {
      if (isCanceled(error) || signal.aborted) throw new CanceledError();
    }
  }
  const container = sniffContainer(downloaded.data);
  if (container === 'mp3') {
    return { blob: new Blob([downloaded.data], { type: 'audio/mpeg' }), ext: 'mp3', warning: 'mp3' };
  }
  if (container === 'mp4') {
    return { blob: new Blob([downloaded.data], { type: 'audio/mp4' }), ext: 'm4a', warning: 'raw' };
  }
  throw new ScgError(CODES.MUX_INIT, 'ffmpeg.wasm is unavailable and there is no direct fallback');
}

function waitForSave(item, blobUrl, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      pendingSaves.delete(item.id);
      URL.revokeObjectURL(blobUrl);
      reject(new CanceledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pendingSaves.set(item.id, {
      blobUrl,
      resolve: () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      reject: (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    });
  });
}

async function processItem(item) {
  const controller = new AbortController();
  const { signal } = controller;
  controllers.set(item.id, controller);
  item.error = null;
  item.warning = null;
  item.segDone = 0;
  item.segTotal = 0;

  try {
    setStatus(item, STATUS.RESOLVING);
    let track = trackData.get(item.id);
    if (!track) {
      track = await soundcloud.resolve(item.url, signal);
      if (track.kind !== 'track') {
        throw new ScgError(CODES.UNSUPPORTED_URL, 'URL is not a track', { fatal: true });
      }
      trackData.set(item.id, track);
      item.title = track.title || item.title;
      item.artist = track.user?.username || item.artist;
      item.artwork = track.artwork_url || item.artwork;
    }

    const meta = trackMeta(track, { album: item.album, index: item.index, url: item.url });
    const baseName = formatName(settings.pattern, meta, 'm4a');
    item.filename = baseName;

    if (settings.skipExisting) {
      const { exists } = await rpc(RPC.CHECK_EXISTING, { path: joinPath(settings.subfolder, baseName) });
      if (exists) {
        setStatus(item, STATUS.SKIPPED);
        return;
      }
    }

    const candidates = pickTranscodings(track, item.quality);
    if (!candidates.length) {
      throw hasOnlyEncrypted(track)
        ? new ScgError(CODES.DRM, 'Only DRM-protected streams are available', { fatal: true })
        : new ScgError(CODES.NO_STREAM, 'No downloadable stream', { fatal: true });
    }

    setStatus(item, STATUS.DOWNLOADING);
    let downloaded;
    try {
      downloaded = await downloadFirstAvailable(candidates, track, item, signal);
    } catch (error) {
      // track_authorization caducado (cola restaurada o pestaña antigua): se refresca una vez.
      const stale = error instanceof ScgError && [401, 403, 404].includes(error.status) && item.url;
      if (!stale) throw error;
      track = await soundcloud.resolve(item.url, signal);
      trackData.set(item.id, track);
      downloaded = await downloadFirstAvailable(pickTranscodings(track, item.quality), track, item, signal);
    }
    if (isPreview(track, downloaded.candidate.transcoding)) item.warning = 'preview';

    let result;
    if (isFfmpegUnavailable()) {
      result = await fallbackWithoutFfmpeg({ candidates, track, item, signal, downloaded });
    } else {
      setStatus(item, STATUS.MUXING);
      const cover = settings.embedCover ? await fetchCover(track, signal) : null;
      try {
        const muxed = await mux({
          data: downloaded.data,
          copy: downloaded.candidate.codec === 'aac',
          cover,
          signal,
          meta: {
            title: meta.title,
            artist: meta.artist,
            album: meta.album,
            genre: meta.genre,
            date: meta.year,
            comment: meta.url,
          },
        });
        result = { blob: muxed.blob, ext: 'm4a', warning: null };
        if (settings.embedCover && !muxed.coverEmbedded) result.warning = 'nocover';
      } catch (error) {
        if (!(error instanceof ScgError) || error.code !== CODES.MUX_INIT) throw error;
        result = await fallbackWithoutFfmpeg({ candidates, track, item, signal, downloaded });
      }
    }
    downloaded = null;
    if (signal.aborted) throw new CanceledError();
    if (result.warning) item.warning = result.warning;

    setStatus(item, STATUS.SAVING);
    const name = formatName(settings.pattern, meta, result.ext);
    const blobUrl = URL.createObjectURL(result.blob);
    const saved = waitForSave(item, blobUrl, signal);
    saved.catch(() => {});
    try {
      const response = await rpc(RPC.DOWNLOAD, {
        itemId: item.id,
        url: blobUrl,
        path: joinPath(settings.subfolder, name),
        title: item.title,
        warning: item.warning,
      });
      item.filename = response.path;
      emit(true);
    } catch (error) {
      pendingSaves.delete(item.id);
      URL.revokeObjectURL(blobUrl);
      throw error;
    }
    await saved;
    item.status = STATUS.DONE;
    trackData.delete(item.id);
  } catch (error) {
    setError(item, error);
  } finally {
    controllers.delete(item.id);
  }
}

// ---------------------------------------------------------------- comandos

function cancelItem(id) {
  const item = findItem(id);
  if (!item || !isActive(item.status)) return;
  const controller = controllers.get(id);
  item.status = STATUS.CANCELED;
  item.error = null;
  if (controller) controller.abort();
}

function retryItem(id) {
  const item = findItem(id);
  if (!item || isActive(item.status) || controllers.has(id)) return;
  item.error = null;
  item.warning = null;
  item.segDone = 0;
  item.segTotal = 0;
  if (trackData.has(id) || !/\/sets\//.test(item.url) || item.index) {
    item.status = STATUS.QUEUED;
  } else {
    // Era el marcador de una playlist que no llegó a expandirse.
    item.status = STATUS.RESOLVING;
    expandPlaceholder(item, null, item.quality);
  }
}

function removeItem(id) {
  cancelItem(id);
  const position = items.findIndex((item) => item.id === id);
  if (position >= 0) items.splice(position, 1);
  trackData.delete(id);
}

function handleCommand(message) {
  switch (message.type) {
    case CMD.ENQUEUE:
      return enqueue(message);
    case CMD.CANCEL:
      cancelItem(message.id);
      break;
    case CMD.RETRY:
      retryItem(message.id);
      break;
    case CMD.REMOVE:
      removeItem(message.id);
      break;
    case CMD.CANCEL_ALL:
      for (const item of [...items]) cancelItem(item.id);
      break;
    case CMD.CLEAR_FINISHED:
      for (const item of [...items]) {
        if (!isActive(item.status)) removeItem(item.id);
      }
      break;
    case CMD.RESET_CLIENT_ID:
      soundcloud.forgetId();
      break;
    case PUSH.SETTINGS:
      settings = normalizeSettings(message.settings);
      soundcloud.setOverride(settings.clientIdOverride);
      break;
    case PUSH.DOWNLOAD_FINISHED: {
      const entry = pendingSaves.get(message.itemId);
      if (entry) {
        pendingSaves.delete(message.itemId);
        URL.revokeObjectURL(entry.blobUrl);
        if (message.ok) entry.resolve();
        else entry.reject(new ScgError(CODES.DOWNLOAD, message.error || 'Download was interrupted'));
      }
      return {};
    }
    default:
      throw new ScgError(CODES.UNKNOWN, `Unknown command: ${message.type}`);
  }
  emit(true);
  pump();
  return {};
}

// ---------------------------------------------------------------- arranque

async function init() {
  connectPort();
  const state = await rpc(RPC.GET_STATE);
  settings = normalizeSettings(state.settings);
  soundcloud = new SoundCloud({
    cachedId: state.clientId,
    override: settings.clientIdOverride,
    onNewId: (clientId) => {
      rpc(RPC.SAVE_CLIENT_ID, { clientId }).catch(() => {});
    },
  });

  // Cola restaurada: lo que estaba a medias vuelve a "en cola" y se reanuda desde su URL.
  const restored = Array.isArray(state.queue) ? state.queue : [];
  const placeholders = [];
  for (const saved of restored) {
    if (!saved || !saved.id || findItem(saved.id)) continue;
    const item = makeItem(saved);
    if (isActive(item.status)) {
      const wasPlaceholder = item.status === STATUS.RESOLVING && /\/sets\//.test(item.url) && !item.index;
      item.segDone = 0;
      item.segTotal = 0;
      if (wasPlaceholder) placeholders.push(item);
      else item.status = STATUS.QUEUED;
    }
    items.push(item);
  }
  for (const placeholder of placeholders) expandPlaceholder(placeholder, null, placeholder.quality);
  if (restored.length) emit(true);
  pump();
}

const ready = init();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== TARGET.OFFSCREEN) return false;
  ready
    .then(() => handleCommand(message))
    .then(
      (result) => sendResponse({ ok: true, ...(result || {}) }),
      (error) => sendResponse({ ok: false, error: toErrorInfo(error) }),
    );
  return true;
});
