import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FileError, readChatFile } from '../js/files.js';
import { parseChat } from '../js/parse.js';

const fixture = async (name) => new File([await readFile(new URL(`fixtures/${name}`, import.meta.url))], name);

test('WhatsApp ZIP with media: the chat is found and inflated, media is ignored', async () => {
  const messages = parseChat(await readChatFile(await fixture('whatsapp-with-media.zip')));
  assert.equal(messages.length, 40);
  assert.equal(messages[0].text, 'hi all 😊');
});

test('uncompressed ZIPs and plain text files read the same', async () => {
  const stored = await readChatFile(await fixture('stored.zip'));
  assert.match(stored, /^\[19\.09\.26, 21:01:11\] Mara/);
  assert.equal(await readChatFile(new File(['Ana: hi'], 'chat.txt')), 'Ana: hi');
});

test('a ZIP without a chat is refused with a reason', async () => {
  await assert.rejects(readChatFile(await fixture('no-chat.zip')), (error) => error instanceof FileError && error.message === 'noChatInZip');
});
