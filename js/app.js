import { parseChat, participantsOf } from './parse.js';
import { buildRequest, readVerdicts, MAX_SUBJECTS, STATE_TOKEN_BUDGET } from './questions.js';
import { askJev, findApiKey, forgetApiKey, isApiKey, rememberApiKey } from './jev.js';
import { assignTypes, menaceIndex, normalisedScore, severityOf } from './verdict.js';
import { chatStats, recordsOf } from './stats.js';
import { FileError, readChatFile } from './files.js';
import { openCard } from './card.js';
import { LANGUAGES, lang, setLanguage, t, translatePage } from './i18n.js';
import {
  FINDING_KEYS,
  TRAIT_KEYS,
  TYPE_KEYS,
  SPECIES,
  formatDuration,
  formatNumber,
  mascotOf,
  percent,
  recordDetail,
  severityLabel,
  typeName,
  typeNote,
} from './presentation.js';
import { SAMPLE_CHAT } from './sample.js';

const LAB_LINE_MS = 340;
const LAB_FLICKER_MS = 110;

// Jev answers in well under a second; a short minimum lets the verdict land
// with some ceremony instead of flickering past.
const MIN_LAB_MS = 1800;

const $ = (id) => document.getElementById(id);
const chat = $('chat');
const judgeButton = $('judge');
const namesForm = $('names-form');
const keyForm = $('key-form');
const errorBox = $('error');
const lab = $('lab');
const results = $('results');

// When the format isn't recognised, the user names the people and Jev reads
// the raw text instead of parsed messages.
let messages = [];
let detected = [];
let typedNames = [];
const spared = new Set();

// Kept so a language switch can redraw the results without asking Jev again.
let lastVerdict = null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fromTemplate(id) {
  return $(id).content.firstElementChild.cloneNode(true);
}

function renderSpeciesStrip() {
  const specimen = (key) => {
    const item = document.createElement('div');
    item.className = 'species';
    const img = new Image(104, 104);
    img.src = mascotOf(key);
    img.alt = '';
    img.loading = 'lazy';
    const name = document.createElement('span');
    name.textContent = typeName(key);
    item.append(img, name);
    return item;
  };
  // Two copies so the drifting strip loops without a seam.
  $('species-track').replaceChildren(...TYPE_KEYS.map(specimen), ...TYPE_KEYS.map(specimen));
}

function renderLanguagePicker() {
  const picker = $('language');
  picker.replaceChildren(...Object.entries(LANGUAGES).map(([code, name]) => new Option(name, code, false, code === lang)));
  picker.addEventListener('change', () => {
    setLanguage(picker.value);
    translatePage();
    renderSpeciesStrip();
    renderSubjects();
    if (lastVerdict) renderResults(lastVerdict, { scroll: false });
  });
}

function isRawMode() {
  return detected.length < 2;
}

function candidates() {
  return isRawMode() ? typedNames : detected;
}

function subjects() {
  return candidates().filter((name) => !spared.has(name)).slice(0, MAX_SUBJECTS);
}

function onChatChanged() {
  messages = parseChat(chat.value);
  detected = participantsOf(messages).map((p) => p.name);
  spared.clear();
  namesForm.hidden = !chat.value.trim() || !isRawMode();
  renderSubjects();
}

async function loadFile(file) {
  errorBox.hidden = true;
  try {
    chat.value = await readChatFile(file);
    onChatChanged();
  } catch (error) {
    showError(error instanceof FileError ? t(`errors.${error.message}`) : error.message);
  }
}

function renderSubjects() {
  const box = $('subjects');
  box.replaceChildren(
    ...candidates().map((name) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = name;
      chip.setAttribute('aria-pressed', String(!spared.has(name)));
      chip.title = spared.has(name) ? t('unspare') : t('spare');
      chip.addEventListener('click', () => {
        spared.has(name) ? spared.delete(name) : spared.add(name);
        renderSubjects();
      });
      return chip;
    }),
  );

  const unjudged = candidates().length - spared.size - subjects().length;
  if (unjudged > 0) box.append(t('spared', { n: unjudged }));
  judgeButton.disabled = subjects().length < 2;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function runLab() {
  const log = $('lab-log');
  const specimen = $('lab-specimen');
  const lines = t('lab');
  log.replaceChildren();
  lab.hidden = false;

  let line = 0;
  const addLine = () => {
    const p = document.createElement('p');
    p.textContent = lines[line++ % lines.length];
    log.append(p);
    if (log.children.length > 4) log.firstElementChild.remove();
  };
  let frame = 0;
  const flicker = () => {
    specimen.src = mascotOf(TYPE_KEYS[frame++ % TYPE_KEYS.length]);
  };

  addLine();
  flicker();
  const timers = [setInterval(addLine, LAB_LINE_MS), setInterval(flicker, LAB_FLICKER_MS)];
  return () => {
    timers.forEach(clearInterval);
    lab.hidden = true;
  };
}

