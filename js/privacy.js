import { forgetChat } from './api.js';
import { forgetKept, keptChats } from './kept.js';

const form = document.getElementById('forget-form');
const result = document.getElementById('forget-result');

async function forget(code) {
  try {
    const forgotten = await forgetChat(code);
    forgetKept(code);
    result.textContent = forgotten
      ? 'Gelöscht. / Deleted.'
      : 'Kein aufbewahrter Chat mit diesem Code. / No kept chat with that code.';
  } catch (error) {
    result.textContent = error.message;
  }
  renderKept();
}

/** Local time as "2026-10-25 20:41". */
function localStamp(iso) {
  const date = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderKept() {
  const chats = keptChats();
  document.getElementById('kept-here').hidden = !chats.length;
  document.getElementById('kept-list').replaceChildren(
    ...chats.map(({ code, at, people }) => {
      const item = document.createElement('li');
      const button = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: 'Löschen / Delete' });
      button.addEventListener('click', () => forget(code));
      item.append(`${localStamp(at)} · ${people} Personen / people `, button);
      return item;
    }),
  );
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  forget(document.getElementById('code').value);
});

renderKept();
