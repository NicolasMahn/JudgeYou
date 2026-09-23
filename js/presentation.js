// How judgments look: names, flavour text, mascots and number formats.
// Components read from here instead of deciding. Wording lives in locales/.
import { lang, t } from './i18n.js';

/** Keys match the Choice options in questions.js. Latin needs no translation. */
export const SPECIES = {
  giga_chad: 'Homo gigachadensis',
  golden_retriever: 'Canis entusiasticus',
  cat: 'Felis indifferens',
  chaos_goblin: 'Goblinus chaoticus',
  dragon: 'Draco attentionis',
  owl: 'Strix pedantica',
  sloth: 'Bradypus minimus',
  mother_hen: 'Gallus organizatrix',
  troll: 'Trollus provocans',
  drama_llama: 'Lama theatralis',
  mosquito: 'Culex passivoaggressivus',
  npc: 'Homo nonludens',
};

export const TYPE_KEYS = Object.keys(SPECIES);

export const typeName = (type) => t(`types.${type}.name`);
export const typeNote = (type) => t(`types.${type}.note`);

export function mascotOf(type) {
  return `img/types/${type}.webp`;
}

export const TRAIT_KEYS = ['passive_aggression', 'main_character', 'drama', 'effort'];
export const FINDING_KEYS = ['started_it', 'leaves_on_read', 'secretly_right'];

// The stamp word carries the severity; the stamp colour is the one accent.
export const severityLabel = (severity) => t(`severity.${severity}`);

export const percent = (p) => `${Math.round(p * 100)}%`;

export function formatNumber(value) {
  return new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(value);
}

/** "40 s", "12 min", "2 h 5 min", in the page's language. */
export function formatDuration(ms) {
  const unit = (value, unit) => new Intl.NumberFormat(lang, { style: 'unit', unit, unitDisplay: 'short' }).format(value);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return unit(Math.round(ms / 1000), 'second');
  if (minutes < 60) return unit(minutes, 'minute');
  const rest = minutes % 60;
  return rest ? `${unit(Math.floor(minutes / 60), 'hour')} ${unit(rest, 'minute')}` : unit(minutes / 60, 'hour');
}

/** The one-line proof behind a record, e.g. "median reply 2 h · n = 14". */
export function recordDetail({ key, stats }) {
  const detail = `records.${key}.detail`;
  if (key === 'slowest' || key === 'fastest') return t(detail, { time: formatDuration(stats.reply.median), n: stats.reply.n });
  if (key === 'wordiest') return t(detail, { words: formatNumber(stats.medianWords), n: stats.messages });
  return t(detail, stats.starts);
}
