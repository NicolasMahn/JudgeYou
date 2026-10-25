const login = document.getElementById('login');
const form = document.getElementById('settings');
const status = document.getElementById('status');
let token = '';

async function request(method = 'GET', body) {
  const response = await fetch('/api/admin/settings', {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
    cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'Could not load settings.');
  return result;
}

function showUsage({ usage }) {
  document.getElementById('usage').textContent = ['decisions', 'screenshots'].map((kind) => {
    const value = usage[kind];
    return `${kind === 'decisions' ? 'Judgments' : 'Screenshot uploads'}: ${value.active} of ${value.maxConcurrent} running now, ${value.usedToday} of ${value.perDay} used today. The day resets ${value.resetsAt}.`;
  }).join(' ');
}

function show(data) {
  for (const group of form.querySelectorAll('[data-kind]')) {
    for (const input of group.querySelectorAll('input')) input.value = data.settings[group.dataset.kind][input.name];
  }
  document.getElementById('timeout').value = data.settings.timeoutMs / 1000;
  showUsage(data);
  form.hidden = false;
  login.hidden = true;
}

login.addEventListener('submit', async (event) => {
  event.preventDefault();
  token = document.getElementById('token').value;
  try {
    show(await request());
    document.getElementById('token').value = '';
    status.textContent = 'Connected. The token stays in memory until this page closes.';
  } catch (error) {
    token = '';
    status.textContent = error.message;
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = { timeoutMs: Math.round(Number(document.getElementById('timeout').value) * 1000) };
  for (const group of form.querySelectorAll('[data-kind]')) {
    settings[group.dataset.kind] = Object.fromEntries([...group.querySelectorAll('input')].map((input) => [input.name, Number(input.value)]));
  }
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    show(await request('PUT', settings));
    status.textContent = 'Saved. New requests use these limits immediately.';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
});

document.getElementById('refresh').addEventListener('click', async () => {
  try {
    showUsage(await request());
    status.textContent = 'Usage refreshed.';
  } catch (error) {
    status.textContent = error.message;
  }
});

document.getElementById('disconnect').addEventListener('click', () => {
  token = '';
  form.hidden = true;
  login.hidden = false;
  status.textContent = 'Disconnected.';
});
