import { createScrubber, judgedIn, namesIn } from './scrub.js';
import { seal } from './seal.js';
import { createVisitorIds, deletionCode, hash, resultId } from './store.js';

const SOURCES = new Set(['paste', 'file', 'screenshots', 'sample']);

/**
 * Writes one row per forwarded request. A failing write is logged and
 * otherwise ignored: losing a row is better than losing someone's verdict.
 */
export function createJournal({ store, publicKey, visitorId = createVisitorIds(), now = () => new Date() }) {
  return {
    /**
     * Returns `deletionCode` when the chat was kept and `resultId` for every
     * verdict, so it can be reopened from a share link; either may be null.
     */
    write({ ip, request, context, keep, status, ms, payload }) {
      try {
        const scrub = createScrubber(namesIn(request));
        const kept = keep && status === 200 && context.source !== 'sample';
        const code = kept ? deletionCode() : null;
        const id = status === 200 && payload?.answers ? resultId() : null;
        const people = judgedIn(request).length;
        store.record({
          at: now().toISOString(),
          visitor: visitorId(ip),
          lang: shortText(context.lang),
          source: SOURCES.has(context.source) ? context.source : null,
          raw: Number(typeof request.state.transcript === 'string'),
          people,
          messagesSent: Array.isArray(request.state.messages) ? request.state.messages.length : null,
          messagesTotal: count(context.totalMessages),
          truncated: Number(context.truncated === true),
          attempt: count(context.attempt) ?? 1,
          status,
          ms,
          model: shortText(payload?.model),
          cost: typeof payload?.usage?.cost === 'number' ? payload.usage.cost : null,
          answers: payload?.answers ? JSON.stringify(scrub(payload.answers)) : null,
          chat: kept ? seal(JSON.stringify(scrub(request)), publicKey) : null,
          deletionHash: code && hash(code),
          resultId: id,
          stats: id ? JSON.stringify(countedStats(context.stats, people)) : null,
        });
        return { deletionCode: code, resultId: id };
      } catch (error) {
        console.error('Could not record a judgment:', error);
        return { deletionCode: null, resultId: null };
      }
    },
    forget: (code) => store.forget(code),
    result: (id) => store.result(id),
  };
}

/**
 * The page's counted numbers per judged person, in judging order. They come
 * from the visitor, so only the expected numbers are kept: no names, no text.
 */
function countedStats(stats, people) {
  if (!Array.isArray(stats) || stats.length !== people) return null;
  const pair = (value, a, b) => (value && count(value[a]) !== null && number(value[b]) !== null ? { [a]: number(value[a]), [b]: number(value[b]) } : null);
  return stats.map((person) =>
    person && typeof person === 'object'
      ? {
          messages: count(person.messages),
          medianWords: number(person.medianWords),
          reply: pair(person.reply, 'n', 'median'),
          starts: pair(person.starts, 'count', 'of'),
        }
      : null,
  );
}

const number = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
const shortText = (value) => (typeof value === 'string' ? value.slice(0, 64) : null);
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
