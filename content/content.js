// Content script (mundo aislado, script clásico): lee window.__sc_hydration del HTML,
// inyecta el botón "Descargar M4A" junto al de Like y envía la orden al service worker.
(() => {
  const HOST_CLASS = 'scg-host';
  const MARK = 'data-scg';

  // Tras recargar la extensión quedan botones huérfanos de la instancia anterior.
  for (const stale of document.querySelectorAll(`.${HOST_CLASS}`)) stale.remove();
  for (const marked of document.querySelectorAll(`[${MARK}]`)) marked.removeAttribute(MARK);

  const t = (key) => {
    try {
      return chrome.i18n.getMessage(key) || key;
    } catch (error) {
      return key;
    }
  };

  // ------------------------------------------------------------ hydration

  let hydrationCache;

  function readHydration() {
    if (hydrationCache !== undefined) return hydrationCache;
    hydrationCache = null;
    for (const script of document.querySelectorAll('script:not([src])')) {
      const text = script.textContent || '';
      const start = text.indexOf('window.__sc_hydration');
      if (start === -1) continue;
      const open = text.indexOf('[', start);
      const close = text.lastIndexOf(']');
      if (open === -1 || close <= open) continue;
      try {
        const entries = JSON.parse(text.slice(open, close + 1));
        const pick = (name) => {
          const entry = entries.find((candidate) => candidate && candidate.hydratable === name);
          return entry ? entry.data : null;
        };
        const apiClient = pick('apiClient');
        hydrationCache = {
          sound: pick('sound'),
          playlist: pick('playlist'),
          clientId: apiClient && typeof apiClient.id === 'string' ? apiClient.id : null,
        };
      } catch (error) {
        hydrationCache = null;
      }
      break;
    }
    return hydrationCache;
  }

  function normalize(url) {
    try {
      const parsed = new URL(url, location.href);
      return (parsed.hostname.replace(/^(www|m)\./, '') + parsed.pathname.replace(/\/+$/, '')).toLowerCase();
    } catch (error) {
      return '';
    }
  }

  // La hydration describe la carga inicial; tras navegar dentro de la SPA puede no
  // corresponder a la URL pedida. Solo se usa si coincide; si no, resuelve el offscreen.
  function hintFor(url) {
    const hydration = readHydration();
    if (!hydration) return {};
    const key = normalize(url);
    const hint = {};
    if (hydration.clientId) hint.clientId = hydration.clientId;
    const { sound, playlist } = hydration;
    if (sound && sound.kind === 'track' && normalize(sound.permalink_url) === key) {
      hint.track = sound;
    } else if (playlist && normalize(playlist.permalink_url) === key) {
      hint.playlist = playlist;
    } else if (playlist && Array.isArray(playlist.tracks)) {
      const match = playlist.tracks.find((track) => track && track.media && normalize(track.permalink_url) === key);
      if (match) hint.track = match;
    }
    return hint;
  }

  // ------------------------------------------------------------ botón

  const ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7.25 1.5h1.5v7.19l2.22-2.22 1.06 1.06L8 11.56 3.97 7.53l1.06-1.06 2.22 2.22V1.5zM2.5 13h11v1.5h-11V13z"/></svg>';

  const STYLE = `
    :host { all: initial; }
    button {
      all: unset;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 26px;
      padding: 0 10px;
      border: 1px solid rgba(128, 128, 128, 0.45);
      border-radius: 4px;
      font: 500 12px/1 Inter, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: var(--scg-color, #333);
      background: transparent;
      cursor: pointer;
      white-space: nowrap;
      user-select: none;
      transition: border-color 0.12s, color 0.12s;
    }
    button.compact { height: 22px; padding: 0 6px; }
    button.compact .label { display: none; }
    button:hover { border-color: #f50; color: #f50; }
    button:focus-visible { outline: 2px solid #f50; outline-offset: 1px; }
    button[data-state="busy"] { opacity: 0.6; cursor: progress; }
    button[data-state="ok"] { border-color: #2e9e4f; color: #2e9e4f; }
    button[data-state="error"] { border-color: #d43c3c; color: #d43c3c; }
    svg { flex: 0 0 auto; display: block; }
  `;

  function createButton({ compact, label, getUrl }) {
    const host = document.createElement('span');
    host.className = HOST_CLASS;
    if (compact) host.setAttribute('data-scg-compact', '1');
    const root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    const button = document.createElement('button');
    button.type = 'button';
    if (compact) button.className = 'compact';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = `${ICON}<span class="label"></span>`;
    const text = button.querySelector('.label');
    text.textContent = label;
    root.append(style, button);

    // Hereda el color del texto de SoundCloud (tema claro u oscuro).
    const syncColor = () => {
      const parent = host.parentElement;
      if (parent) button.style.setProperty('--scg-color', getComputedStyle(parent).color);
    };

    let resetTimer = null;
    const setState = (state, message) => {
      clearTimeout(resetTimer);
      if (state) button.dataset.state = state;
      else delete button.dataset.state;
      text.textContent = message || label;
      button.title = message || label;
      if (state === 'ok' || state === 'error') {
        resetTimer = setTimeout(() => setState(null), 4000);
      }
    };

    button.addEventListener('click', async (event) => {
      // No dejar que el clic llegue a la fila (reproduciría la pista).
      event.preventDefault();
      event.stopPropagation();
      if (button.dataset.state === 'busy') return;
      const url = getUrl();
      if (!url) {
        setState('error', t('btnError'));
        return;
      }
      setState('busy', t('btnQueuing'));
      try {
        const response = await chrome.runtime.sendMessage({
          target: 'background',
          type: 'enqueue',
          url,
          hint: hintFor(url),
        });
        if (response && response.ok) {
          setState('ok', response.duplicate ? t('btnAlready') : t('btnQueued'));
        } else {
          const code = response && response.error && response.error.code;
          setState('error', (code && chrome.i18n.getMessage(`err_${code}`)) || t('btnError'));
        }
      } catch (error) {
        // Contexto invalidado (extensión recargada): hace falta recargar la página.
        setState('error', t('btnReload'));
      }
      // Devolver el foco a la página para no interferir con sus atajos de teclado.
      button.blur();
    });
    button.addEventListener('mousedown', (event) => event.stopPropagation());
    button.addEventListener('dblclick', (event) => event.stopPropagation());

    return { host, syncColor };
  }

  // ------------------------------------------------------------ inyección

  const pageUrl = () => location.origin + location.pathname;
  const isSetPage = () => /^\/[^/]+\/sets\/[^/]+/.test(location.pathname);

  function hrefOf(scope, selectors) {
    for (const selector of selectors) {
      const link = scope.querySelector(selector);
      const href = link && link.getAttribute('href');
      if (href) {
        const url = new URL(href, location.origin);
        return url.origin + url.pathname;
      }
    }
    return '';
  }

  // Cada regla: dónde está el botón de Like y cómo obtener la URL de ese elemento.
  const RULES = [
    {
      // Cabecera de la página de pista o de playlist.
      like: '.listenEngagement .soundActions .sc-button-like, .listenEngagement .sc-button-like',
      compact: false,
      label: () => (isSetPage() ? t('btnDownloadPlaylist') : t('btnDownload')),
      url: () => pageUrl(),
    },
    {
      // Filas de una playlist.
      like: '.trackList__item .sc-button-like',
      compact: true,
      label: () => t('btnDownload'),
      url: (like) => {
        const row = like.closest('.trackList__item');
        return row ? hrefOf(row, ['a.trackItem__trackTitle', '.trackItem__content a[href]']) : '';
      },
    },
    {
      // Listas genéricas (stream, búsqueda, perfil).
      like: '.soundList__item .sc-button-like, .searchList__item .sc-button-like, .userStreamItem .sc-button-like',
      compact: true,
      label: () => t('btnDownload'),
      url: (like) => {
        const item = like.closest('.soundList__item, .searchList__item, .userStreamItem');
        return item ? hrefOf(item, ['a.soundTitle__title', 'a.sc-link-primary[href]']) : '';
      },
    },
  ];

  function scan() {
    for (const rule of RULES) {
      for (const like of document.querySelectorAll(rule.like)) {
        if (like.hasAttribute(MARK)) {
          const next = like.nextElementSibling;
          if (next && next.classList.contains(HOST_CLASS)) continue;
        }
        like.setAttribute(MARK, '1');
        const { host, syncColor } = createButton({
          compact: rule.compact,
          label: rule.label(),
          getUrl: () => rule.url(like),
        });
        like.insertAdjacentElement('afterend', host);
        syncColor();
      }
    }
  }

  let scheduled = null;
  const schedule = () => {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      try {
        scan();
      } catch (error) {
        // Un cambio de DOM de SoundCloud no debe romper la página.
      }
    }, 250);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  schedule();

  // El popup pide la URL/hydration de la pestaña para "playlist completa".
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== 'content' || message.type !== 'page-info') return false;
    const url = pageUrl();
    sendResponse({ url, hint: hintFor(url), isSet: isSetPage() });
    return false;
  });
})();
