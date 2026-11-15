// Contrato de mensajería compartido por service worker, offscreen y páginas de UI.
// (El content script es un script clásico y usa los mismos literales.)

export const TARGET = Object.freeze({
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen',
});

// UI / content script -> service worker (y reenviados tal cual al offscreen).
export const CMD = Object.freeze({
  ENQUEUE: 'enqueue', //        { url, hint?: { track?, playlist?, clientId? }, quality? }
  CANCEL: 'cancel', //          { id }
  RETRY: 'retry', //            { id }
  REMOVE: 'remove', //          { id }
  CANCEL_ALL: 'cancel-all', //  {}
  CLEAR_FINISHED: 'clear-finished', // {}
  RESET_CLIENT_ID: 'reset-client-id', // {}
});

// service worker -> offscreen (además de los CMD reenviados).
export const PUSH = Object.freeze({
  SETTINGS: 'settings-changed', //      { settings }
  DOWNLOAD_FINISHED: 'download-finished', // { itemId, ok, error? }
});

// offscreen -> service worker, petición/respuesta con chrome.runtime.sendMessage.
export const RPC = Object.freeze({
  GET_STATE: 'os:get-state', //          -> { settings, queue, clientId }
  SAVE_CLIENT_ID: 'os:save-client-id', // { clientId }
  CHECK_EXISTING: 'os:check-existing', // { path } -> { exists }
  DOWNLOAD: 'os:download', //            { itemId, url, path, title, warning } -> { downloadId, path }
});

// offscreen -> service worker por el puerto persistente.
export const PORT_NAME = 'scg-offscreen';
export const PORT = Object.freeze({
  SNAPSHOT: 'snapshot', // { queue }
  PING: 'ping',
});

export const STATUS = Object.freeze({
  QUEUED: 'queued',
  RESOLVING: 'resolving',
  DOWNLOADING: 'downloading',
  MUXING: 'muxing',
  SAVING: 'saving',
  DONE: 'done',
  ERROR: 'error',
  CANCELED: 'canceled',
  SKIPPED: 'skipped',
});

export const ACTIVE_STATUSES = Object.freeze([
  STATUS.QUEUED,
  STATUS.RESOLVING,
  STATUS.DOWNLOADING,
  STATUS.MUXING,
  STATUS.SAVING,
]);

export function isActive(status) {
  return ACTIVE_STATUSES.includes(status);
}

export const STORAGE = Object.freeze({
  QUEUE: 'queue',
  SETTINGS: 'settings',
  CLIENT_ID: 'clientId',
  LAST_RESULT: 'lastResult',
});
