import { parseChat, participantsOf } from './parse.js';
import { buildRequest, readVerdicts, MAX_SUBJECTS, STATE_TOKEN_BUDGET } from './questions.js';
import { askJudge, forgetChat, readScreenshots } from './api.js';
import { forgetKept, rememberKept } from './kept.js';
import { assignTypes, menaceIndex, normalisedScore, severityOf } from './verdict.js';
import { chatStats, recordsOf } from './stats.js';
import { FileError, readChatFile } from './files.js';
import { MAX_SCREENSHOTS, inTakenOrder, isImage, prepareScreenshot } from './screenshots.js';
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
import { SAMPLES } from './sample.js';
import { believableDelay, storedAnswers } from './sample-verdicts.js';

const LAB_LINE_MS = 340;
const LAB_FLICKER_MS = 110;

// The verdict often comes back in well under a second; a short minimum lets
// it land with some ceremony instead of flickering past.
const MIN_LAB_MS = 1800;

const $ = (id) => document.getElementById(id);
const chat = $('chat');
const judgeButton = $('judge');
const namesForm = $('names-form');
const consent = $('consent');
const readButton = $('read-shots');
const readNewButton = $('read-new');
const errorBox = $('error');
const lab = $('lab');
const results = $('results');

// When the format isn't recognised, the user names the people and the model
// reads the raw text instead of parsed messages.
let messages = [];
let detected = [];
let typedNames = [];
const spared = new Set();
// Journaled with each request; the sample is never kept.
let source = 'paste';
// Waiting to be read, in chat order: { file, url } with url for the thumbnail.
let screenshots = [];
let installPrompt = null;

// Kept so a language switch can redraw the results without asking again.
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
    renderScreenshots();
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
  renderScreenshots();
}

/** Forgets the last verdict and the names typed for it, before a different chat. */
function resetVerdict() {
  results.hidden = true;
  lastVerdict = null;
  typedNames = [];
  $('names').value = '';
}

/** Back to an empty page: no chat, no waiting screenshots, no verdict. */
function clearAll() {
  resetVerdict();
  screenshots.forEach(({ url }) => URL.revokeObjectURL(url));
  screenshots = [];
  chat.value = '';
  source = 'paste';
  errorBox.hidden = true;
  $('merge-note').hidden = true;
  onChatChanged();
  showNextStep($('intake'));
}

function updateClearButton() {
  $('clear').hidden = !chat.value.trim() && !screenshots.length && results.hidden;
}

async function loadFile(file) {
  errorBox.hidden = true;
  try {
    const text = await readChatFile(file);
    resetVerdict();
    chat.value = text;
    source = 'file';
    onChatChanged();
    showNextStep($('judge'));
  } catch (error) {
    showError(error instanceof FileError ? t(`errors.${error.message}`) : error.message);
  }
}

/**
 * One way in for everything people drop, paste, pick or share: screenshots
 * wait in the tray to be read together, anything else is opened as an export.
 */
function addFiles(files, { sort = true } = {}) {
  errorBox.hidden = true;
  const images = files.filter(isImage);
  const exports = files.filter((file) => !isImage(file));
  if (exports.length) loadFile(exports[0]);
  if (!images.length) return;

  const room = MAX_SCREENSHOTS - screenshots.length;
  if (images.length > room) showError(t('errors.tooManyScreenshots', { n: MAX_SCREENSHOTS }));
  const added = (sort ? inTakenOrder(images) : images).slice(0, Math.max(room, 0));
  screenshots.push(...added.map((file) => ({ file, url: URL.createObjectURL(file) })));
  renderScreenshots();
  showNextStep($('shots'));
}

/**
 * Files often arrive from elsewhere (the picker, a share from WhatsApp) while
 * the page is scrolled away, so bring what to do next into view.
 */
function showNextStep(element) {
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function removeScreenshot(index) {
  URL.revokeObjectURL(screenshots[index].url);
  screenshots.splice(index, 1);
  renderScreenshots();
}

function renderScreenshots() {
  $('shots').hidden = !screenshots.length;
  $('shot-list').replaceChildren(
    ...screenshots.map(({ url }, i) => {
      const item = document.createElement('li');
      const img = Object.assign(new Image(), { src: url, alt: t('screenshot', { n: i + 1 }) });
      const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'shot-remove', textContent: '×' });
      remove.setAttribute('aria-label', t('removeScreenshot', { n: i + 1 }));
      remove.addEventListener('click', () => removeScreenshot(i));
      item.append(img, remove);
      return item;
    }),
  );
  // With a chat already in the box, the screenshots can continue it or start
  // a new one; only the person who took them knows which.
  const choose = hasOwnChat();
  readNewButton.hidden = !choose;
  readButton.textContent = t(choose ? 'readAdd' : 'readScreenshots', { n: screenshots.length });
  updateReadButton();
  updateClearButton();
}

