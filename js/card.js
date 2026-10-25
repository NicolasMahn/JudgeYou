// The shareable verdict: one portrait image, drawn on a canvas so it can be
// downloaded or handed to the phone's share sheet. It shows names, types and
// counts, never chat text, and names can be changed before anything leaves.
import { t } from './i18n.js';
import { duoName, duoNote, mascotOf, severityLabel, typeName } from './presentation.js';

const WIDTH = 1080;
const HEIGHT = 1350;
const MARGIN = 72;
const PHONE_NUMBER = /^[+\d][\d\s()./-]{5,}$/;

const $ = (id) => document.getElementById(id);
const images = new Map();

/** First names only, and no phone numbers, unless the user types them in. */
function defaultNames(names) {
  let unknown = 0;
  return names.map((name) =>
    PHONE_NUMBER.test(name) ? t('unknownNumber', { n: ++unknown }) : name.split(/\s+/)[0],
  );
}

/**
 * `verdict` holds `suspects` (one or two names, none when the case is
 * dismissed) with their `strength` (see convict), `people` ({ name, type, menace, severity })
 * and `records` ({ key, name, detail }), all with real names, `duo` (a duo
 * key for two people, else null), and `link`, which turns the names shown on
 * the card into a link back to this verdict.
 */
export function openCard(verdict) {
  const dialog = $('card-dialog');
  const canvas = $('card-canvas');
  const names = verdict.people.map((p) => p.name);
  const defaults = defaultNames(names);
  const shown = new Map(names.map((name, i) => [name, defaults[i]]));

  const redraw = () => drawCard(canvas, verdict, (name) => shown.get(name) || name);
  $('card-names').replaceChildren(
    ...verdict.people.map(({ name }) => {
      const input = document.createElement('input');
      input.value = shown.get(name);
      input.setAttribute('aria-label', name);
      input.addEventListener('input', () => {
        shown.set(name, input.value.trim());
        redraw();
      });
      return input;
    }),
  );

  // The link carries the names as shown on the card, so edits travel with it.
  const link = () => verdict.link(names.map((name) => shown.get(name) || name));
  // The punchline, then the link: chat apps show text next to the image.
  const shownOf = (name) => shown.get(name) || name;
  const { suspects, strength } = verdict;
  const typeOf = (name) => typeName(verdict.people.find((p) => p.name === name).type);
  const punchline = () => {
    if (verdict.duo) return t('duoShareText', { names: names.map(shownOf).join(' & '), type: duoName(verdict.duo) });
    if (strength === 'dismissed') return t('nobodyShareText');
    if (suspects.length === 2) {
      return t(strength === 'guilty' ? 'suspectsShareText' : 'interestsShareText', { names: suspects.map(shownOf).join(' & ') });
    }
    const vars = { name: shownOf(suspects[0]), type: typeOf(suspects[0]) };
    return t(strength === 'guilty' ? 'cardShareText' : 'interestShareText', vars);
  };
  // The message usually goes back into the chat it judged, so it points to
  // the whole verdict and to judging another chat, not asking "what about you?".
  const message = () => `${punchline()}\n${t('shareTail')} ${link()}`;

  $('card-share').hidden = !navigator.canShare?.({ files: [new File([], 'x.png', { type: 'image/png' })] });
  $('card-share').onclick = async () => {
    try {
      await navigator.share({ files: [await asFile(canvas)], text: message() });
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  };
  $('card-copy').textContent = t('cardCopy');
  $('card-copy').onclick = async () => {
    await navigator.clipboard.writeText(link());
    $('card-copy').textContent = t('cardCopied');
  };
  $('card-download').onclick = async () => {
    const link = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(await asFile(canvas)),
      download: 'judgeyou.png',
    });
    link.click();
    URL.revokeObjectURL(link.href);
  };

  redraw();
  dialog.showModal();
}

async function asFile(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new File([blob], 'judgeyou.png', { type: 'image/png' });
}

// The site, not the current page: the share link travels in the message.
const pageUrl = () => location.host;

function image(src) {
  if (!images.has(src)) {
    const img = new Image();
    img.src = src;
    images.set(src, img.decode().then(() => img));
  }
  return images.get(src);
}

// Waiting for fonts and images makes drawing async; typing a name starts a
// new draw, and an older one that finishes late must not paint over it.
let drawing = 0;

