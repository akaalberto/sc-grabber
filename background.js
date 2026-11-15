// Service worker: enruta mensajes, persiste la cola, gestiona chrome.downloads y el
// ciclo de vida del offscreen document. No descarga segmentos ni hace muxing.

import { TARGET, CMD, PUSH, RPC, PORT, PORT_NAME, STORAGE, isActive } from './lib/messages.js';
import { toErrorInfo } from './lib/errors.js';
import { withSuffix, pathRegex } from './lib/naming.js';
import { loadSettings } from './lib/settings.js';

const OFFSCREEN_URL = 'offscreen.html';
const COMMANDS = new Set(Object.values(CMD));
const BADGE_COLOR = '#ff5500';

// ---------------------------------------------------------------- offscreen

let creating = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS', 'WORKERS'],
        justification: 'Downloads HLS segments, muxes them with ffmpeg.wasm and creates the blob to save.',
      })
      .catch(async (error) => {
        // Otra llamada concurrente pudo crearlo antes.
        if (!(await hasOffscreen())) throw error;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

async function sendToOffscreen(message, { create = true } = {}) {
  if (create) await ensureOffscreen();
  else if (!(await hasOffscreen())) return { ok: true, skipped: true };
  const response = await chrome.runtime.sendMessage({ ...message, target: TARGET.OFFSCREEN });
  return response || { ok: false, error: { code: 'UNKNOWN', message: 'Offscreen did not answer' } };
}

async function readQueue() {
  const stored = await chrome.storage.local.get(STORAGE.QUEUE);
  return Array.isArray(stored[STORAGE.QUEUE]) ? stored[STORAGE.QUEUE] : [];
}

// Si la cola persistida tiene trabajo y el offscreen no existe (reinicio del navegador,
// cierre inesperado), se recrea: al arrancar pide el estado y reanuda solo.
async function resumeIfNeeded() {
  try {
    const queue = await readQueue();
    await updateBadge(queue);
    if (queue.some((item) => isActive(item.status))) await ensureOffscreen();
  } catch (error) {
    console.warn('[SC Grabber] resume failed:', toErrorInfo(error).message);
  }
}

// ---------------------------------------------------------------- puerto keep-alive

async function updateBadge(queue) {
  const active = queue.filter((item) => isActive(item.status)).length;
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({ text: active ? String(active) : '' });
}

let writeChain = Promise.resolve();

function persistQueue(queue) {
  writeChain = writeChain
    .then(async () => {
      await chrome.storage.local.set({ [STORAGE.QUEUE]: queue });
      await updateBadge(queue);
    })
    .catch((error) => {
      console.warn('[SC Grabber] could not persist queue:', toErrorInfo(error).message);
    });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  // Cada mensaje del puerto (snapshots, pings) reinicia el temporizador de inactividad
  // del service worker mientras haya descargas en curso.
  port.onMessage.addListener((message) => {
    if (message?.type === PORT.SNAPSHOT && Array.isArray(message.queue)) {
      persistQueue(message.queue);
    }
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    // El offscreen se cerró: si quedaba trabajo, se recrea.
    setTimeout(resumeIfNeeded, 500);
  });
});

// ---------------------------------------------------------------- descargas

const reserved = new Map(); // ruta en minúsculas -> caducidad (ms)
let downloadChain = Promise.resolve();

async function existsInDownloads(path) {
  const regex = pathRegex(path);
  let found = [];
  try {
    found = await chrome.downloads.search({ filenameRegex: `(?i)${regex}`, exists: true });
  } catch (error) {
    found = await chrome.downloads.search({ filenameRegex: regex, exists: true });
  }
  return found.some((entry) => entry.state !== 'interrupted' && entry.exists !== false);
}

function isReserved(path) {
  const key = path.toLowerCase();
  const expiry = reserved.get(key);
  if (expiry && expiry > Date.now()) return true;
  reserved.delete(key);
  return false;
}

// Colisiones: "nombre.m4a" -> "nombre (2).m4a", "nombre (3).m4a"...
async function uniquePath(path) {
  const slash = path.lastIndexOf('/');
  const folder = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  let candidate = path;
  for (let n = 2; n < 200; n += 1) {
    if (!isReserved(candidate) && !(await existsInDownloads(candidate))) break;
    candidate = folder + withSuffix(name, n);
  }
  return candidate;
}

function startDownload({ itemId, url, path, title, warning }) {
  const job = downloadChain.then(async () => {
    const finalPath = await uniquePath(path);
    reserved.set(finalPath.toLowerCase(), Date.now() + 120000);
    const downloadId = await chrome.downloads.download({
      url,
      filename: finalPath,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    await chrome.storage.session.set({
      [`dl:${downloadId}`]: { itemId, path: finalPath, title: title || '', warning: warning || null },
    });
    return { downloadId, path: finalPath };
  });
  downloadChain = job.catch(() => {});
  return job;
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  try {
    await downloadChain; // por si el alta en storage.session aún está en vuelo
    const key = `dl:${delta.id}`;
    const stored = await chrome.storage.session.get(key);
    const entry = stored[key];
    if (!entry) return; // descarga ajena a la extensión
    await chrome.storage.session.remove(key);

    const ok = state === 'complete';
    const reason = delta.error?.current || 'INTERRUPTED';
    await chrome.storage.local.set({
      [STORAGE.LAST_RESULT]: {
        ok,
        title: entry.title,
        path: entry.path,
        warning: entry.warning,
        error: ok ? null : { code: 'DOWNLOAD', message: reason },
        time: Date.now(),
      },
    });
    // El offscreen revoca la blob URL al recibir este aviso.
    await sendToOffscreen(
      { type: PUSH.DOWNLOAD_FINISHED, itemId: entry.itemId, ok, error: ok ? null : reason },
      { create: false },
    );
  } catch (error) {
    console.warn('[SC Grabber] download bookkeeping failed:', toErrorInfo(error).message);
  }
});

// ---------------------------------------------------------------- mensajes

async function handleMessage(message) {
  const { type } = message;

  if (type === CMD.RESET_CLIENT_ID) {
    await chrome.storage.local.remove(STORAGE.CLIENT_ID);
    return sendToOffscreen(message, { create: false });
  }
  if (COMMANDS.has(type)) {
    if (type === CMD.ENQUEUE && !message.quality) {
      message.quality = (await loadSettings()).quality;
    }
    return sendToOffscreen(message);
  }

  switch (type) {
    case RPC.GET_STATE: {
      const stored = await chrome.storage.local.get([STORAGE.QUEUE, STORAGE.CLIENT_ID]);
      return {
        ok: true,
        settings: await loadSettings(),
        queue: Array.isArray(stored[STORAGE.QUEUE]) ? stored[STORAGE.QUEUE] : [],
        clientId: stored[STORAGE.CLIENT_ID] || null,
      };
    }
    case RPC.SAVE_CLIENT_ID:
      await chrome.storage.local.set({ [STORAGE.CLIENT_ID]: message.clientId });
      return { ok: true };
    case RPC.CHECK_EXISTING:
      return { ok: true, exists: await existsInDownloads(message.path) };
    case RPC.DOWNLOAD: {
      const result = await startDownload(message);
      return { ok: true, ...result };
    }
    default:
      return { ok: false, error: { code: 'UNKNOWN', message: `Unknown message: ${type}` } };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== TARGET.BACKGROUND || sender.id !== chrome.runtime.id) return false;
  handleMessage(message).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: toErrorInfo(error) });
  });
  return true;
});

// Los cambios de ajustes llegan al offscreen (que no tiene chrome.storage).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE.SETTINGS]) return;
  loadSettings()
    .then((settings) => sendToOffscreen({ type: PUSH.SETTINGS, settings }, { create: false }))
    .catch(() => {});
});

// ---------------------------------------------------------------- ciclo de vida

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: '*://soundcloud.com/*' });
  for (const tab of tabs) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/inject.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
    } catch (error) {
      // Pestaña descartada o sin acceso: se inyectará al recargarla.
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  injectIntoOpenTabs().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  resumeIfNeeded();
});

resumeIfNeeded();