function updateReadButton() {
  const busy = readButton.dataset.busy === 'true';
  readButton.disabled = !screenshots.length || busy;
  readNewButton.disabled = busy;
}

/** A chat someone brought, as opposed to an empty box or our sample. */
function hasOwnChat() {
  return Boolean(chat.value.trim()) && source !== 'sample';
}

/**
 * Sending a chat anywhere needs the box ticked; our own sample doesn't.
 * Instead of a button that is greyed out for no visible reason, the box
 * itself asks to be ticked.
 */
function consented() {
  if (consent.checked) return true;
  const pledge = consent.closest('.pledge');
  pledge.classList.remove('wanted');
  // Reflow, so the nudge plays again on every click.
  void pledge.offsetWidth;
  pledge.classList.add('wanted');
  consent.focus();
  return false;
}

/** Reads the waiting screenshots into the box, after the chat there or instead of it. */
async function readTray({ add }) {
  if (!consented()) return;
  errorBox.hidden = true;
  $('merge-note').hidden = true;
  readButton.dataset.busy = 'true';
  readButton.textContent = t('readingScreenshots');
  updateReadButton();
  try {
    const images = await Promise.all(screenshots.map(({ file }) => prepareScreenshot(file)));
    const transcript = await readScreenshots(images, localDate());
    if (!transcript.trim()) throw new Error(t('errors.noChatInScreenshots'));
    const appending = add && hasOwnChat();
    const before = appending ? detected : [];
    if (appending) {
      chat.value = `${chat.value.trimEnd()}\n${transcript}`;
    } else {
      resetVerdict();
      chat.value = transcript;
    }
    source = 'screenshots';
    screenshots.forEach(({ url }) => URL.revokeObjectURL(url));
    screenshots = [];
    onChatChanged();
    // Adding to the wrong chat is easy to miss; nobody in common gives it away.
    const added = participantsOf(parseChat(transcript)).map((p) => p.name);
    if (before.length && added.length && !added.some((name) => before.includes(name))) {
      $('merge-note').hidden = false;
      $('merge-undo').onclick = () => {
        resetVerdict();
        chat.value = transcript;
        $('merge-note').hidden = true;
        onChatChanged();
      };
    }
  } catch (error) {
    showError(error.name === 'InvalidStateError' || error.name === 'EncodingError' ? t('errors.unreadableImage') : apiError(error));
  } finally {
    delete readButton.dataset.busy;
    renderScreenshots();
  }
}

/** Today in the visitor's time zone, as YYYY-MM-DD: the day of the newest screenshot. */
function localDate() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Files shared to the installed app, parked by sw.js until the page loads. */
async function takeSharedFiles() {
  if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname);
  const cache = await caches.open('judgeyou-shared');
  const files = [];
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    const name = decodeURIComponent(response.headers.get('X-File-Name') ?? 'shared');
    files.push(new File([await response.blob()], name, { type: response.headers.get('Content-Type') ?? '' }));
  }
  await caches.delete('judgeyou-shared');
  if (files.length) addFiles(files);
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
  updateJudgeButton();
}

