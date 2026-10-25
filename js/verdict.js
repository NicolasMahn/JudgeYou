// Jev answers narrow questions; the overall judgment is combined here, in
// code, so the weights stay ours to tune.
const WEIGHTS = {
  passive_aggression: 0.35,
  drama: 0.3,
  main_character: 0.25,
  started_it: 0.1,
};

/** A Score answer as a fraction of its scale, 0–1. */
export function normalisedScore(answer) {
  // Judged answers carry the model's legend, counted ones their number of levels.
  const topLevel = (answer.legend ? Object.keys(answer.legend).length : answer.levels) - 1;
  return answer.score / topLevel;
}

// Median words per message at which each effort level starts: one-word
// replies, short but relevant, complete replies, essays.
const EFFORT_FROM = [0, 3, 7, 15];

/**
 * Effort on the same four levels as the other scales, but counted from the
 * person's messages instead of judged, so it can't contradict the numbers
 * beside it. Null without counts (an unrecognised format).
 */
export function countedEffort(counts) {
  if (!counts?.messages || !Number.isFinite(counts.medianWords)) return null;
  const score = EFFORT_FROM.findLastIndex((from) => counts.medianWords >= from);
  return { score, levels: EFFORT_FROM.length, counted: counts.messages };
}

/** Returns 0–100. */
export function menaceIndex(answers) {
  const total =
    WEIGHTS.passive_aggression * normalisedScore(answers.passive_aggression) +
    WEIGHTS.drama * normalisedScore(answers.drama) +
    WEIGHTS.main_character * normalisedScore(answers.main_character) +
    WEIGHTS.started_it * answers.started_it.noul;
  return Math.round(total * 100);
}

// Who heads the verdict. The model may answer "nobody", but a verdict nobody
// can be blamed for is rarely worth sharing, so only a chat it is all but
// sure is peaceful is dismissed. Without a clear culprit, the most remarkable
// person by Menace Index becomes a "person of interest", which blames nobody.
// Two people close at the top share the verdict.
const DISMISS_FROM = 0.95;
const GUILTY_FROM = 0.3;
const CULPRIT_TIE = 0.1;
const MENACE_TIE = 3;

/**
 * `people` are `{ name, menace }`. Returns `{ choices, strength }`: one or two
 * names and 'guilty', 'interest' or 'dismissed' (choices is then empty).
 */
export function convict(culprit, people, nobody = 'nobody') {
  const p = (name) => culprit.probabilities?.[name] ?? 0;
  if (p(nobody) >= DISMISS_FROM) return { choices: [], strength: 'dismissed' };

  const byBlame = [...people].sort((a, b) => p(b.name) - p(a.name));
  const [top, second] = byBlame;
  if (p(top.name) >= GUILTY_FROM) {
    const tied = second && p(second.name) >= GUILTY_FROM && p(top.name) - p(second.name) <= CULPRIT_TIE;
    return { choices: tied ? [top.name, second.name] : [top.name], strength: 'guilty' };
  }

  const [first, next] = [...people].sort((a, b) => b.menace - a.menace);
  const tied = next && first.menace - next.menace <= MENACE_TIE;
  return { choices: tied ? [first.name, next.name] : [first.name], strength: 'interest' };
}

export function severityOf(index) {
  if (index < 34) return 'low';
  if (index < 67) return 'medium';
  return 'high';
}

// Below this, a runner-up type is a guess rather than a reading of the chat.
const PLAUSIBLE_TYPE = 0.15;

/**
 * Picks each person's type from Jev's probabilities. Everyday chats leave most
 * people only weakly typed, and they would all land on the same catch-all
 * type. So when a type is taken, the person who fits it best keeps it and the
 * others move to their most likely free type, if Jev finds it plausible.
 * Returns `{ type, probability }` per person, in the given order.
 */
export function assignTypes(typeAnswers) {
  const ranked = typeAnswers.map((answer) =>
    Object.entries(answer.probabilities).sort(([, a], [, b]) => b - a),
  );
  const byConfidence = ranked.map((_, i) => i).sort((a, b) => ranked[b][0][1] - ranked[a][0][1]);
  const taken = new Set();
  const assigned = [];

  for (const i of byConfidence) {
    const [type, probability] =
      ranked[i].find(([t, p]) => !taken.has(t) && p >= PLAUSIBLE_TYPE) ?? ranked[i][0];
    taken.add(type);
    assigned[i] = { type, probability };
  }
  return assigned;
}
