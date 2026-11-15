// Muxing con ffmpeg.wasm (core single-thread vendorizado) dentro de un Worker.
// Un solo trabajo a la vez; el worker se reutiliza y se recrea si muere.

import { ScgError, CanceledError, CODES } from './errors.js';
import { sniffContainer, sniffImage } from './hls.js';

const WORKER_URL = new URL('./ffmpeg-worker.js', import.meta.url).href;
const CORE_URL = new URL('../vendor/ffmpeg-core.js', import.meta.url).href;
const WASM_URL = new URL('../vendor/ffmpeg-core.wasm', import.meta.url).href;
const LOAD_TIMEOUT_MS = 120000;

let worker = null;
let loaded = null;
let sequence = 0;
let unavailable = false;
const pending = new Map();
let chain = Promise.resolve();

function killWorker(reason) {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  loaded = null;
  for (const { reject } of pending.values()) reject(reason);
  pending.clear();
}

function call(type, payload = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    if (!worker) return reject(new ScgError(CODES.MUX, 'ffmpeg worker is not running'));
    sequence += 1;
    const id = sequence;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload }, transfer);
  });
}

function ensureLoaded() {
  if (unavailable) {
    return Promise.reject(new ScgError(CODES.MUX_INIT, 'ffmpeg.wasm is unavailable'));
  }
  if (loaded) return loaded;

  loaded = new Promise((resolve, reject) => {
    const fail = (cause) => {
      unavailable = true;
      const error = new ScgError(CODES.MUX_INIT, 'ffmpeg.wasm failed to start', { cause });
      killWorker(error);
      reject(error);
    };
    try {
      worker = new Worker(WORKER_URL);
    } catch (error) {
      fail(error);
      return;
    }
    worker.onmessage = (event) => {
      const { id, ok, result, error } = event.data;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new ScgError(CODES.MUX, error));
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      killWorker(new ScgError(CODES.MUX, 'ffmpeg worker crashed'));
    };
    const timer = setTimeout(() => fail(new Error('load timeout')), LOAD_TIMEOUT_MS);
    call('load', { coreURL: CORE_URL, wasmURL: WASM_URL }).then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        fail(error);
      },
    );
  });
  return loaded;
}

export function isFfmpegUnavailable() {
  return unavailable;
}

// Libera la instancia wasm cuando no hay trabajos; se recarga sola al siguiente mux().
export function disposeMux() {
  if (pending.size === 0) killWorker(new ScgError(CODES.MUX, 'ffmpeg worker disposed'));
}

function metadataArgs(meta) {
  const fields = {
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    genre: meta.genre,
    date: meta.date,
    comment: meta.comment,
  };
  const args = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      args.push('-metadata', `${key}=${String(value)}`);
    }
  }
  return args;
}

function buildArgs({ input, cover, copy, meta, output }) {
  const args = ['-hide_banner', '-i', input];
  if (cover) args.push('-i', cover);
  args.push('-map', '0:a:0');
  if (cover) args.push('-map', '1:v:0');
  if (copy) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', '256k');
  if (cover) args.push('-c:v', 'copy', '-disposition:v', 'attached_pic');
  else args.push('-vn');
  args.push(...metadataArgs(meta), '-movflags', '+faststart', '-f', 'ipod', output);
  return args;
}

async function runJob({ data, copy, cover, meta, signal }) {
  await ensureLoaded();
  if (signal?.aborted) throw new CanceledError();

  const container = sniffContainer(data);
  const inputExt = { mp4: 'mp4', ts: 'ts', mp3: 'mp3', adts: 'aac', bin: 'bin' }[container];
  const input = `input.${inputExt}`;
  const output = 'output.m4a';
  const coverExt = cover ? sniffImage(cover) : null;
  const coverName = coverExt ? `cover.${coverExt}` : null;

  const onAbort = () => killWorker(new CanceledError());
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await call('write', { path: input, data });
    if (coverName) await call('write', { path: coverName, data: cover });

    // Intentos en orden: lo pedido; sin portada; recodificando (si la copia falla).
    const attempts = [{ cover: coverName, copy }];
    if (coverName) attempts.push({ cover: null, copy });
    if (copy) attempts.push({ cover: null, copy: false });

    let last = null;
    for (const attempt of attempts) {
      await call('unlink', { paths: [output] });
      const args = buildArgs({ input, output, meta, cover: attempt.cover, copy: attempt.copy });
      last = await call('exec', { args });
      if (last.ret === 0) {
        const bytes = await call('read', { path: output });
        if (bytes && bytes.byteLength > 0) {
          return {
            blob: new Blob([bytes], { type: 'audio/mp4' }),
            coverEmbedded: Boolean(attempt.cover),
            transcoded: !attempt.copy,
          };
        }
      }
    }
    const hint = (last?.log || []).filter(Boolean).slice(-1)[0] || '';
    throw new ScgError(CODES.MUX, `ffmpeg exited with an error. ${hint}`.trim().slice(0, 200));
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (worker) {
      await call('unlink', { paths: [input, output, coverName].filter(Boolean) }).catch(() => {});
    }
  }
}

// mux({ data: Uint8Array, copy: boolean, cover: Uint8Array|null, meta, signal })
//   -> { blob, coverEmbedded, transcoded }
export function mux(job) {
  const run = chain.then(() => runJob(job));
  chain = run.catch(() => {});
  return run;
}
