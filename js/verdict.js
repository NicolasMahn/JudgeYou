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
  const topLevel = Object.keys(answer.legend).length - 1;
  return answer.score / topLevel;
}

/** The legend entry closest to the (fractional) score. */
export function nearestLevel(answer) {
  return answer.legend[Math.round(answer.score)];
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
