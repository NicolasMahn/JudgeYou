import { parseChat, participantsOf } from './parse.js';
import { buildRequest, readVerdicts, MAX_SUBJECTS } from './questions.js';
import { askJev, findApiKey, forgetApiKey, rememberApiKey } from './jev.js';
import { menaceIndex, nearestLevel, normalisedScore, severityOf } from './verdict.js';
import { ARCHETYPES, FINDINGS, SEVERITY, TRAITS, identityColor } from './presentation.js';
import { SAMPLE_CHAT } from './sample.js';

const LAB_LINES = [
  'Establishing chain of custody…',
  'Calibrating sarcasm detector…',
  'Measuring emoji-to-sincerity ratio…',
  'Counting questions left on read…',
  'Cross-examining the quiet ones…',
  'Consulting Jev…',
];
const LAB_LINE_MS = 280;

// Jev answers in well under a second; a short minimum lets the verdict land
// with some ceremony instead of flickering past.
const MIN_LAB_MS = 1700;

const $ = (id) => document.getElementById(id);
const chat = $('chat');
const judgeButton = $('judge');
const keyForm = $('key-form');
const errorBox = $('error');
const lab = $('lab');
const results = $('results');

let messages = [];
let subjects = [];

const percent = (p) => `${Math.round(p * 100)}%`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fromTemplate(id) {
  return $(id).content.firstElementChild.cloneNode(true);
}

function onChatChanged() {
  messages = parseChat(chat.value);
  const participants = participantsOf(messages);
  subjects = participants.slice(0, MAX_SUBJECTS).map((p) => p.name);
  judgeButton.disabled = subjects.length < 2;
  renderSubjects(participants);
}

function renderSubjects(participants) {
  const box = $('subjects');
  box.replaceChildren();

  if (chat.value.trim() && subjects.length < 2) {
    box.textContent = 'Need at least two people talking to judge anyone.';
    return;
  }

  subjects.forEach((name, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.setProperty('--identity', identityColor(i));
    chip.textContent = name;
    box.append(chip);
  });

  const unjudged = participants.length - subjects.length;
  if (unjudged > 0) {
    box.append(`+${unjudged} quieter ${unjudged === 1 ? 'one' : 'ones'} spared`);
  }
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function runLab() {
  lab.replaceChildren();
  lab.hidden = false;
  let i = 0;
  const addLine = () => {
    const line = document.createElement('p');
    line.textContent = LAB_LINES[i++ % LAB_LINES.length];
    lab.append(line);
    if (lab.children.length > LAB_LINES.length) lab.firstElementChild.remove();
  };
  addLine();
  const timer = setInterval(addLine, LAB_LINE_MS);
  return () => {
    clearInterval(timer);
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

  keyForm.hidden = true;
  results.hidden = true;
  judgeButton.disabled = true;
  const stopLab = runLab();
  const { body, judgedCount } = buildRequest(messages, subjects);

  try {
    const timedAsk = async () => {
      const started = performance.now();
      const response = await askJev(apiKey, body);
      return { response, ms: Math.round(performance.now() - started) };
    };
    const [{ response, ms }] = await Promise.all([timedAsk(), wait(MIN_LAB_MS)]);
    stopLab();
    renderResults(readVerdicts(response.answers, subjects), {
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
    judgeButton.disabled = false;
  }
}

function barRow(label, probability, color) {
  const row = fromTemplate('bar-row');
  row.style.setProperty('--identity', color);
  row.querySelector('.who').textContent = label;
  row.querySelector('.value').textContent = percent(probability);
  row.querySelector('.fill').dataset.width = percent(probability);
  return row;
}

function renderResults({ culprit, people }, meta) {
  const culpritIndex = subjects.indexOf(culprit.choice);
  const culpritName = $('culprit-name');
  culpritName.textContent = culprit.choice;
  culpritName.style.color = identityColor(culpritIndex);
  $('culprit-stat').textContent =
    `p = ${culprit.probabilities[culprit.choice].toFixed(2)} · confidence ${culprit.confidence.toFixed(2)}`;
  $('culprit-bars').replaceChildren(
    ...subjects.map((name, i) => barRow(name, culprit.probabilities[name] ?? 0, identityColor(i))),
  );

  $('cards').replaceChildren(...people.map((person, i) => personCard(person, i)));

  const cost = meta.cost === undefined ? '' : ` · $${meta.cost.toFixed(6)}`;
  $('footnote').textContent =
    `n = ${meta.judgedCount} messages · ${meta.model} · ${meta.ms} ms${cost} · ` +
    'Not peer reviewed. Not reviewed at all.';

  results.hidden = false;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  animateIn();
}

function personCard({ name, answers }, index) {
  const card = fromTemplate('card');
  card.style.setProperty('--identity', identityColor(index));
  card.style.animationDelay = `${index * 90}ms`;
  card.querySelector('.name').textContent = name;

  const { archetype } = answers;
  const kind = ARCHETYPES[archetype.choice];
  card.querySelector('.archetype-name').textContent = kind.name;
  card.querySelector('.species').textContent =
    `${kind.species} · p = ${archetype.probabilities[archetype.choice].toFixed(2)}`;

  const index100 = menaceIndex(answers);
  const severity = SEVERITY[severityOf(index100)];
  card.querySelector('.menace-value').dataset.target = index100;
  const badge = card.querySelector('.severity');
  badge.style.setProperty('--severity', severity.color);
  badge.textContent = severity.word;

  card.querySelector('.traits').append(
    ...Object.entries(TRAITS).map(([key, label]) => traitMeter(label, answers[key])),
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

function traitMeter(label, answer) {
  const meter = fromTemplate('trait');
  meter.querySelector('.trait-name').textContent = label;
  meter.querySelector('.trait-confidence').textContent = `conf. ${answer.confidence.toFixed(2)}`;
  meter.querySelector('.fill').dataset.width = percent(normalisedScore(answer));
  meter.querySelector('.trait-level').textContent = nearestLevel(answer);

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

keyForm.addEventListener('submit', (event) => {
  event.preventDefault();
  rememberApiKey($('key').value.trim());
  judgeChat();
});
