import { test } from 'node:test';
import assert from 'node:assert/strict';
import en from '../js/locales/en.js';
import de from '../js/locales/de.js';
import fr from '../js/locales/fr.js';
import es from '../js/locales/es.js';

/** Every leaf path, with list lengths, so a missing string or level shows up by name. */
function shape(node, path = '') {
  if (Array.isArray(node)) return [`${path}[${node.length}]`];
  if (typeof node === 'object') return Object.entries(node).flatMap(([key, value]) => shape(value, `${path}.${key}`));
  return [path];
}

const placeholders = (text) => [...String(text).matchAll(/\{\w+\}/g)].map(([p]) => p).sort();

test('every language has every string, with the same placeholders', () => {
  for (const [code, locale] of Object.entries({ de, fr, es })) {
    assert.deepEqual(shape(locale).sort(), shape(en).sort(), code);
    for (const path of shape(en).filter((p) => !p.includes('['))) {
      const read = (root) => path.split('.').slice(1).reduce((node, key) => node[key], root);
      assert.deepEqual(placeholders(read(locale)), placeholders(read(en)), `${code}${path}`);
    }
  }
});
