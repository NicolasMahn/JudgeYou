// How judgments look: names, flavour text, mascots, and which theme token
// carries which meaning. Components read from here instead of deciding.

/** Keys match the Choice options in questions.js. */
export const TYPES = {
  giga_chad: {
    name: 'The Giga Chad',
    species: 'Homo gigachadensis',
    note: 'Has never once typed “sorry for the long message”.',
  },
  golden_retriever: {
    name: 'The Golden Retriever',
    species: 'Canis entusiasticus',
    note: 'Greets every message like the best news of the year.',
  },
  cat: {
    name: 'The Cat',
    species: 'Felis indifferens',
    note: 'Will answer eventually, if the question is interesting enough.',
  },
  chaos_goblin: {
    name: 'The Chaos Goblin',
    species: 'Goblinus chaoticus',
    note: 'Last seen dropping a meme into a serious conversation.',
  },
  dragon: {
    name: 'The Dragon',
    species: 'Draco attentionis',
    note: 'Guards the conversation like a hoard. Do not approach the hoard.',
  },
  owl: {
    name: 'The Owl',
    species: 'Strix pedantica',
    note: '“Actually” is its favourite way to begin a sentence.',
  },
  sloth: {
    name: 'The Sloth',
    species: 'Bradypus minimus',
    note: 'Communicates chiefly through thumbs-up and single letters.',
  },
  mother_hen: {
    name: 'The Mother Hen',
    species: 'Gallus organizatrix',
    note: 'Keeps the plan, the list, the money and everyone’s patience.',
  },
  troll: {
    name: 'The Troll',
    species: 'Trollus provocans',
    note: 'Lives under the thread and charges a toll in attention.',
  },
  drama_llama: {
    name: 'The Drama Llama',
    species: 'Lama theatralis',
    note: 'Every scheduling conflict is a tragedy in five acts.',
  },
  mosquito: {
    name: 'The Mosquito',
    species: 'Culex passivoaggressivus',
    note: 'Small and persistent. You only notice the bite afterwards.',
  },
  npc: {
    name: 'The NPC',
    species: 'Homo nonludens',
    note: 'Dialogue options appear limited to “same” and “lol”.',
  },
};

export function mascotOf(type) {
  return `img/types/${type}.webp`;
}

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

// The stamp word carries the meaning; the stamp colour is the one accent.
export const SEVERITY = {
  low: 'Harmless',
  medium: 'Under observation',
  high: 'Certified menace',
};
