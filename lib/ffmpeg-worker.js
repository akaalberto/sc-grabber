/* Worker clásico: único dueño de la instancia de @ffmpeg/core (build single-thread).
   Protocolo: { id, type, ... } -> { id, ok, result } | { id, ok: false, error } */

let core = null;
let logLines = [];

function pushLog(message) {
  logLines.push(String(message));
  if (logLines.length > 40) logLines.shift();
}

async function load({ coreURL, wasmURL }) {
  if (core) return true;
  self.importScripts(coreURL);
  if (typeof self.createFFmpegCore !== 'function') {
    throw new Error('ffmpeg-core did not export createFFmpegCore');
  }
  // El core localiza el .wasm a partir del JSON codificado tras '#'.
  const locator = btoa(JSON.stringify({ wasmURL, workerURL: '' }));
  core = await self.createFFmpegCore({ mainScriptUrlOrBlob: `${coreURL}#${locator}` });
  core.setLogger((entry) => pushLog(entry && entry.message));
  return true;
}

function safeUnlink(path) {
  try {
    core.FS.unlink(path);
  } catch (error) {
    // El archivo no existía: nada que limpiar.
  }
}

const handlers = {
  load,
  write({ path, data }) {
    core.FS.writeFile(path, data);
    return true;
  },
  exec({ args }) {
    logLines = [];
    core.setTimeout(-1);
    core.exec(...args);
    const ret = core.ret;
    core.reset();
    return { ret, log: logLines.slice(-12) };
  },
  read({ path }) {
    return core.FS.readFile(path);
  },
  unlink({ paths }) {
    for (const path of paths) safeUnlink(path);
    return true;
  },
};

self.onmessage = async (event) => {
  const { id, type, ...payload } = event.data;
  try {
    const handler = handlers[type];
    if (!handler) throw new Error(`Unknown worker command: ${type}`);
    if (type !== 'load' && !core) throw new Error('ffmpeg core is not loaded');
    const result = await handler(payload);
    const transfer = result instanceof Uint8Array ? [result.buffer] : [];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String((error && error.message) || error) });
  }
};
