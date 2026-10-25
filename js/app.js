import { parseChat, participantsOf } from './parse.js';
import { buildRequest, readVerdicts, MAX_SUBJECTS, MIN_MESSAGES_TO_JUDGE, NOBODY, STATE_TOKEN_BUDGET } from './questions.js';
import { askJudge, forgetChat, readScreenshots } from './api.js';
import { forgetKept, rememberKept } from './kept.js';
import { assignTypes, convict, countedEffort, menaceIndex, normalisedScore, severityOf } from './verdict.js';
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
  duoName,
  duoNote,
} from './presentation.js';
import { SAMPLES } from './sample.js';
import { believableDelay, storedAnswers } from './sample-verdicts.js';
import { loadShared, shareLink, sharedId } from './share.js';

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
// True while screenshots are being read, before the judging starts.
let reading = false;
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
  document.body.classList.remove('is-shared');
  // A shared verdict's address would bring it back on reload.
  if (sharedId()) history.replaceState(null, '', '/');
  screenshots.forEach(({ url }) => URL.revokeObjectURL(url));
  screenshots = [];
  chat.value = '';
  source = 'paste';
  errorBox.hidden = true;
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
  // The screenshots, and below them the box to tick and the button to press.
  $('shots').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      item.style.setProperty('--i', i);
      item.append(img, remove);
      return item;
    }),
  );
  updateJudgeButton();
  updateClearButton();
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

/**
 * Reads the waiting screenshots into the box, then judges straight away:
 * one button for the whole thing. Screenshots that share people with the
 * chat already there continue it; otherwise they are a new chat.
 */
async function judgeScreenshots() {
  if (!consented()) return;
  errorBox.hidden = true;
  reading = true;
  $('shots').classList.add('is-reading');
  judgeButton.textContent = t('readingScreenshots');
  updateJudgeButton();
  try {
    const images = await Promise.all(screenshots.map(({ file }) => prepareScreenshot(file)));
    const transcript = await readScreenshots(images, localDate());
    if (!transcript.trim()) throw new Error(t('errors.noChatInScreenshots'));
    const added = participantsOf(parseChat(transcript)).map((p) => p.name);
    const continues = hasOwnChat() && added.some((name) => detected.includes(name));
    resetVerdict();
    chat.value = continues ? `${chat.value.trimEnd()}\n${transcript}` : transcript;
    source = 'screenshots';
    screenshots.forEach(({ url }) => URL.revokeObjectURL(url));
    screenshots = [];
    onChatChanged();
  } catch (error) {
    showError(error.name === 'InvalidStateError' || error.name === 'EncodingError' ? t('errors.unreadableImage') : apiError(error));
    return;
  } finally {
    reading = false;
    $('shots').classList.remove('is-reading');
    judgeButton.textContent = t('judge');
    renderScreenshots();
  }
  // Too few people found leaves the names form or the chat to fix by hand.
  if (!judgeButton.disabled) judgeChat();
}

