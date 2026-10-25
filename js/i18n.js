import en from './locales/en.js';

const LOCALES = { en };
const LOADERS = {
  de: () => import('./locales/de.js'),
  fr: () => import('./locales/fr.js'),
  es: () => import('./locales/es.js'),
};
export const LANGUAGES = { en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español' };
const STORAGE_KEY = 'judgeyou.language';

// The browser's language is the visitor's own choice; an IP lookup would ask
// a third party and still guess wrong for travellers and multilingual countries.
function preferredLanguage() {
  const chosen = localStorage.getItem(STORAGE_KEY);
  if (Object.hasOwn(LANGUAGES, chosen)) return chosen;
  return navigator.languages.map((tag) => tag.slice(0, 2).toLowerCase()).find((code) => Object.hasOwn(LANGUAGES, code)) ?? 'en';
}

export let lang = preferredLanguage();

async function loadLocale(code) {
  if (!Object.hasOwn(LOCALES, code)) LOCALES[code] = (await LOADERS[code]()).default;
}

// Only the selected language joins English on the initial module graph.
try {
  await loadLocale(lang);
} catch {
  lang = 'en';
}

export async function setLanguage(code) {
  if (!Object.hasOwn(LANGUAGES, code)) return;
  await loadLocale(code);
  lang = code;
  localStorage.setItem(STORAGE_KEY, code);
}

/** The string (or list) at a dotted path, with `{name}` placeholders filled in. English fills gaps. */
export function t(path, vars = {}) {
  const find = (locale) => path.split('.').reduce((node, key) => node?.[key], locale);
  const value = find(LOCALES[lang]) ?? find(en) ?? path;
  return typeof value === 'string' ? value.replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match) : value;
}

/**
 * Fills static markup: `data-i18n` sets text, `data-i18n-html` sets markup
 * from our own strings, `data-i18n-attr="placeholder:key; aria-label:key"`
 * sets attributes.
 */
export function translatePage(root = document) {
  document.documentElement.lang = lang;
  document.title = t('title');
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attribute, key] = pair.split(':').map((part) => part.trim());
      el.setAttribute(attribute, t(key));
    }
  }
}
