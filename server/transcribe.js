// Turns chat screenshots into a transcript the page's parser already reads.
// The prompt lives here, not in the page, so our key only ever buys
// transcripts and can't be used as a general-purpose vision model.

const UPSTREAM = 'https://openrouter.ai/api/v1/chat/completions';
export const MAX_SCREENSHOTS = 10;
// Tall phone screenshots, re-encoded by the page, are 100–400 KB each.
export const MAX_SCREENSHOT_BYTES = 1.5 * 1024 * 1024;
// A screenshot holds at most ~40 messages, well under this. Models that
// start repeating themselves would otherwise run to their own limit.
const OUTPUT_TOKENS_PER_SCREENSHOT = 1500;
const DATA_URL = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Small models read well but get confused when also asked to work out dates,
// so they only copy times; datedTranscript adds the days afterwards.
const PROMPT = `These are screenshots of one group chat, oldest first. Consecutive screenshots overlap; write each message only once.
Transcribe every message as one line: "HH:MM - Author: text". Rules:
- Author is the coloured name above a bubble. A bubble without a name belongs to the author of the bubble above it.
- If a message has no visible time, use the time of the next message that has one.
- Pictures, videos and stickers: write <Media omitted>. Deleted messages: write "This message was deleted".
- Ignore quoted reply previews, reactions, "Edited" labels and UI buttons.
Output only the lines, nothing else.`;

export class TranscribeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Why a request can't be transcribed, or null when it can. */
export function invalidScreenshots(request) {
  const images = request?.images;
  if (!Array.isArray(images) || images.length === 0) return 'Send at least one screenshot.';
  if (images.length > MAX_SCREENSHOTS) return `Send at most ${MAX_SCREENSHOTS} screenshots at once.`;
  if (!images.every((image) => typeof image === 'string' && DATA_URL.test(image))) return 'Screenshots must be JPEG, PNG or WebP.';
  if (images.some((image) => image.length * 0.75 > MAX_SCREENSHOT_BYTES)) return 'A screenshot is too big.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.today ?? '')) return 'Send today’s date as YYYY-MM-DD.';
  return null;
}

/** `post` sends a chat completion to OpenRouter; tests replace it. */
export function createTranscriber({ key, model, post = (body) => postJson(UPSTREAM, key, body) }) {
  return async function transcribe({ images, today }) {
    const answer = await post({
      model,
      temperature: 0,
      max_tokens: OUTPUT_TOKENS_PER_SCREENSHOT * images.length,
      // Copying text needs no thinking; reasoning only costs time and tokens.
      reasoning: { enabled: false },
      usage: { include: true },
      // Only providers that neither keep nor train on what they are sent.
      provider: { data_collection: 'deny' },
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: PROMPT }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))],
        },
      ],
    });
    const choice = answer.choices?.[0];
    // A cut-off answer means the model got stuck repeating itself.
    if (!choice || choice.finish_reason === 'length') throw new TranscribeError(502, 'The screenshots could not be read.');
    return { text: datedTranscript(choice.message?.content ?? '', today), model: answer.model, cost: answer.usage?.cost };
  };
}

const TIMED = /^(\d{1,2})[:.](\d{2})\s*[-–—]\s*(.+)$/;
// "4m - Ana: hi" or "— Ana: hi": a stamp that isn't a time, before an author.
const UNTIMED = /^[^:]{0,12}?\s?[-–—]\s(?=[^:]{1,50}:\s)/;

/**
 * Screenshots rarely show dates, but a time earlier than the one before it
 * means a new day began. Counting those back from today, the day the newest
 * message was sent, gives every message a full date so reply times work.
 * Days without messages in between can't be seen and are skipped.
 */
export function datedTranscript(text, today) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('```'));

  let minutes = null;
  let day = 0;
  const read = lines.map((line) => {
    const timed = TIMED.exec(line);
    if (timed) {
      const next = Number(timed[1]) * 60 + Number(timed[2]);
      if (minutes !== null && next < minutes) day++;
      minutes = next;
      return { minutes, day, message: timed[3] };
    }
    // Without a time of its own, a message shares the previous one's.
    if (UNTIMED.test(line)) return { minutes, day, message: line.replace(UNTIMED, '') };
    return { continuation: line };
  });

  const newest = Date.parse(`${today}T00:00:00Z`);
  return read
    .map((line) => {
      if (line.continuation !== undefined) return line.continuation;
      if (line.minutes === null) return line.message;
      const date = new Date(newest - (day - line.day) * DAY_MS).toISOString().slice(0, 10);
      const time = `${String(Math.floor(line.minutes / 60)).padStart(2, '0')}:${String(line.minutes % 60).padStart(2, '0')}`;
      return `${date}, ${time} - ${line.message}`;
    })
    .join('\n');
}

async function postJson(url, key, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'JudgeYou' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new TranscribeError(response.status === 429 ? 429 : 502, payload.error?.message ?? response.statusText);
  return payload;
}