/** Today in the visitor's time zone, as YYYY-MM-DD: the day of the newest screenshot. */
function localDate() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A verdict opened from a share link: /v/<id>#names. */
async function showSharedVerdict() {
  const id = sharedId();
  if (!id) return;
  // Someone sent a verdict: show it first, not an empty box to fill.
  document.body.classList.add('is-shared');
  const shared = await loadShared(id).catch(() => null);
  if (!shared) {
    document.body.classList.remove('is-shared');
    history.replaceState(null, '', '/');
    showError(t('errors.sharedMissing'));
    return;
  }
  if (shared.chat) {
    chat.value = shared.chat;
    source = 'sample';
    onChatChanged();
  }
  lastVerdict = {
    judged: shared.subjects,
    ...readVerdicts(shared.answers, shared.subjects),
    stats: shared.stats,
    meta: { resultId: shared.sampleId ? null : id, sampleId: shared.sampleId ?? null, shared: true },
  };
  renderResults(lastVerdict, { scroll: false });
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

// Waiting screenshots are judged too: they're read first (judgeScreenshots).
function updateJudgeButton() {
  const chatReady = subjects().length >= 2 && (isRawMode() || messages.length >= MIN_MESSAGES_TO_JUDGE);
  judgeButton.disabled = reading || !(screenshots.length || chatReady);
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
  // Counted over the whole chat, not just the part the model could read.
  const stats = rawMode ? null : chatStats(messages);
  results.hidden = true;
  judgeButton.disabled = true;
  const stopLab = runLab();

  try {
    const [{ response, deletionCode = null, resultId = null }] = stored
      ? [{ response: { answers: stored.answers } }, await wait(believableDelay())]
      : await Promise.all([askWithinLimit(evidence, judged, rawMode, stats), wait(MIN_LAB_MS)]);
    stopLab();
    lastVerdict = {
      judged,
      ...readVerdicts(response.answers, judged),
      stats,
      // Counts, timing and cost are journaled on the server, not shown.
      meta: { deletionCode, resultId, sampleId: stored?.sampleId ?? null },
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
async function askWithinLimit(evidence, judged, rawMode, stats) {
  const ask = async (request, attempt) => {
    const context = {
      lang,
      source,
      totalMessages: rawMode ? null : messages.length,
      truncated: request.truncated,
      attempt,
      // In judging order, without names, so a share link can show them again.
      stats: stats && judged.map((name) => stats.get(name) ?? null),
    };
    // The one consent box also agrees to keeping the chat without names.
    const { payload, deletionCode, resultId } = await askJudge(request.body, { keep: true, context });
    return { request, response: payload, deletionCode, resultId };
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

function barRow(label, probability, value = percent(probability)) {
  const row = fromTemplate('bar-row');
  row.querySelector('.who').textContent = label;
  row.querySelector('.value').textContent = value;
  row.querySelector('.fill').dataset.width = percent(probability);
  return row;
}

function renderResults({ judged, culprit, duo, people, stats, meta }, { scroll = true } = {}) {
  const types = assignTypes(people.map((p) => p.answers.type));
  const isDuo = judged.length === 2 && Boolean(duo?.choice);
  const menaces = people.map((p) => menaceIndex(p.answers));
  const verdict = convict(culprit, people.map(({ name }, i) => ({ name, menace: menaces[i] })), NOBODY);
  if (isDuo) renderDuo(duo, judged, types, stats);
  else renderSuspect(culprit, verdict, judged, types, menaces);

  const records = stats ? recordsOf(stats, judged) : [];
  $('records').replaceChildren(...records.map(record));
  $('records').hidden = !records.length;

  $('plates').replaceChildren(...people.map((person, i) => plate(person, i, types[i], stats?.get(person.name))));

  renderKept(meta);

  $('own-chat-invite').hidden = !meta.shared;
  $('share').onclick = () =>
    openCard({
      link: (names) => shareLink(meta, names),
      duo: isDuo ? duo.choice : null,
      suspects: verdict.choices,
      strength: verdict.strength,
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

/**
 * The head of the verdict for a group: one or two prime suspects, one or two
 * persons of interest, or nobody (see convict).
 */
function renderSuspect(culprit, { choices, strength }, judged, types, menaces) {
  const pair = choices.length === 2;
  const typeOf = (name) => types[judged.indexOf(name)].type;
  $('suspect').classList.toggle('is-pair', pair);
  $('suspect').classList.toggle('is-dismissed', strength === 'dismissed');
  $('suspect-mascot').hidden = strength === 'dismissed';
  $('duo-mascot').hidden = !pair;
  $('suspect-note').hidden = true;
  if (choices[0]) $('suspect-mascot').src = mascotOf(typeOf(choices[0]));
  if (pair) $('duo-mascot').src = mascotOf(typeOf(choices[1]));

  const kicker = { guilty: pair ? 'suspects' : 'suspect', interest: pair ? 'interests' : 'interest', dismissed: 'suspect' };
  const stamp = { guilty: pair ? 'bothGuilty' : 'guilty', interest: 'observed', dismissed: 'dismissed' };
  $('suspect-kicker').textContent = t(kicker[strength]);
  $('suspect-stamp').textContent = t(stamp[strength]);
  $('suspect-name').textContent = strength === 'dismissed' ? t('nobody') : choices.join(' & ');

  const p = (name) => (culprit.probabilities?.[name] ?? 0).toFixed(2);
  const types2 = choices.map((name) => typeName(typeOf(name))).join(' & ');
  $('suspect-stat').textContent =
    strength === 'dismissed'
      ? t('peacefulStat', { p: p(NOBODY), confidence: culprit.confidence.toFixed(2) })
      : strength === 'interest'
        ? t('interestStat', { type: types2, m: choices.map((name) => menaces[judged.indexOf(name)]).join(' & ') })
        : pair
          ? `${types2} · p = ${choices.map(p).join(' & ')}`
          : t('suspectStat', { type: types2, p: p(choices[0]), confidence: culprit.confidence.toFixed(2) });

  // A person of interest is picked by Menace Index, so that is what the bars show.
  $('suspect-bars').replaceChildren(
    ...(strength === 'interest'
      ? [Object.assign(document.createElement('p'), { className: 'bars-label', textContent: t('menace') }),
         ...judged.map((name, i) => barRow(name, menaces[i] / 100, String(menaces[i])))]
      : [...judged, NOBODY].map((name) => barRow(name === NOBODY ? t('nobody') : name, culprit.probabilities?.[name] ?? 0))),
  );
}

/** Two people: a verdict on the pair, and who carries the chat, counted. */
function renderDuo(duo, judged, types, stats) {
  $('suspect').classList.add('is-pair');
  $('suspect').classList.remove('is-dismissed');
  $('suspect-mascot').hidden = false;
  $('duo-mascot').hidden = false;
  $('suspect-mascot').src = mascotOf(types[0].type);
  $('duo-mascot').src = mascotOf(types[1].type);
  $('suspect-kicker').textContent = t('duo');
  $('suspect-stamp').textContent = t('duoStamp');
  $('suspect-name').textContent = `${judged[0]} & ${judged[1]}`;
  $('suspect-stat').textContent = `${duoName(duo.choice)} · p = ${(duo.probabilities?.[duo.choice] ?? 0).toFixed(2)}`;
  $('suspect-note').textContent = duoNote(duo.choice);
  $('suspect-note').hidden = false;

  const counts = judged.map((name) => stats?.get(name)?.messages ?? 0);
  const total = counts[0] + counts[1];
  $('suspect-bars').replaceChildren(
    ...(total
      ? [Object.assign(document.createElement('p'), { className: 'bars-label', textContent: t('duoShare') }),
         ...judged.map((name, i) => barRow(name, counts[i] / total))]
      : []),
  );
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

  const measured = (key) => (key === 'effort' ? countedEffort(counts) : answers[key]);
  card.querySelector('.measures').append(...TRAIT_KEYS.filter(measured).map((key) => scale(key, measured(key))));

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
  meter.querySelector('.scale-confidence').textContent = answer.counted
    ? t('countedLevel', { n: answer.counted })
    : t('confidence', { c: answer.confidence.toFixed(2) });
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

$('clear').addEventListener('click', clearAll);
$('own-chat').addEventListener('click', clearAll);
$('own-chat-top').addEventListener('click', clearAll);

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
showSharedVerdict();

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

judgeButton.addEventListener('click', () => (screenshots.length ? judgeScreenshots() : judgeChat()));

namesForm.addEventListener('submit', (event) => {
  event.preventDefault();
  typedNames = [...new Set($('names').value.split(',').map((n) => n.trim()).filter(Boolean))];
  spared.clear();
  renderSubjects();
});

