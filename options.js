import { CMD, STORAGE } from './lib/messages.js';
import { applyI18n, t, send } from './lib/i18n.js';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from './lib/settings.js';
import { formatName, joinPath } from './lib/naming.js';

const $ = (id) => document.getElementById(id);
const fields = ['subfolder', 'pattern', 'quality', 'concurrency', 'clientIdOverride'];
const checks = ['skipExisting', 'embedCover'];

const SAMPLE = {
  artist: 'Artist Name',
  title: 'Track: Title / Mix?',
  album: 'Album',
  genre: 'Ambient',
  year: '2026',
  date: '2026-11-15',
  id: 123456789,
  index: '01',
};

function fill(settings) {
  for (const key of fields) $(key).value = settings[key];
  for (const key of checks) $(key).checked = settings[key];
  renderPreview();
}

function collect() {
  const settings = {};
  for (const key of fields) settings[key] = $(key).value;
  for (const key of checks) settings[key] = $(key).checked;
  return settings;
}

function renderPreview() {
  const name = formatName($('pattern').value, SAMPLE, 'm4a');
  $('preview').textContent = `${t('optPreview')} ${joinPath($('subfolder').value, name)}`;
}

function flash(text, ok = true) {
  const saved = $('saved');
  saved.textContent = text;
  saved.className = ok ? 'status-ok' : 'status-error';
  setTimeout(() => {
    if (saved.textContent === text) saved.textContent = '';
  }, 2500);
}

async function renderCachedId() {
  const stored = await chrome.storage.local.get(STORAGE.CLIENT_ID);
  $('cachedId').textContent = stored[STORAGE.CLIENT_ID] || t('optClientNone');
}

$('save').addEventListener('click', async () => {
  const override = $('clientIdOverride').value.trim();
  if (override && !/^[0-9A-Za-z]{32}$/.test(override)) {
    flash(t('optClientInvalid'), false);
    return;
  }
  fill(await saveSettings(collect()));
  flash(t('optSaved'));
});

$('reset').addEventListener('click', async () => {
  fill(await saveSettings({ ...DEFAULT_SETTINGS }));
  flash(t('optSaved'));
});

$('forget').addEventListener('click', async () => {
  await send(CMD.RESET_CLIENT_ID);
  await renderCachedId();
  flash(t('optClientForgotten'));
});

$('pattern').addEventListener('input', renderPreview);
$('subfolder').addEventListener('input', renderPreview);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE.CLIENT_ID]) renderCachedId();
});

applyI18n();
loadSettings().then(fill);
renderCachedId();
