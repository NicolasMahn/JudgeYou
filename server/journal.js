import { createScrubber, namesIn } from './scrub.js';
import { seal } from './seal.js';
import { createVisitorIds, deletionCode, hash } from './store.js';

const SOURCES = new Set(['paste', 'file', 'screenshots', 'sample']);

/**
 * Writes one row per forwarded request. A failing write is logged and
 * otherwise ignored: losing a row is better than losing someone's verdict.
 */
export function createJournal({ store, publicKey, visitorId = createVisitorIds(), now = () => new Date() }) {
  return {
    /** Returns the deletion code when the chat was kept, otherwise null. */
    write({ ip, request, context, keep, status, ms, payload }) {
      try {
        const scrub = createScrubber(namesIn(request));
        const kept = keep && status === 200 && context.source !== 'sample';
        const code = kept ? deletionCode() : null;
        store.record({
          at: now().toISOString(),
          visitor: visitorId(ip),
          lang: shortText(context.lang),
          source: SOURCES.has(context.source) ? context.source : null,
          raw: Number(typeof request.state.transcript === 'string'),
          people: Object.keys(request.questions.culprit?.criteria ?? {}).length,
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
        });
        return code;
      } catch (error) {
        console.error('Could not record a judgment:', error);
        return null;
      }
    },
    forget: (code) => store.forget(code),
  };
}

const shortText = (value) => (typeof value === 'string' ? value.slice(0, 64) : null);
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
