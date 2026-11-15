// Ajustes del usuario (chrome.storage.local, clave "settings").

import { DEFAULT_PATTERN } from './naming.js';
import { STORAGE } from './messages.js';

export const DEFAULT_SETTINGS = Object.freeze({
  subfolder: '',
  pattern: DEFAULT_PATTERN,
  concurrency: 8,
  skipExisting: false,
  embedCover: true,
  quality: 'best',
  clientIdOverride: '',
});

export const QUALITIES = Object.freeze(['best', 'standard', 'low']);

export function normalizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const concurrency = Math.round(Number(merged.concurrency));
  return {
    subfolder: String(merged.subfolder || '').trim(),
    pattern: String(merged.pattern || '').trim() || DEFAULT_PATTERN,
    concurrency: Number.isFinite(concurrency) ? Math.min(16, Math.max(1, concurrency)) : 8,
    skipExisting: Boolean(merged.skipExisting),
    embedCover: Boolean(merged.embedCover),
    quality: QUALITIES.includes(merged.quality) ? merged.quality : 'best',
    clientIdOverride: String(merged.clientIdOverride || '').trim(),
  };
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE.SETTINGS);
  return normalizeSettings(stored[STORAGE.SETTINGS]);
}

export async function saveSettings(settings) {
  const clean = normalizeSettings(settings);
  await chrome.storage.local.set({ [STORAGE.SETTINGS]: clean });
  return clean;
}
