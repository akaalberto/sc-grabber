// Side panel: pinta la cola persistida en chrome.storage.local y manda comandos.

import { CMD, STORAGE, STATUS, isActive } from './lib/messages.js';
import { applyI18n, t, send, errorText, statusText, warningText } from './lib/i18n.js';

const list = document.getElementById('list');
const empty = document.getElementById('empty');
const summary = document.getElementById('summary');
const rows = new Map(); // id -> { root, refs }

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createRow(item) {
  const root = element('li', 'item');
  const top = element('div', 'top');
  const art = element('img');
  art.alt = '';
  art.loading = 'lazy';
  art.referrerPolicy = 'no-referrer';
  const info = element('div', 'info');
  const title = element('div', 'title ellipsis');
  const artist = element('div', 'muted ellipsis');
  info.append(title, artist);

  const actions = element('div', 'actions');
  const cancel = element('button', 'small', t('panelCancel'));
  const retry = element('button', 'small', t('panelRetry'));
  const remove = element('button', 'small', '✕');
  remove.title = t('panelRemove');
  remove.setAttribute('aria-label', t('panelRemove'));
  cancel.addEventListener('click', () => send(CMD.CANCEL, { id: item.id }));
  retry.addEventListener('click', () => send(CMD.RETRY, { id: item.id }));
  remove.addEventListener('click', () => send(CMD.REMOVE, { id: item.id }));
  actions.append(cancel, retry, remove);
  top.append(art, info, actions);

  const line = element('div', 'line');
  const status = element('span');
  const count = element('span', 'muted');
  line.append(status, count);
  const progress = element('progress');
  const note = element('div', 'note');
  root.append(top, line, progress, note);

  return { root, refs: { art, title, artist, cancel, retry, status, count, progress, note } };
}

function statusClass(status) {
  if (status === STATUS.DONE) return 'status-ok';
  if (status === STATUS.ERROR) return 'status-error';
  if (status === STATUS.CANCELED || status === STATUS.SKIPPED) return 'muted';
  return '';
}

function updateRow(row, item) {
  const { refs } = row;
  const active = isActive(item.status);
  const thumb = item.artwork ? item.artwork.replace('-large.', '-t120x120.') : 'icons/icon48.png';
  if (refs.art.getAttribute('src') !== thumb) refs.art.src = thumb;
  refs.title.textContent = item.title || item.url;
  refs.title.title = item.title || item.url;
  refs.artist.textContent = item.artist || '';
  refs.status.textContent = statusText(item.status);
  refs.status.className = statusClass(item.status);

  const showCount = item.segTotal > 0 && (item.status === STATUS.DOWNLOADING || item.status === STATUS.MUXING || item.status === STATUS.SAVING);
  refs.count.textContent = showCount ? t('panelSegments', [String(item.segDone), String(item.segTotal)]) : '';

  refs.progress.hidden = !active;
  if (item.status === STATUS.DOWNLOADING && item.segTotal > 0) {
    refs.progress.max = item.segTotal;
    refs.progress.value = item.segDone;
  } else {
    refs.progress.removeAttribute('value'); // indeterminado
  }

  refs.cancel.hidden = !active;
  refs.retry.hidden = !(item.status === STATUS.ERROR || item.status === STATUS.CANCELED);

  let note = '';
  let noteClass = 'note muted';
  if (item.status === STATUS.ERROR) {
    note = errorText(item.error);
    noteClass = 'note status-error';
  } else if (item.warning) {
    note = warningText(item.warning);
    noteClass = 'note status-warn';
  } else if (item.status === STATUS.DONE && item.filename) {
    note = item.filename;
  }
  refs.note.textContent = note;
  refs.note.className = noteClass;
  refs.note.hidden = !note;
}

function render(queue) {
  const items = Array.isArray(queue) ? queue : [];
  const seen = new Set();
  let previous = null;
  for (const item of items) {
    seen.add(item.id);
    let row = rows.get(item.id);
    if (!row) {
      row = createRow(item);
      rows.set(item.id, row);
    }
    updateRow(row, item);
    const expected = previous ? previous.nextSibling : list.firstChild;
    if (row.root !== expected) list.insertBefore(row.root, expected);
    previous = row.root;
  }
  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.root.remove();
      rows.delete(id);
    }
  }

  empty.hidden = items.length > 0;
  const active = items.filter((item) => isActive(item.status)).length;
  const done = items.filter((item) => item.status === STATUS.DONE).length;
  const failed = items.filter((item) => item.status === STATUS.ERROR).length;
  summary.textContent = items.length ? t('panelSummary', [String(active), String(done), String(failed)]) : '';
  document.getElementById('cancelAll').disabled = active === 0;
  document.getElementById('clear').disabled = items.length === active;
}

document.getElementById('cancelAll').addEventListener('click', () => send(CMD.CANCEL_ALL));
document.getElementById('clear').addEventListener('click', () => send(CMD.CLEAR_FINISHED));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE.QUEUE]) render(changes[STORAGE.QUEUE].newValue);
});

applyI18n();
chrome.storage.local.get(STORAGE.QUEUE).then((stored) => render(stored[STORAGE.QUEUE]));
