// Screenshots are shrunk and re-encoded in the browser before they are sent:
// a phone's PNG screenshot is 1–3 MB, the same text as a JPEG at chat-readable
// size is a tenth of that, and smaller images also cost fewer tokens.

// Matches the server's limit in server/transcribe.js.
export const MAX_SCREENSHOTS = 10;
const MAX_WIDTH = 1080;
const MAX_HEIGHT = 2800;
const QUALITY = 0.85;

export const isImage = (file) => /^image\/(?:png|jpeg|webp|gif|heic|heif)$/.test(file.type) || /\.(?:png|jpe?g|webp|heic)$/i.test(file.name);

/**
 * Screenshot names carry the time they were taken in every common scheme
 * ("Screenshot_20261025-131500", "Screenshot 2026-10-25 at 13.15.00",
 * "IMG_1234"), so sorting by name puts a batch in chat order.
 */
export const inTakenOrder = (files) =>
  [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

/** A JPEG data URL of the screenshot, at most MAX_WIDTH × MAX_HEIGHT. */
export async function prepareScreenshot(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_WIDTH / bitmap.width, MAX_HEIGHT / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', QUALITY);
}