async function judgeChat() {
  errorBox.hidden = true;
  const apiKey = await findApiKey();
  if (!apiKey) {
    keyForm.hidden = false;
    $('key').focus();
    return;
  }

  const judged = subjects();
  const rawMode = isRawMode();
  const evidence = rawMode ? chat.value : messages;
  keyForm.hidden = true;
  results.hidden = true;
  judgeButton.disabled = true;
  const stopLab = runLab();

  try {
    const timedAsk = async () => {
      const started = performance.now();
      const { request, response } = await askWithinLimit(apiKey, evidence, judged);
      return { request, response, ms: Math.round(performance.now() - started) };
    };
    const [{ request, response, ms }] = await Promise.all([timedAsk(), wait(MIN_LAB_MS)]);
    stopLab();
    lastVerdict = {
      judged,
      ...readVerdicts(response.answers, judged),
      // Counted over the whole chat, not just the part Jev could read.
      stats: rawMode ? null : chatStats(messages),
      meta: {
        judgedCount: request.judgedCount,
        totalCount: rawMode ? null : messages.length,
        truncated: request.truncated,
        ms,
        model: response.model,
        cost: response.usage?.cost,
      },
    };
    renderResults(lastVerdict);
  } catch (error) {
    stopLab();
    if (error.status === 401) {
      forgetApiKey();
      keyForm.hidden = false;
    }
    showError(error.status ? t('errors.jev', { status: error.status, reason: error.reason }) : error.message);
  } finally {
    judgeButton.disabled = subjects().length < 2;
  }
}

/**
 * The token estimate is deliberately pessimistic, but an unusual chat can
 * still exceed Jev's limit; then retry once with a much smaller slice.
 */
async function askWithinLimit(apiKey, evidence, judged) {
  let request = buildRequest(evidence, judged);
  try {
    return { request, response: await askJev(apiKey, request.body) };
  } catch (error) {
    if (error.type !== 'max_tokens_exceeded') throw error;
    request = buildRequest(evidence, judged, STATE_TOKEN_BUDGET / 2);
    return { request, response: await askJev(apiKey, request.body) };
  }
}

function barRow(label, probability) {
  const row = fromTemplate('bar-row');
  row.querySelector('.who').textContent = label;
  row.querySelector('.value').textContent = percent(probability);
  row.querySelector('.fill').dataset.width = percent(probability);
  return row;
}

function renderResults({ judged, culprit, people, stats, meta }, { scroll = true } = {}) {
  const types = assignTypes(people.map((p) => p.answers.type));
  const suspectType = types[people.findIndex((p) => p.name === culprit.choice)].type;
  $('suspect-mascot').src = mascotOf(suspectType);
  $('suspect-name').textContent = culprit.choice;
  $('suspect-stat').textContent = t('suspectStat', {
    type: typeName(suspectType),
    p: culprit.probabilities[culprit.choice].toFixed(2),
    confidence: culprit.confidence.toFixed(2),
  });
  $('suspect-bars').replaceChildren(...judged.map((name) => barRow(name, culprit.probabilities[name] ?? 0)));

  const records = stats ? recordsOf(stats, judged) : [];
  $('records').replaceChildren(...records.map(record));
  $('records').hidden = !records.length;

  $('plates').replaceChildren(...people.map((person, i) => plate(person, i, types[i], stats?.get(person.name))));

  const evidence =
    meta.judgedCount === null
      ? t(meta.truncated ? 'evidenceRawTruncated' : 'evidenceRaw')
      : meta.truncated
        ? t('evidenceTruncated', { n: meta.judgedCount, total: meta.totalCount })
        : t('evidenceAll', { n: meta.judgedCount });
  const cost = meta.cost === undefined ? '' : ` · $${meta.cost.toFixed(6)}`;
  $('footnote').textContent = `${evidence} · ${meta.model} · ${meta.ms} ms${cost}`;

  $('share').onclick = () =>
    openCard({
      suspect: culprit.choice,
      people: people.map(({ name, answers }, i) => {
        const menace = menaceIndex(answers);
        return { name, type: types[i].type, menace, severity: severityOf(menace) };
      }),
      records: records.map((r) => ({ key: r.key, name: r.name, detail: recordDetail(r) })),
    });

  results.hidden = false;
  if (scroll) results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  animateIn();
}

function record(entry) {
  const box = document.createElement('div');
  box.className = 'record';
  const title = Object.assign(document.createElement('span'), { textContent: t(`records.${entry.key}.title`) });
  const name = Object.assign(document.createElement('strong'), { textContent: entry.name });
  const detail = Object.assign(document.createElement('small'), { textContent: recordDetail(entry) });
  box.append(title, name, detail);
  return box;
}

