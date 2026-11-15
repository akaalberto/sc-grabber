// Errores tipados. La UI traduce `code` con la clave i18n `err_<code>`;
// `message` es solo un texto de respaldo corto, nunca un traceback.

export const CODES = Object.freeze({
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  HTTP: 'HTTP',
  CANCELED: 'CANCELED',
  CLIENT_ID: 'CLIENT_ID',
  NOT_FOUND: 'NOT_FOUND',
  UNSUPPORTED_URL: 'UNSUPPORTED_URL',
  NO_STREAM: 'NO_STREAM',
  DRM: 'DRM',
  PLAYLIST_PARSE: 'PLAYLIST_PARSE',
  MUX_INIT: 'MUX_INIT',
  MUX: 'MUX',
  DOWNLOAD: 'DOWNLOAD',
  UNKNOWN: 'UNKNOWN',
});

export class ScgError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'ScgError';
    this.code = code;
    this.status = extra.status ?? null;
    this.fatal = extra.fatal ?? false;
    if (extra.cause) this.cause = extra.cause;
  }
}

export class CanceledError extends ScgError {
  constructor() {
    super(CODES.CANCELED, 'Canceled', { fatal: true });
    this.name = 'CanceledError';
  }
}

export function isCanceled(e) {
  return e instanceof CanceledError || e?.name === 'AbortError';
}

// Convierte cualquier excepción en algo serializable y presentable.
export function toErrorInfo(e) {
  if (isCanceled(e)) return { code: CODES.CANCELED, message: 'Canceled' };
  if (e instanceof ScgError) {
    return { code: e.code, message: e.status ? `${e.message} (HTTP ${e.status})` : e.message };
  }
  const text = String(e?.message || e || '').split('\n')[0].slice(0, 160);
  return { code: CODES.UNKNOWN, message: text || 'Unknown error' };
}
