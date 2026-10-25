// Deletion codes for chats kept from this browser, so the privacy page can
// offer a delete button instead of asking people for a code they never noted.
// Only the code, the time and the number of people are stored, never names.

const STORAGE_KEY = 'judgeyou.kept';

/** Newest first: { code, at (ISO 8601), people }. */
export function keptChats() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function rememberKept(entry) {
  save([entry, ...keptChats()]);
}

export function forgetKept(code) {
  save(keptChats().filter((entry) => entry.code !== code));
}

function save(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}
