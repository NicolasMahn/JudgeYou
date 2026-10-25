import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';

const FIELDS = {
  decisions: { perIpPerHour: [0, 100_000], perDay: [0, 1_000_000], maxConcurrent: [1, 512] },
  screenshots: { perIpPerHour: [0, 100_000], perDay: [0, 1_000_000], maxConcurrent: [1, 64] },
  timeoutMs: [1000, 120_000],
};

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must be an object.');
  const result = {};
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(FIELDS, key)) throw new Error(`Unknown setting: ${key}`);
  }
  for (const [key, fields] of Object.entries(FIELDS)) {
    if (Array.isArray(fields)) {
      result[key] = integer(value[key], fields, key);
      continue;
    }
    const group = value[key];
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error(`Missing settings: ${key}`);
    for (const field of Object.keys(group)) {
      if (!Object.hasOwn(fields, field)) throw new Error(`Unknown setting: ${key}.${field}`);
    }
    result[key] = Object.fromEntries(Object.entries(fields).map(([field, range]) => [field, integer(group[field], range, `${key}.${field}`)]));
  }
  return result;
}

function integer(value, [min, max], name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

/** Saved settings override environment defaults; changes apply without a restart. */
export function createSettings({ file = null, env = process.env } = {}) {
  const setting = (name, fallback) => {
    if (env[name] === undefined) return fallback;
    if (String(env[name]).trim() === '') throw new Error(`${name} must be a number.`);
    return Number(env[name]);
  };
  let current = validate({
    decisions: {
      perIpPerHour: setting('LIMIT_PER_IP_PER_HOUR', 20),
      perDay: setting('LIMIT_PER_DAY', 1000),
      maxConcurrent: setting('MAX_CONCURRENT_DECISIONS', 32),
    },
    screenshots: {
      perIpPerHour: setting('SCREENSHOT_LIMIT_PER_IP_PER_HOUR', setting('LIMIT_PER_IP_PER_HOUR', 20)),
      perDay: setting('SCREENSHOT_LIMIT_PER_DAY', setting('LIMIT_PER_DAY', 1000)),
      maxConcurrent: setting('MAX_CONCURRENT_SCREENSHOTS', 4),
    },
    timeoutMs: setting('UPSTREAM_TIMEOUT_MS', 30_000),
  });
  if (file) {
    try {
      current = validate(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  let pending = Promise.resolve();
  return {
    get: () => structuredClone(current),
    async update(value) {
      const next = validate(value);
      // Serialize writes so concurrent dashboard saves cannot reorder disk and memory.
      const save = pending.then(async () => {
        if (file) {
          await writeFile(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
          await rename(`${file}.tmp`, file);
        }
        current = next;
        return structuredClone(current);
      });
      pending = save.catch(() => {});
      return save;
    },
  };
}
