import { CMD, STORAGE, isActive } from './lib/messages.js';
import { applyI18n, t, send, errorText, warningText } from './lib/i18n.js';
import { loadSettings, saveSettings } from './lib/settings.js';
import { isSoundCloudUrl } from './lib/soundcloud.js';

const $ = (id) => document.getElementById(id);
const urlInput = $('url');
const quality = $('quality');
const message = $('message');

function say(text, kind = '') {
  message.textContent = text;
  message.className = kind ? `status-${kind}` : '';
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function enqueue(url, hint) {
  const response = await send(CMD.ENQUEUE, { url, hint: hint || {}, quality: quality.value });
  if (!response.ok) {
    say(errorText(response.error), 'error');
    return false;
  }
  say(response.duplicate ? t('btnAlready') : t('popupAdded'), 'ok');
  return true;
}

$('add').addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!isSoundCloudUrl(url)) {
    say(t('err_UNSUPPORTED_URL'), 'error');
    return;
  }
  if (await enqueue(url)) urlInput.value = '';
});

urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('add').click();
});

// Playlist completa de la pestaña activa (con hydration si el content script responde).
$('playlist').addEventListener('click', async () => {
  const tab = await activeTab();
  let info = null;
  if (tab?.id) {
    try {
      info = await chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'page-info' });
    } catch (error) {
      info = null;
    }
  }
  const url = info?.url || tab?.url || '';
  if (!isSoundCloudUrl(url) || !/^\/[^/]+\/sets\/[^/]+/.test(new URL(url).pathname)) {
    say(t('popupNotPlaylist'), 'error');
    return;
  }
  await enqueue(url.split('?')[0], info?.hint);
});

quality.addEventListener('change', async () => {
  const settings = await loadSettings();
  await saveSettings({ ...settings, quality: quality.value });
});

$('openPanel').addEventListener('click', async () => {
  try {
    const current = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: current.id });
    window.close();
  } catch (error) {
    say(t('popupPanelError'), 'error');
  }
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

function renderLast(last) {
  const box = $('last');
  box.textContent = '';
  if (!last) {
    box.className = 'box muted';
    box.textContent = t('popupLastNone');
    return;
  }
  box.className = 'box';
  const title = document.createElement('div');
  title.className = 'title ellipsis';
  title.textContent = last.title || last.path;
  const state = document.createElement('div');
  state.className = last.ok ? 'status-ok' : 'status-error';
  state.textContent = last.ok ? t('st_done') : errorText(last.error);
  const path = document.createElement('div');
  path.className = 'muted ellipsis';
  path.textContent = `${last.path} · ${new Date(last.time).toLocaleTimeString()}`;
  box.append(title, state, path);
  if (last.warning) {
    const warning = document.createElement('div');
    warning.className = 'status-warn';
    warning.textContent = warningText(last.warning);
    box.append(warning);
  }
}

function renderActive(queue) {
  const count = (Array.isArray(queue) ? queue : []).filter((item) => isActive(item.status)).length;
  $('active').textContent = count ? t('popupActive', [String(count)]) : '';
}

async function init() {
  applyI18n();
  const settings = await loadSettings();
  quality.value = settings.quality;

  const stored = await chrome.storage.local.get([STORAGE.LAST_RESULT, STORAGE.QUEUE]);
  renderLast(stored[STORAGE.LAST_RESULT]);
  renderActive(stored[STORAGE.QUEUE]);

  const tab = await activeTab();
  const onSet = Boolean(tab?.url && isSoundCloudUrl(tab.url) && /\/sets\//.test(tab.url));
  $('playlist').disabled = !onSet;
  if (!onSet) $('playlist').title = t('popupNotPlaylist');
  urlInput.focus();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE.LAST_RESULT]) renderLast(changes[STORAGE.LAST_RESULT].newValue);
  if (changes[STORAGE.QUEUE]) renderActive(changes[STORAGE.QUEUE].newValue);
});

init();