async function drawCard(canvas, { suspects, strength, duo, people, records }, shownName) {
  const ticket = ++drawing;
  const style = getComputedStyle(document.documentElement);
  const token = (name) => style.getPropertyValue(name).trim();
  const color = { paper: token('--paper'), ink: token('--ink'), soft: token('--ink-soft'), muted: token('--ink-muted'), rule: token('--rule'), accent: token('--accent') };
  const display = (weight, size, italic = '') => `${italic} ${weight} ${size}px ${token('--font-display')}`;
  const body = (weight, size) => `${weight} ${size}px ${token('--font-body')}`;
  const mono = (weight, size) => `${weight} ${size}px ${token('--font-mono')}`;

  const [mascots] = await Promise.all([
    Promise.all(people.map((p) => image(mascotOf(p.type)))),
    document.fonts.load(display(800, 96)),
    document.fonts.load(display(700, 44, 'italic')),
    document.fonts.load(body(600, 30)),
    document.fonts.load(mono(500, 20)),
  ]);
  if (ticket !== drawing) return;

  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  const inner = WIDTH - 2 * MARGIN;
  ctx.fillStyle = color.paper;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.textBaseline = 'alphabetic';

  const text = (value, x, y, font, fill, maxWidth, align = 'left') => {
    ctx.font = font;
    ctx.fillStyle = fill;
    ctx.textAlign = align;
    ctx.fillText(clip(ctx, value, maxWidth), x, y);
  };
  const rule = (y, weight = 1, fill = color.ink) => {
    ctx.fillStyle = fill;
    ctx.fillRect(MARGIN, y, inner, weight);
  };

  // Masthead
  text('JudgeYou', MARGIN, 96, display(700, 44, 'italic'), color.ink, 300);
  text(t('cardTagline').toUpperCase(), WIDTH - MARGIN, 92, mono(500, 18), color.muted, inner - 320, 'right');
  rule(120, 3);
  rule(127);

  const indexOf = (name) => people.findIndex((p) => p.name === name);
  const pair = suspects?.length === 2;
  const kicker = duo ? 'duo' : { guilty: pair ? 'suspects' : 'suspect', interest: pair ? 'interests' : 'interest', dismissed: 'suspect' }[strength];
  const stampWord = duo ? 'duoStamp' : { guilty: pair ? 'bothGuilty' : 'guilty', interest: 'observed' }[strength];

  if (duo || pair) {
    // Two specimens side by side: the duo, or two people sharing the verdict.
    const [a, b] = duo ? [0, 1] : suspects.map(indexOf);
    ctx.drawImage(mascots[a], MARGIN - 30, 160, 250, 250);
    ctx.drawImage(mascots[b], MARGIN + 150, 160, 250, 250);
    const textX = MARGIN + 420;
    const textWidth = WIDTH - MARGIN - textX;
    const both = `${shownName(people[a].name)} & ${shownName(people[b].name)}`;
    text(t(kicker).toUpperCase(), textX, 240, mono(500, 22), color.accent, textWidth);
    const bothSize = fitSize(ctx, both, (s) => display(800, s), 84, textWidth);
    text(both, textX, 325, display(800, bothSize), color.ink, textWidth);
    const what = duo ? duoName(duo) : `${typeName(people[a].type)} & ${typeName(people[b].type)}`;
    text(what, textX, 378, body(600, duo ? 32 : 26), color.soft, textWidth);
    if (duo) {
      ctx.font = display(400, 24, 'italic');
      lines(ctx, duoNote(duo), textWidth, 2).forEach((line, n) => text(line, textX, 420 + n * 30, ctx.font, color.soft, textWidth));
    }
    stamp(ctx, t(stampWord).toUpperCase(), MARGIN + 190, 455, mono(600, 30), color);
  } else if (strength === 'dismissed') {
    // Case dismissed: no specimen to show, so the verdict takes the width.
    text(t('suspect').toUpperCase(), MARGIN, 250, mono(500, 22), color.accent, inner);
    text(t('nobody'), MARGIN, 350, display(800, 104), color.ink, inner);
    text(t('peaceful'), MARGIN, 405, body(600, 34), color.soft, inner);
    stamp(ctx, t('dismissed').toUpperCase(), WIDTH - MARGIN - 190, 330, mono(600, 30), color);
  } else {
    // One prime suspect, or one person of interest.
    const [suspect] = suspects;
    ctx.drawImage(mascots[indexOf(suspect)], MARGIN - 20, 150, 330, 330);
    const textX = MARGIN + 340;
    const textWidth = WIDTH - MARGIN - textX;
    text(t(kicker).toUpperCase(), textX, 250, mono(500, 22), color.accent, textWidth);
    const suspectSize = fitSize(ctx, shownName(suspect), (s) => display(800, s), 104, textWidth);
    text(shownName(suspect), textX, 350, display(800, suspectSize), color.ink, textWidth);
    text(typeName(people[indexOf(suspect)].type), textX, 405, body(600, 34), color.soft, textWidth);
    stamp(ctx, t(stampWord).toUpperCase(), WIDTH - MARGIN - 170, 455, mono(600, 30), color);
  }

  // Records: the counted facts, next to Jev's opinions.
  let y = 510;
  rule(y);
  if (records.length) {
    const shownRecords = records.slice(0, 3);
    const column = inner / shownRecords.length;
    shownRecords.forEach((record, i) => {
      const x = MARGIN + i * column;
      const width = column - 24;
      text(t(`records.${record.key}.title`).toUpperCase(), x, y + 44, mono(500, 17), color.muted, width);
      text(shownName(record.name), x, y + 90, display(700, 38), color.ink, width);
      ctx.font = body(400, 18);
      lines(ctx, record.detail, width, 2).forEach((line, n) => text(line, x, y + 122 + n * 24, ctx.font, color.soft, width));
    });
    y += 176;
    rule(y);
  }

  // Everyone else, one row each.
  const bottom = HEIGHT - 110;
  // Few people get bigger rows, so a duo's card isn't half empty.
  const rowHeight = Math.min(people.length <= 2 ? 200 : 140, (bottom - y - 10) / people.length);
  people.forEach((person, i) => {
    const top = y + 10 + i * rowHeight;
    const middle = top + rowHeight / 2;
    const size = rowHeight - 12;
    ctx.drawImage(mascots[i], MARGIN - 8, top + 6, size, size);
    const nameSize = Math.min(44, rowHeight * 0.36);
    text(shownName(person.name), MARGIN + size + 16, middle + 2, display(700, nameSize), color.ink, inner - size - 200);
    text(typeName(person.type), MARGIN + size + 16, middle + 6 + nameSize * 0.8, body(500, nameSize * 0.6), color.soft, inner - size - 200);
    text(String(person.menace), WIDTH - MARGIN, middle + nameSize * 0.45, display(800, nameSize * 1.25), color.ink, 160, 'right');
    text(severityLabel(person.severity).toUpperCase(), WIDTH - MARGIN, middle + nameSize * 0.45 + 28, mono(500, 18), color.accent, 260, 'right');
    if (i < people.length - 1) rule(top + rowHeight, 1, color.rule);
  });

  // Footer
  rule(HEIGHT - 86, 3);
  text(pageUrl(), MARGIN, HEIGHT - 40, mono(500, 22), color.ink, inner / 2);
  text(t('menace').toUpperCase(), WIDTH - MARGIN, HEIGHT - 40, mono(500, 18), color.muted, inner / 2, 'right');
}

