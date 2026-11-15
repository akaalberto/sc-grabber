// Nombres de archivo: patrón, saneado, truncado y sufijos de colisión.

export const DEFAULT_PATTERN = '{artist} - {title}.m4a';
export const MAX_NAME_LENGTH = 180;

const FORBIDDEN = /[\\/:*?"<>|]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const KNOWN_EXT = /\.(m4a|mp3|aac|mp4)$/i;

export function sanitize(text) {
  let out = String(text ?? '')
    .normalize('NFC')
    .replace(CONTROL, '')
    .replace(FORBIDDEN, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (RESERVED.test(out)) out = `_${out}`;
  return out;
}

function truncate(text, max) {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return points.slice(0, max).join('').replace(/[. ]+$/, '');
}

// meta: { artist, title, album, genre, year, date, id, index }
export function formatName(pattern, meta, ext = 'm4a') {
  const source = (pattern && pattern.trim()) || DEFAULT_PATTERN;
  const filled = source.replace(/\{(\w+)\}/g, (match, key) => {
    if (!(key in meta)) return match;
    const value = meta[key];
    return value === null || value === undefined ? '' : sanitize(String(value));
  });
  let base = sanitize(filled.replace(KNOWN_EXT, ''));
  base = base.replace(/^[-_ ]+|[-_ ]+$/g, '').trim();
  if (!base) base = sanitize(`track ${meta.id ?? ''}`) || 'track';
  const suffix = `.${ext}`;
  return truncate(base, MAX_NAME_LENGTH - suffix.length) + suffix;
}

// "nombre.m4a", 2 -> "nombre (2).m4a" respetando el límite de longitud.
export function withSuffix(name, n) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const tag = ` (${n})`;
  return truncate(base, MAX_NAME_LENGTH - ext.length - tag.length) + tag + ext;
}

export function sanitizeSubfolder(folder) {
  return String(folder ?? '')
    .split(/[\\/]+/)
    .map((part) => sanitize(part))
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

export function joinPath(subfolder, name) {
  const folder = sanitizeSubfolder(subfolder);
  return folder ? `${folder}/${name}` : name;
}

export function replaceExt(name, ext) {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Regex para chrome.downloads.search: casa la ruta relativa al final de la absoluta,
// con separador / o \ indistintamente.
export function pathRegex(relativePath) {
  const parts = relativePath.split('/').map(escapeRegExp);
  return `(^|[\\\\/])${parts.join('[\\\\/]')}$`;
}
