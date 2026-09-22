import { parseChat, participantsOf } from './parse.js';
import { buildRequest, readVerdicts, MAX_SUBJECTS } from './questions.js';
import { askJev, findApiKey, forgetApiKey, rememberApiKey } from './jev.js';
import { menaceIndex, nearestLevel, normalisedScore, severityOf } from './verdict.js';
import { FINDINGS, SEVERITY, TRAITS, TYPES, mascotOf } from './presentation.js';
import { SAMPLE_CHAT } from './sample.js';

const LAB_LINES = [
  'Establishing chain of custody…',
  'Measuring emoji-to-sincerity ratio…',
  'Counting questions left on read…',
  'Consulting the field guide…',
  'Asking Jev…',
];
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

const typeKeys = Object.keys(TYPES);

// When the format isn't recognised, the user names the people and Jev reads
// the raw text instead of parsed messages.
let messages = [];
let detected = [];
let typedNames = [];
const spared = new Set();

const percent = (p) => `${Math.round(p * 100)}%`;
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
    name.textContent = TYPES[key].name.replace(/^The /, '');
    item.append(img, name);
    return item;
  };
  // Two copies so the drifting strip loops without a seam.
  $('species-track').append(...typeKeys.map(specimen), ...typeKeys.map(specimen));
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

function renderSubjects() {
  const box = $('subjects');
  box.replaceChildren(
    ...candidates().map((name) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = name;
      chip.setAttribute('aria-pressed', String(!spared.has(name)));
      chip.title = spared.has(name) ? 'Judge them after all' : 'Spare them';
      chip.addEventListener('click', () => {
        spared.has(name) ? spared.delete(name) : spared.add(name);
        renderSubjects();
      });
      return chip;
    }),
  );

  const unjudged = candidates().length - spared.size - subjects().length;
  if (unjudged > 0) box.append(`+${unjudged} quieter ones spared`);
  judgeButton.disabled = subjects().length < 2;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function runLab() {
  const log = $('lab-log');
  const specimen = $('lab-specimen');
  log.replaceChildren();
  lab.hidden = false;

  let line = 0;
  const addLine = () => {
    const p = document.createElement('p');
    p.textContent = LAB_LINES[line++ % LAB_LINES.length];
    log.append(p);
    if (log.children.length > 4) log.firstElementChild.remove();
  };
  let frame = 0;
  const flicker = () => {
    specimen.src = mascotOf(typeKeys[frame++ % typeKeys.length]);
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
  const { body, judgedCount } = buildRequest(isRawMode() ? chat.value : messages, judged);
  keyForm.hidden = true;
  results.hidden = true;
  judgeButton.disabled = true;
  const stopLab = runLab();

  try {
    const timedAsk = async () => {
      const started = performance.now();
      const response = await askJev(apiKey, body);
      return { response, ms: Math.round(performance.now() - started) };
    };
    const [{ response, ms }] = await Promise.all([timedAsk(), wait(MIN_LAB_MS)]);
    stopLab();
    renderResults(judged, readVerdicts(response.answers, judged), {
      judgedCount,
      ms,
      model: response.model,
      cost: response.usage?.cost,
    });
  } catch (error) {
    stopLab();
    if (error.status === 401) {
      forgetApiKey();
      keyForm.hidden = false;
    }
    showError(error.message);
  } finally {
    judgeButton.disabled = subjects().length < 2;
  }
}

function barRow(label, probability) {
  const row = fromTemplate('bar-row');
  row.querySelector('.who').textContent = label;
  row.querySelector('.value').textContent = percent(probability);
  row.querySelector('.fill').dataset.width = percent(probability);
  return row;
}

function renderResults(judged, { culprit, people }, meta) {
  const suspect = people.find((p) => p.name === culprit.choice);
  $('suspect-mascot').src = mascotOf(suspect.answers.type.choice);
  $('suspect-name').textContent = culprit.choice;
  $('suspect-stat').textContent =
    `${TYPES[suspect.answers.type.choice].name} · p = ${culprit.probabilities[culprit.choice].toFixed(2)} · ` +
    `confidence ${culprit.confidence.toFixed(2)}`;
  $('suspect-bars').replaceChildren(...judged.map((name) => barRow(name, culprit.probabilities[name] ?? 0)));

  $('plates').replaceChildren(...people.map(plate));

  const evidence = meta.judgedCount === null ? 'raw transcript' : `n = ${meta.judgedCount} messages`;
  const cost = meta.cost === undefined ? '' : ` · $${meta.cost.toFixed(6)}`;
  $('footnote').textContent = `${evidence} · ${meta.model} · ${meta.ms} ms${cost}`;

  results.hidden = false;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  animateIn();
}

function plate({ name, answers }, index) {
  const card = fromTemplate('plate');
  card.style.setProperty('--delay', `${index * 120}ms`);

  const type = TYPES[answers.type.choice];
  const img = card.querySelector('.plate-figure img');
  img.src = mascotOf(answers.type.choice);
  img.alt = type.name;

  card.querySelector('.plate-no').textContent = `Plate ${String(index + 1).padStart(2, '0')}`;
  card.querySelector('.plate-name').textContent = name;
  card.querySelector('.plate-type').append(
    type.name,
    Object.assign(document.createElement('small'), {
      textContent: `p = ${answers.type.probabilities[answers.type.choice].toFixed(2)}`,
    }),
  );
  card.querySelector('.plate-species').textContent = type.species;
  card.querySelector('.plate-note').textContent = type.note;

  const menace = menaceIndex(answers);
  card.querySelector('.menace-value').dataset.target = menace;
  card.querySelector('.stamp').textContent = SEVERITY[severityOf(menace)];

  card.querySelector('.measures').append(
    ...Object.entries(TRAITS).map(([key, label]) => scale(label, answers[key])),
  );
  card.querySelector('.findings').append(
    ...Object.entries(FINDINGS).map(([key, label]) => {
      const finding = fromTemplate('finding');
      finding.querySelector('dt').textContent = label;
      finding.querySelector('dd').textContent = percent(answers[key].noul);
      return finding;
    }),
  );
  return card;
}

function scale(label, answer) {
  const meter = fromTemplate('scale');
  meter.style.setProperty('--segments', Object.keys(answer.legend).length - 1);
  meter.querySelector('.scale-name').textContent = label;
  meter.querySelector('.scale-confidence').textContent = `conf. ${answer.confidence.toFixed(2)}`;
  meter.querySelector('.fill').dataset.width = percent(normalisedScore(answer));
  meter.querySelector('.scale-level').textContent = nearestLevel(answer);

  if (answer.probabilities) {
    meter.querySelector('.track').dataset.tip = Object.entries(answer.legend)
      .map(([level, text]) => `${percent(answer.probabilities[level] ?? 0).padStart(4)}  ${text}`)
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

renderSpeciesStrip();

chat.addEventListener('input', onChatChanged);

chat.addEventListener('dragover', (event) => {
  event.preventDefault();
  chat.classList.add('dragging');
});
chat.addEventListener('dragleave', () => chat.classList.remove('dragging'));
chat.addEventListener('drop', async (event) => {
  event.preventDefault();
  chat.classList.remove('dragging');
  const file = event.dataTransfer.files[0];
  if (!file) return;
  chat.value = await file.text();
  onChatChanged();
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
  rememberApiKey($('key').value.trim());
  judgeChat();
});
