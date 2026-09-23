// WhatsApp exports "with media" are ZIPs holding the chat as a .txt next to
// photos and voice notes. Only the directory and the chat entry are read, as
// slices of the file, so hundreds of MB of media never load. Nothing is
// written anywhere, so entry paths can't escape.

const MAX_CHAT_BYTES = 50 * 1024 * 1024;
const ZIP_MAGIC = 0x04034b50;
const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const STORED = 0;
const DEFLATED = 8;

export class FileError extends Error {}

export async function readChatFile(file) {
  const head = await bytes(file.slice(0, 4));
  if (head.byteLength === 4 && head.getUint32(0, true) === ZIP_MAGIC) return readChatFromZip(file);
  if (file.size > MAX_CHAT_BYTES) throw new FileError('tooBig');
  return file.text();
}

async function bytes(blob) {
  return new DataView(await blob.arrayBuffer());
}

async function readChatFromZip(zip) {
  const entry = pickChat(await directoryOf(zip));
  if (!entry) throw new FileError('noChatInZip');
  if (entry.encrypted) throw new FileError('encryptedZip');
  if (entry.size > MAX_CHAT_BYTES) throw new FileError('tooBig');

  const local = await bytes(zip.slice(entry.offset, entry.offset + 30));
  const start = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  const data = zip.slice(start, start + entry.compressedSize);
  if (entry.method === STORED) return data.text();
  if (entry.method === DEFLATED) return inflate(data);
  throw new FileError('unreadableZip');
}

/** The central directory: one record per entry, found from the end of the file. */
async function directoryOf(zip) {
  // The end record is 22 bytes plus a comment of at most 64 KB.
  const tailStart = Math.max(0, zip.size - 22 - 0xffff);
  const tail = await bytes(zip.slice(tailStart));
  let end = tail.byteLength - 22;
  while (end >= 0 && tail.getUint32(end, true) !== END_OF_DIRECTORY) end--;
  if (end < 0) throw new FileError('unreadableZip');

  const size = tail.getUint32(end + 12, true);
  const offset = tail.getUint32(end + 16, true);
  // ZIP64 marks these as 0xffffffff; exports that big are out of scope.
  if (offset === 0xffffffff) throw new FileError('tooBig');

  const directory = await bytes(zip.slice(offset, offset + size));
  const decoder = new TextDecoder();
  const entries = [];
  for (let at = 0; at + 46 <= directory.byteLength && directory.getUint32(at, true) === DIRECTORY_ENTRY; ) {
    const nameLength = directory.getUint16(at + 28, true);
    entries.push({
      encrypted: (directory.getUint16(at + 8, true) & 1) === 1,
      method: directory.getUint16(at + 10, true),
      compressedSize: directory.getUint32(at + 20, true),
      size: directory.getUint32(at + 24, true),
      offset: directory.getUint32(at + 42, true),
      name: decoder.decode(new Uint8Array(directory.buffer, directory.byteOffset + at + 46, nameLength)),
    });
    at += 46 + nameLength + directory.getUint16(at + 30, true) + directory.getUint16(at + 32, true);
  }
  return entries;
}

/** iOS names the chat `_chat.txt`, Android "WhatsApp Chat with …"; else the largest text file. */
function pickChat(entries) {
  const texts = entries.filter(({ name }) => /\.txt$/i.test(name) && !name.startsWith('__MACOSX/'));
  const baseName = (name) => name.split('/').pop();
  return (
    texts.find(({ name }) => /^_chat\.txt$|^WhatsApp/i.test(baseName(name))) ??
    texts.sort((a, b) => b.size - a.size)[0]
  );
}

/** Streams the entry and stops once it passes the limit, whatever the header claims. */
async function inflate(blob) {
  const reader = blob.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let size = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength;
    if (size > MAX_CHAT_BYTES) {
      await reader.cancel();
      throw new FileError('tooBig');
    }
    chunks.push(chunk.value);
  }
  return new Blob(chunks).text();
}
