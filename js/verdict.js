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