/** The largest size up to `size` at which `value` fits `maxWidth`, down to half of it. */
function fitSize(ctx, value, font, size, maxWidth) {
  const smallest = Math.round(size / 2);
  for (; size > smallest; size -= 4) {
    ctx.font = font(size);
    if (ctx.measureText(value).width <= maxWidth) return size;
  }
  return smallest;
}

/** Word-wrapped lines for the current font; the last one is clipped if needed. */
function lines(ctx, value, maxWidth, maxLines) {
  const result = [''];
  for (const word of value.split(' ')) {
    const candidate = result.at(-1) ? `${result.at(-1)} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !result.at(-1)) result[result.length - 1] = candidate;
    else if (result.length < maxLines) result.push(word);
    else {
      result[result.length - 1] = candidate;
      break;
    }
  }
  return result;
}

function clip(ctx, value, maxWidth) {
  if (ctx.measureText(value).width <= maxWidth) return value;
  let cut = value;
  while (cut && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

function stamp(ctx, label, x, y, font, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((-11 * Math.PI) / 180);
  ctx.globalAlpha = 0.88;
  ctx.font = font;
  const width = ctx.measureText(label).width + 44;
  ctx.strokeStyle = color.accent;
  ctx.lineWidth = 5;
  ctx.strokeRect(-width / 2, -30, width, 60);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-width / 2 + 7, -23, width - 14, 46);
  ctx.fillStyle = color.accent;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, 2);
  ctx.restore();
}
