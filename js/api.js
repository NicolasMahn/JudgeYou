// Everything the page asks our server. The server holds the OpenRouter key
// and picks the models, so nothing here names one.

/**
 * Resolves to the verdict and, when the chat was kept, its deletion code.
 * `keep` and `context` are for our journal and never reach the model.
 */
export async function askJudge(request, { keep, context }) {
  const response = await post('/api/decisions', { request, keep, context });
  return { payload: await response.json(), deletionCode: response.headers.get('X-Deletion-Code') };
}

/** Deletes a kept chat; resolves to whether there was one for this code. */
export async function forgetChat(code) {
  const response = await post('/api/forget', { code });
  return (await response.json()).forgotten;
}

/** Resolves to a transcript of the screenshots (data URLs), oldest first. */
export async function readScreenshots(images, today) {
  const response = await post('/api/screenshots', { images, today });
  return (await response.json()).text;
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.ok) return response;

  const payload = await response.json().catch(() => null);
  const reason = payload?.error?.message ?? payload?.detail?.message ?? response.statusText;
  const error = new Error(`${path} failed (${response.status}): ${reason}`);
  error.status = response.status;
  error.reason = reason;
  // OpenRouter wraps the decision model's error JSON inside its message string.
  error.type = String(reason).match(/"error_type":\s*"(\w+)"/)?.[1];
  throw error;
}
