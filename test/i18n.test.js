import { test } from 'node:test';
import assert from 'node:assert/strict';

test('loads the preferred locale and switches languages before translating', async (context) => {
  const preferences = new Map();
  const globals = {
    localStorage: {
      getItem: (key) => preferences.get(key) ?? null,
      setItem: (key, value) => preferences.set(key, value),
    },
    navigator: { languages: ['de-DE', 'en'] },
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    context.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }

  const i18n = await import('../js/i18n.js');
  assert.equal(i18n.lang, 'de');
  for (const code of ['fr', 'es', 'en', 'de']) {
    await i18n.setLanguage(code);
    const { default: locale } = await import(`../js/locales/${code}.js`);
    assert.equal(i18n.lang, code);
    assert.equal(i18n.t('judge'), locale.judge);
    assert.equal(preferences.get('judgeyou.language'), code);
  }
  await i18n.setLanguage('toString');
  assert.equal(i18n.lang, 'de');
});
