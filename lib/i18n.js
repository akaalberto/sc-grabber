// Helpers de i18n para las páginas de la extensión.

export function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

// data-i18n -> textContent, data-i18n-placeholder, data-i18n-title.
export function applyI18n(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll('[data-i18n-placeholder]')) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  }
  for (const node of root.querySelectorAll('[data-i18n-title]')) {
    node.title = t(node.dataset.i18nTitle);
  }
  document.documentElement.lang = chrome.i18n.getUILanguage();
}

export function errorText(error) {
  if (!error) return '';
  const localized = chrome.i18n.getMessage(`err_${error.code}`);
  if (localized) return localized;
  return error.message || t('err_UNKNOWN');
}

export function statusText(status) {
  return t(`st_${status}`);
}

export function warningText(code) {
  return code ? t(`warn_${code}`) : '';
}

// Envía un comando al service worker y devuelve su respuesta ({ ok, ... }).
export async function send(type, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ target: 'background', type, ...payload });
    return response || { ok: false, error: { code: 'UNKNOWN', message: 'No response' } };
  } catch (error) {
    return { ok: false, error: { code: 'UNKNOWN', message: String(error?.message || error) } };
  }
}
