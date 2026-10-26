export const DRAFT_KEY = 'judgeyou.draft';

function validSnapshot(value) {
  return value !== null && typeof value === 'object'
    && typeof value.text === 'string'
    && typeof value.names === 'string'
    && [value.selectedNames, value.spared].every((names) =>
      Array.isArray(names) && [...names].every((name) => typeof name === 'string'))
    && Number.isInteger(value.screenshotCount)
    && value.screenshotCount >= 0 && value.screenshotCount <= 10;
}

function copySnapshot({ text, names, selectedNames, spared, screenshotCount }) {
  return { text, names, selectedNames: [...selectedNames], spared: [...spared], screenshotCount };
}

export function createDraftStore(getStorage = () => sessionStorage) {
  function clear() {
    try {
      getStorage().removeItem(DRAFT_KEY);
      return true;
    } catch {
      return false;
    }
  }

  return {
    read() {
      try {
        const stored = getStorage().getItem(DRAFT_KEY);
        if (stored === null) return null;
        const value = JSON.parse(stored);
        if (!validSnapshot(value) || !Object.hasOwn(value, 'version')
          || value.version !== 1 || Object.keys(value).length !== 6) {
          clear();
          return null;
        }
        return copySnapshot(value);
      } catch {
        clear();
        return null;
      }
    },

    write(snapshot) {
      try {
        if (!validSnapshot(snapshot)) {
          clear();
          return false;
        }
        if (!snapshot.text.trim() && snapshot.screenshotCount === 0) return clear();
        getStorage().setItem(DRAFT_KEY, JSON.stringify({ version: 1, ...copySnapshot(snapshot) }));
        return true;
      } catch {
        // A failed save must not leave an older chat waiting to be restored.
        clear();
        return false;
      }
    },

    clear,
  };
}
