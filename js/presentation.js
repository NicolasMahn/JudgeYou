// How judgments look: wording and which theme token carries which meaning.
// Components read from here instead of choosing colors or labels themselves.

export const ARCHETYPES = {
  monologuer: { name: 'The Monologuer', species: 'Loquax perpetuus' },
  ghost: { name: 'The Ghost', species: 'Spectrum silentium' },
  instigator: { name: 'The Instigator', species: 'Provocator vulgaris' },
  peacemaker: { name: 'The Peacemaker', species: 'Pacificus anxius' },
  jester: { name: 'The Jester', species: 'Scurra defensivus' },
  organiser: { name: 'The Organiser', species: 'Ordinator tyrannus' },
};

export const TRAITS = {
  passive_aggression: 'Passive aggression',
  main_character: 'Main character syndrome',
  drama: 'Drama output',
  effort: 'Effort',
};

export const FINDINGS = {
  started_it: 'Started it',
  leaves_on_read: 'Dodges questions',
  secretly_right: 'Secretly right',
};

// Severity is a status, so it uses the reserved status tokens and always
// travels with its word.
export const SEVERITY = {
  low: { word: 'Harmless', color: 'var(--status-good)' },
  medium: { word: 'Monitor closely', color: 'var(--status-warning)' },
  high: { word: 'Menace', color: 'var(--status-critical)' },
};

/** Identity follows the person: fixed by their position in the subject list. */
export function identityColor(index) {
  return `var(--series-${index + 1})`;
}
