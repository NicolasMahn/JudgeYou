// OpenRouter serves Jev through its (alpha) Decisions endpoint rather than
// chat completions; the request and response use TypeSafe's own format.
const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const STORAGE_KEY = 'judgeyou.openrouterKey';

// Anything else would end up in a request header, which only accepts ASCII;
// pasting a chat into the key field used to make fetch throw.
const KEY_SHAPE = /^sk-or-[\w-]+$/;

export function isApiKey(value) {
  return KEY_SHAPE.test(value);
}

/**
 * A key typed into the page wins; otherwise fall back to the optional,
 * git-ignored `key.js`, which only exists in local and deployed builds.
 */
export async function findApiKey() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && isApiKey(stored)) return stored;
  if (stored) forgetApiKey();
  try {
    return (await import('./key.js')).OPENROUTER_KEY;
  } catch {
    return null;
  }
}

export function rememberApiKey(key) {
  localStorage.setItem(STORAGE_KEY, key);
}

export function forgetApiKey() {
  localStorage.removeItem(STORAGE_KEY);
}

export async function askJev(apiKey, body) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'JudgeYou',
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = payload?.error?.message ?? payload?.detail?.message ?? response.statusText;
    const error = new Error(`Jev refused to testify (${response.status}): ${reason}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
