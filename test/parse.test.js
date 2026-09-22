import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChat, participantsOf } from '../js/parse.js';

const LRM = '‎';
const NNBSP = ' ';

/** Compact view that makes a whole transcript comparable in one assertion. */
const lines = (raw) => parseChat(raw).map((m) => `${m.author}: ${m.text}`);

test('WhatsApp iOS: brackets, multi-line messages, hidden system and media lines', () => {
  const chat = [
    `[19.09.26, 21:00:00] Leo’s Birthday: ${LRM}Messages and calls are end-to-end encrypted.`,
    `${LRM}[19.09.26, 21:02:11] Mara: plan:`,
    'Note: bring cash',
    `[19.09.26, 21:03:40] Tobi: ${LRM}image omitted`,
    `[9/19/26, 9:04:05${NNBSP}PM] ~ Jonas: k`,
  ].join('\n');
  assert.deepEqual(lines(chat), ['Mara: plan:\nNote: bring cash', 'Jonas: k']);
});

test('WhatsApp Android: system lines are dropped, not appended to the previous message', () => {
  const chat = [
    '19/09/2026, 21:02 - Mara: hi all',
    '19/09/2026, 21:03 - Mara added Tobi',
    '19/09/2026, 21:04 - Tobi: <Media omitted>',
    '9/19/26, 9:05 p.m. - Tobi Meier: hey',
    'second line',
  ].join('\n');
  assert.deepEqual(lines(chat), ['Mara: hi all', 'Tobi Meier: hey\nsecond line']);
});

test('Telegram JSON export, including rich-text entities and service messages', () => {
  const chat = JSON.stringify({
    name: 'Friends',
    messages: [
      { type: 'service', actor: 'Mara', action: 'create_group' },
      { type: 'message', from: 'Mara', text: 'hi all' },
      { type: 'message', from: 'Tobi', text: ['see ', { type: 'bold', text: 'this' }] },
    ],
  });
  assert.deepEqual(lines(chat), ['Mara: hi all', 'Tobi: see this']);
});

test('Telegram HTML export: joined messages keep their sender, entities are decoded', () => {
  const chat = `<html><body>
    <div class="message default clearfix" id="message1"><div class="body">
      <div class="from_name">Mara </div><div class="text">Tom &amp; Jerry<br>tonight?</div></div></div>
    <div class="message default clearfix joined" id="message2"><div class="body">
      <div class="text">anyone?</div></div></div>
    <div class="message default clearfix" id="message3"><div class="body">
      <div class="from_name">Tobi</div><div class="text">no &#128578;</div></div></div>
  </body></html>`;
  assert.deepEqual(lines(chat), ['Mara: Tom & Jerry\ntonight?', 'Mara: anyone?', 'Tobi: no 🙂']);
});

test('Messenger and Instagram JSON: sorted oldest first, mojibake repaired', () => {
  const chat = JSON.stringify({
    participants: [{ name: 'Mara' }, { name: 'Jürgen' }],
    messages: [
      { sender_name: 'JÃ¼rgen', timestamp_ms: 2000, content: 'schÃ¶n' },
      { sender_name: 'Mara', timestamp_ms: 1000, content: 'hi' },
    ],
  });
  assert.deepEqual(lines(chat), ['Mara: hi', 'Jürgen: schön']);
});

test('Discord copy-paste and DiscordChatExporter text', () => {
  const pasted = ['Mara — Today at 21:14', 'hi all', 'anyone?', 'Tobi — 19/09/2026 21:15', 'no'].join('\n');
  assert.deepEqual(lines(pasted), ['Mara: hi all\nanyone?', 'Tobi: no']);

  const exported = ['[19-Sep-26 9:14 PM] Mara', 'hi all', '', '[19-Sep-26 9:15 PM] Tobi', 'no'].join('\n');
  assert.deepEqual(lines(exported), ['Mara: hi all', 'Tobi: no']);
});

test('Slack and Teams copy-paste', () => {
  const sameLine = ['Mara Schulz  9:14 PM', 'hi all', 'Tobi  9:15 PM', 'no', 'Mara Schulz  9:16 PM', 'fine'].join('\n');
  assert.deepEqual(lines(sameLine), ['Mara Schulz: hi all', 'Tobi: no', 'Mara Schulz: fine']);

  const nameAbove = ['Mara', '9:14 PM', 'hi all', 'Tobi', '9:15 PM', 'no', 'Mara', '9:16 PM', 'fine'].join('\n');
  assert.deepEqual(lines(nameAbove), ['Mara: hi all', 'Tobi: no', 'Mara: fine']);

  const teams = ['[9:14 PM] Mara Schulz', 'hi all', '[9:15 PM] Tobi', 'no'].join('\n');
  assert.deepEqual(lines(teams), ['Mara Schulz: hi all', 'Tobi: no']);
});

test('iMessage exporter text', () => {
  const chat = [
    'Sep 19, 2026  9:14:03 PM',
    'Mara',
    'hi all',
    '',
    'Sep 19, 2026  9:15:12 PM (Read by Mara after 1 minute)',
    'Me',
    'no',
    '',
    'Sep 19, 2026  9:16:00 PM',
    'Mara',
    'fine',
  ].join('\n');
  assert.deepEqual(lines(chat), ['Mara: hi all', 'Me: no', 'Mara: fine']);
});

test('IRC, LINE and KakaoTalk logs', () => {
  assert.deepEqual(lines('[21:14] <@Mara> hi all\n[21:15] <Tobi> no'), ['Mara: hi all', 'Tobi: no']);

  const line = ['[LINE] Chat history with Friends', '2026.09.19 Saturday', '21:14\tMara\thi all', '21:15\tTobi\tno'].join('\n');
  assert.deepEqual(lines(line), ['Mara: hi all', 'Tobi: no']);

  const kakao = ['2026. 9. 19. 오후 9:14, Mara : hi all', '2026. 9. 19. 오후 9:15, Tobi : no'].join('\n');
  assert.deepEqual(lines(kakao), ['Mara: hi all', 'Tobi: no']);

  assert.deepEqual(lines('[Mara] [오후 9:14] hi all\n[Tobi] [오후 9:15] no'), ['Mara: hi all', 'Tobi: no']);
});

test('CSV exports with quoted fields', () => {
  const chat = 'date,sender,message\n2026-09-19,Mara,"hi, all"\n2026-09-19,Tobi,"he said ""no""\nreally"';
  assert.deepEqual(lines(chat), ['Mara: hi, all', 'Tobi: he said "no"\nreally']);
});

test('plain transcripts, without inventing speakers from sentences with colons', () => {
  const chat = [
    '**Ana**: are you coming?',
    'Here is the thing about tonight: no',
    'Note: bring cash',
    '> Ben: k',
    'Ana: ok',
    'Ben: fine',
  ].join('\n');
  assert.deepEqual(lines(chat), [
    'Ana: are you coming?\nHere is the thing about tonight: no\nNote: bring cash',
    'Ben: k',
    'Ana: ok',
    'Ben: fine',
  ]);
});

test('unrecognised text yields no speakers rather than guesses', () => {
  assert.deepEqual(parseChat('just some notes\nwithout any structure'), []);
});

test('ranks participants by message count', () => {
  assert.deepEqual(participantsOf(parseChat('A: 1\nB: 2\nB: 3')), [
    { name: 'B', messageCount: 2 },
    { name: 'A', messageCount: 1 },
  ]);
});