function updateJudgeButton() {
  judgeButton.disabled = subjects().length < 2;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

// The server's limits explain themselves better than a status code would.
function apiError(error) {
  if (error.status === 429) return t('errors.tooMany');
  return error.status ? t('errors.refused', { status: error.status, reason: error.reason }) : error.message;
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
  const judged = subjects();
  const stored = storedAnswers(chat.value, judged);
  // Our own samples hold nobody's chat, so they need no consent.
  if (!stored && source !== 'sample' && !consented()) return;
  errorBox.hidden = true;
  const rawMode = isRawMode();
  const evidence = rawMode ? chat.value : messages;
  results.hidden = true;
  judgeButton.disabled = true;
  const stopLab = runLab();

  try {
    const [{ response, deletionCode }] = stored
      ? [{ response: { answers: stored }, deletionCode: null }, await wait(believableDelay())]
      : await Promise.all([askWithinLimit(evidence, judged, rawMode), wait(MIN_LAB_MS)]);
    stopLab();
    lastVerdict = {
      judged,
      ...readVerdicts(response.answers, judged),
      // Counted over the whole chat, not just the part the model could read.
      stats: rawMode ? null : chatStats(messages),
      // Counts, timing and cost are journaled on the server, not shown.
      meta: { deletionCode },
    };
    if (deletionCode) rememberKept({ code: deletionCode, at: new Date().toISOString(), people: judged.length });
    renderResults(lastVerdict);
  } catch (error) {
    stopLab();
    showError(apiError(error));
  } finally {
    updateJudgeButton();
  }
}

/**
 * The token estimate is deliberately pessimistic, but an unusual chat can
 * still exceed the model's limit; then retry once with a much smaller slice.
 */
async function askWithinLimit(evidence, judged, rawMode) {
  const ask = async (request, attempt) => {
    const context = {
      lang,
      source,
      totalMessages: rawMode ? null : messages.length,
      truncated: request.truncated,
      attempt,
    };
    // The one consent box also agrees to keeping the chat without names.
    const { payload, deletionCode } = await askJudge(request.body, { keep: true, context });
    return { request, response: payload, deletionCode };
  };
  try {
    return await ask(buildRequest(evidence, judged), 1);
  } catch (error) {
    if (error.type !== 'max_tokens_exceeded') throw error;
    return ask(buildRequest(evidence, judged, STATE_TOKEN_BUDGET / 2), 2);
  }
}

function renderKept(meta) {
  $('kept').hidden = !meta.deletionCode && !meta.forgotten;
  $('forget').hidden = Boolean(meta.forgotten);
  // Non-breaking hyphens keep the code on one line, where it can be read off.
  const code = meta.deletionCode?.replaceAll('-', '\u2011');
  $('kept-text').textContent = meta.forgotten ? t('forgotten') : t('kept', { code });
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

  renderKept(meta);

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
  updateClearButton();
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
    // The model's legend is in English; its levels are in the same order as ours.
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

chat.addEventListener('input', () => {
  source = 'paste';
  onChatChanged();
});

const intake = $('intake');
intake.addEventListener('dragover', (event) => {
  event.preventDefault();
  chat.classList.add('dragging');
});
intake.addEventListener('dragleave', (event) => {
  if (!intake.contains(event.relatedTarget)) chat.classList.remove('dragging');
});
intake.addEventListener('drop', (event) => {
  event.preventDefault();
  chat.classList.remove('dragging');
  addFiles([...event.dataTransfer.files]);
});

// Screenshots can be pasted anywhere on the page; text pastes stay normal.
document.addEventListener('paste', (event) => {
  const images = [...event.clipboardData.files].filter(isImage);
  if (!images.length) return;
  event.preventDefault();
  addFiles(images, { sort: false });
});

for (const [button, input] of [['open-file', 'file'], ['open-shots', 'shot-file']]) {
  $(button).addEventListener('click', () => $(input).click());
  $(input).addEventListener('change', () => {
    const files = [...$(input).files];
    $(input).value = '';
    addFiles(files);
  });
}

readButton.addEventListener('click', () => readTray({ add: true }));
readNewButton.addEventListener('click', () => readTray({ add: false }));
$('clear').addEventListener('click', clearAll);

// Installing is what puts JudgeYou in the share menu of WhatsApp and others.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  $('install').hidden = false;
});
$('install').addEventListener('click', async () => {
  await installPrompt?.prompt();
  installPrompt = null;
  $('install').hidden = true;
});
window.addEventListener('appinstalled', () => ($('install').hidden = true));

navigator.serviceWorker?.register('/sw.js');
takeSharedFiles();

// Each click brings the next sample; after the first, the button says so.
let nextSample = 0;
$('sample').addEventListener('click', () => {
  resetVerdict();
  chat.value = SAMPLES[nextSample].chat;
  nextSample = (nextSample + 1) % SAMPLES.length;
  source = 'sample';
  $('sample').dataset.i18n = 'sampleNext';
  $('sample').textContent = t('sampleNext');
  onChatChanged();
});

consent.addEventListener('change', () => consent.closest('.pledge').classList.remove('wanted'));

$('forget').addEventListener('click', async () => {
  const { meta } = lastVerdict;
  try {
    await forgetChat(meta.deletionCode);
    forgetKept(meta.deletionCode);
    meta.forgotten = true;
    renderKept(meta);
  } catch (error) {
    showError(apiError(error));
  }
});

judgeButton.addEventListener('click', judgeChat);

namesForm.addEventListener('submit', (event) => {
  event.preventDefault();
  typedNames = [...new Set($('names').value.split(',').map((n) => n.trim()).filter(Boolean))];
  spared.clear();
  renderSubjects();
});

