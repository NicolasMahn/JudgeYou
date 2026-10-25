const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Caps how often Jev is asked: per visitor per hour, and in total per day.
 * The daily cap bounds what a scripted abuser can cost; set the OpenRouter
 * key's own credit limit as the last line of defence. Counts live in memory,
 * so a restart resets them. Multiple replicas need shared counters first.
 */
export function createLimiter({
  perIpPerHour = Number(process.env.LIMIT_PER_IP_PER_HOUR ?? 20),
  perDay = Number(process.env.LIMIT_PER_DAY ?? 1000),
  now = Date.now,
  limits = () => ({ perIpPerHour, perDay }),
} = {}) {
  let ips = new Map();
  let hourStart = now();
  let today = { start: now(), count: 0 };

  return {
    /** Counts one request, or returns why it is refused. */
    take(ip) {
      const { perIpPerHour, perDay } = limits();
      const time = now();
      if (time - hourStart >= HOUR_MS) {
        ips = new Map();
        hourStart = time;
      }
      if (time - today.start >= DAY_MS) today = { start: time, count: 0 };

      if (today.count >= perDay) {
        return { reason: 'JudgeYou has judged enough for today.', retryAfter: seconds(today.start + DAY_MS - time) };
      }
      const used = ips.get(ip) ?? 0;
      if (used >= perIpPerHour) {
        return { reason: 'You have judged a lot this hour.', retryAfter: seconds(hourStart + HOUR_MS - time) };
      }
      ips.set(ip, used + 1);
      today.count += 1;
      return null;
    },
    snapshot() {
      const time = now();
      return { ...limits(), usedToday: time - today.start >= DAY_MS ? 0 : today.count, resetsAt: new Date(time - today.start >= DAY_MS ? time + DAY_MS : today.start + DAY_MS).toISOString() };
    },
  };
}

/** No waiting queue: overload should be quick and leave the page usable. */
export function createCapacity(limit) {
  let active = 0;
  let refused = 0;
  return {
    acquire() {
      if (active >= limit()) {
        refused++;
        return null;
      }
      active++;
      let released = false;
      return () => {
        if (!released) active--;
        released = true;
      };
    },
    snapshot: () => ({ active, maxConcurrent: limit(), refused }),
  };
}

const seconds = (ms) => Math.ceil(ms / 1000);
