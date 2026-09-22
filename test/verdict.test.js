import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignTypes } from '../js/verdict.js';

const answer = (probabilities) => ({ probabilities });

test('weakly typed people move to a plausible free type instead of sharing', () => {
  const types = assignTypes([
    answer({ mother_hen: 0.47, giga_chad: 0.23, npc: 0.22 }),
    answer({ mother_hen: 1.0, npc: 0 }),
    answer({ mother_hen: 0.36, npc: 0.39, giga_chad: 0.12 }),
  ]);
  assert.deepEqual(
    types.map((t) => t.type),
    ['giga_chad', 'mother_hen', 'npc'],
  );
  assert.equal(types[0].probability, 0.23);
});

test('confident verdicts are kept even when they repeat', () => {
  const types = assignTypes([answer({ sloth: 0.95, npc: 0.05 }), answer({ sloth: 0.9, cat: 0.1 })]);
  assert.deepEqual(
    types.map((t) => t.type),
    ['sloth', 'sloth'],
  );
});
