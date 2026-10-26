import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore, DRAFT_KEY } from '../js/draft.js';

function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: (key) => items.delete(key),
  };
}

function snapshot(overrides = {}) {
  return {
    text: 'Ana: hello\nBen: hi',
    names: 'Ana, Ben',
    selectedNames: ['Ana', 'Ben'],
    spared: ['Ben'],
    screenshotCount: 0,
    ...overrides,
  };
}

test('drafts round-trip through a new store without sharing mutable objects', () => {
  const storage = memoryStorage();
  const store = createDraftStore(() => storage);
  const original = snapshot();
  assert.equal(store.read(), null);
  assert.equal(store.write(original), true);
  original.selectedNames.pop();
  original.spared.push('Ana');

  const restored = createDraftStore(() => storage).read();
  assert.deepEqual(restored, snapshot());
  restored.text = 'changed';
  restored.selectedNames.length = 0;
  restored.spared.length = 0;
  assert.deepEqual(store.read(), snapshot());
});

test('stored drafts contain only the version and approved snapshot fields', () => {
  const storage = memoryStorage();
  const store = createDraftStore(() => storage);
  assert.equal(store.write(snapshot({
    consent: true,
    screenshots: ['data:image/png;base64,private'],
    requests: [{ text: 'private request' }],
    modelSource: 'private source',
    version: 99,
    extra: 'private extra',
  })), true);
  assert.deepEqual(JSON.parse(storage.getItem(DRAFT_KEY)), { version: 1, ...snapshot() });
  assert.deepEqual(store.read(), snapshot());
});

test('empty or whitespace-only text clears the draft even when names remain', () => {
  const storage = memoryStorage();
  const store = createDraftStore(() => storage);
  for (const text of ['', ' \n\t ']) {
    store.write(snapshot());
    assert.equal(store.write(snapshot({ text })), true);
    assert.equal(storage.getItem(DRAFT_KEY), null);
    assert.equal(store.read(), null);
  }
});

test('screenshot-only drafts keep only their count marker, including the maximum', () => {
  const storage = memoryStorage();
  const store = createDraftStore(() => storage);
  for (const screenshotCount of [1, 10]) {
    const value = snapshot({ text: '', screenshotCount });
    assert.equal(store.write(value), true);
    assert.deepEqual(store.read(), value);
  }
});

test('corrupt, unsupported, or malformed stored drafts are ignored and removed', () => {
  const valid = { version: 1, ...snapshot() };
  const missingField = { ...valid };
  delete missingField.names;
  const invalid = [
    '{broken', 'null', '[]', '"text"', '{}',
    JSON.stringify(snapshot()),
    ...[
      { ...valid, version: 2 },
      { ...valid, version: '1' },
      missingField,
      { ...valid, consent: true },
      { ...valid, text: 42 },
      { ...valid, names: [] },
      { ...valid, selectedNames: 'Ana' },
      { ...valid, selectedNames: [null] },
      { ...valid, spared: [false] },
      ...[-1, 11, 0.5, '1', null].map((screenshotCount) => ({ ...valid, screenshotCount })),
    ].map((value) => JSON.stringify(value)),
  ];
  for (const raw of invalid) {
    const storage = memoryStorage();
    storage.setItem(DRAFT_KEY, raw);
    assert.equal(createDraftStore(() => storage).read(), null, raw);
    assert.equal(storage.getItem(DRAFT_KEY), null, raw);
  }
});

test('invalid snapshots fail softly and remove an obsolete draft', () => {
  const storage = memoryStorage();
  const store = createDraftStore(() => storage);
  for (const value of [null, {}, snapshot({ selectedNames: [1] }), snapshot({ spared: Array(1) }), snapshot({ screenshotCount: NaN })]) {
    store.write(snapshot());
    assert.equal(store.write(value), false);
    assert.equal(store.read(), null);
  }
});

test('an unavailable storage getter never breaks read, write, or clear', () => {
  const store = createDraftStore(() => { throw new Error('disabled'); });
  assert.equal(store.read(), null);
  assert.equal(store.write(snapshot()), false);
  assert.equal(store.clear(), false);
});

test('blocked storage operations fail softly even when cleanup also throws', () => {
  const blocked = () => { throw new Error('blocked'); };
  const store = createDraftStore(() => ({ getItem: blocked, setItem: blocked, removeItem: blocked }));
  assert.equal(store.read(), null);
  assert.equal(store.write(snapshot()), false);
  assert.equal(store.write(snapshot({ text: '' })), false);
  assert.equal(store.clear(), false);
});

test('a quota failure tries to remove the old draft', () => {
  const storage = memoryStorage();
  const store = createDraftStore(() => storage);
  store.write(snapshot());
  storage.setItem = () => { throw new Error('quota exceeded'); };
  assert.equal(store.write(snapshot({ text: 'new chat' })), false);
  assert.equal(storage.getItem(DRAFT_KEY), null);
});

test('corrupt drafts still return null if removal is blocked', () => {
  const storage = memoryStorage();
  storage.setItem(DRAFT_KEY, '{broken');
  storage.removeItem = () => { throw new Error('blocked'); };
  assert.equal(createDraftStore(() => storage).read(), null);
});

test('clear removes only the draft and succeeds when it is already absent', () => {
  const storage = memoryStorage();
  const store = createDraftStore(() => storage);
  storage.setItem('other', 'retained');
  store.write(snapshot());
  assert.equal(store.clear(), true);
  assert.equal(store.read(), null);
  assert.equal(storage.getItem('other'), 'retained');
  assert.equal(store.clear(), true);
});