function plate({ name, answers }, index, assigned, counts) {
  const card = fromTemplate('plate');
  card.style.setProperty('--delay', `${index * 120}ms`);

  const img = card.querySelector('.plate-figure img');
  img.src = mascotOf(assigned.type);
  img.alt = typeName(assigned.type);

  card.querySelector('.plate-no').textContent = t('plate', { n: String(index + 1).padStart(2, '0') });
  card.querySelector('.menace-label').textContent = t('menace');
  card.querySelector('.plate-name').textContent = name;
  card.querySelector('.plate-type').append(
    typeName(assigned.type),
    Object.assign(document.createElement('small'), {
      textContent: `p = ${assigned.probability.toFixed(2)}`,
    }),
  );
  card.querySelector('.plate-species').textContent = SPECIES[assigned.type];
  card.querySelector('.plate-note').textContent = typeNote(assigned.type);

  const menace = menaceIndex(answers);
  card.querySelector('.menace-value').dataset.target = menace;
  card.querySelector('.stamp').textContent = severityLabel(severityOf(menace));

  card.querySelector('.measures').append(...TRAIT_KEYS.map((key) => scale(key, answers[key])));

  const counted = card.querySelector('.counted');
  if (counts) {
    counted.append(
      fact(t('counted.messages'), formatNumber(counts.messages)),
      fact(t('counted.words'), formatNumber(counts.medianWords), t('counted.wordsDefinition')),
      fact(
        t('counted.reply'),
        counts.reply ? formatDuration(counts.reply.median) : '–',
        `${t('counted.replyDefinition')}${counts.reply ? ` (n = ${counts.reply.n})` : ''}`,
      ),
    );
  } else {
    counted.remove();
  }
  card.querySelector('.findings').append(...FINDING_KEYS.map((key) => fact(t(`findings.${key}`), percent(answers[key].noul))));
  return card;
}

function fact(label, value, definition) {
  const item = fromTemplate('finding');
  item.querySelector('dt').textContent = label;
  item.querySelector('dd').textContent = value;
  if (definition) item.title = definition;
  return item;
}

function scale(key, answer) {
  const levels = t(`levels.${key}`);
  const meter = fromTemplate('scale');
  meter.style.setProperty('--segments', levels.length - 1);
  meter.querySelector('.scale-name').textContent = t(`traits.${key}`);
  meter.querySelector('.scale-confidence').textContent = t('confidence', { c: answer.confidence.toFixed(2) });
  meter.querySelector('.fill').dataset.width = percent(normalisedScore(answer));
  meter.querySelector('.scale-level').textContent = levels[Math.round(answer.score)];

  if (answer.probabilities) {
    // Jev's legend is in English; its levels are in the same order as ours.
    meter.querySelector('.track').dataset.tip = Object.keys(answer.legend)
      .map((level, i) => `${percent(answer.probabilities[level] ?? 0).padStart(4)}  ${levels[i]}`)
      .join('\n');
  }
  return meter;
}

function animateIn() {
  // Widths are applied a frame after insertion so the CSS transition runs.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      for (const fill of results.querySelectorAll('.fill')) fill.style.width = fill.dataset.width;
    }),
  );

  for (const counter of results.querySelectorAll('.menace-value')) {
    const target = Number(counter.dataset.target);
    const started = performance.now();
    const tick = (now) => {
      const progress = Math.min((now - started) / 1200, 1);
      counter.textContent = Math.round(target * (1 - (1 - progress) ** 3));
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

translatePage();
renderLanguagePicker();
renderSpeciesStrip();

chat.addEventListener('input', onChatChanged);

chat.addEventListener('dragover', (event) => {
  event.preventDefault();
  chat.classList.add('dragging');
});
chat.addEventListener('dragleave', () => chat.classList.remove('dragging'));
chat.addEventListener('drop', (event) => {
  event.preventDefault();
  chat.classList.remove('dragging');
  const file = event.dataTransfer.files[0];
  if (file) loadFile(file);
});

$('open-file').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', () => {
  const file = $('file').files[0];
  $('file').value = '';
  if (file) loadFile(file);
});

$('sample').addEventListener('click', () => {
  chat.value = SAMPLE_CHAT;
  onChatChanged();
});

judgeButton.addEventListener('click', judgeChat);

namesForm.addEventListener('submit', (event) => {
  event.preventDefault();
  typedNames = [...new Set($('names').value.split(',').map((n) => n.trim()).filter(Boolean))];
  spared.clear();
  renderSubjects();
});

keyForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const key = $('key').value.trim();
  if (!isApiKey(key)) {
    showError(t('errors.badKey'));
    return;
  }
  rememberApiKey(key);
  judgeChat();
});
