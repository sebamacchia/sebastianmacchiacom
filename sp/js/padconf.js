// padconf.js — PURE parser for SP-404MKII PADCONF.BIN and .SMP headers.
// No DOM access: imported directly by the Node tests.
// Format facts from SparkyMK2 RE docs and gsterlin/sp404mk2-tools; no code copied.

/** Byte length of a version 3 PADCONF.BIN. */
export const PADCONF_V3_LEN = 52000;
/** Byte length of a version 2 PADCONF.BIN (older firmware). */
export const PADCONF_V2_LEN = 31488;
/** Size of one pad record in bytes. */
export const PAD_RECORD_SIZE = 172;
/** Size of one pad name in bytes. */
export const PAD_NAME_SIZE = 24;
/** Bank letters, bank A = index 0. */
export const BANKS = 'ABCDEFGHIJ';
/** Sample rate of every SP-404MKII sample. */
export const SAMPLE_RATE = 48000;
/** Size of the .SMP header in bytes (subtracted from file size for full length). */
export const SMP_HEADER_BYTES = 512;

/** Version 3 layout: project name, pad records, pad names. */
const LAYOUT_V3 = { version: 3, nameOffset: 0x80, nameSize: 32, records: 0xa0, names: 0x6c20 };
/** Version 2 layout: no project name. */
const LAYOUT_V2 = { version: 2, nameOffset: -1, nameSize: 0, records: 0x80, names: 0x6c00 };
/** Number of pads in a project (10 banks x 16 pads). */
export const PAD_COUNT = 160;

/** Accept an ArrayBuffer or any typed-array / Buffer view; return a DataView. */
function toDataView(data) {
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Expected an ArrayBuffer');
}

/** Four ASCII bytes at `offset`. */
function readTag(view, offset) {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/** All `length` bytes at `offset` as a Latin-1 string (NULs included). */
function readLatin1Raw(view, offset, length) {
  let s = '';
  // Latin-1 code points map 1:1 to U+0000..U+00FF. (TextDecoder('latin1') is
  // really windows-1252 and would remap 0x80..0x9F, so decode by hand.)
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/** Latin-1 string of `length` bytes at `offset`, cut at the first NUL. */
function readLatin1(view, offset, length) {
  const raw = readLatin1Raw(view, offset, length);
  const nul = raw.indexOf('\0');
  return nul === -1 ? raw : raw.slice(0, nul);
}

/** Pad id for an index: 0 -> "A1", 17 -> "B2". */
export function padIdFromIndex(index) {
  return BANKS[Math.floor(index / 16)] + String((index % 16) + 1);
}

/**
 * @typedef {Object} ParsedPad
 * @property {string} id         Pad id, e.g. "A1" (bank letter + pad number 1..16).
 * @property {number} index      bank * 16 + (pad - 1); A1 = 0.
 * @property {string} name       Latin-1 name, cut at first NUL, trailing spaces trimmed.
 * @property {number} fileSize   SMP file size in bytes; 0 = empty pad.
 * @property {number} start      Start byte offset in the SMP.
 * @property {number} end        End byte offset in the SMP.
 * @property {boolean} loaded    fileSize > 0.
 */

/**
 * Parse a PADCONF.BIN file (big-endian u32 words).
 *
 * Version 3 (52000 bytes): name at 0x80 (32 bytes), records at 0xA0, names at 0x6C20.
 * Version 2 (31488 bytes): no project name, records at 0x80, names at 0x6C00.
 *
 * @param {ArrayBuffer} arrayBuffer  Whole PADCONF.BIN contents.
 * @returns {{ version: 2|3, projectName: string|null, pads: ParsedPad[] }}
 *   `pads` always has 160 entries (A1..J16). `projectName` is null for version 2
 *   (caller falls back to the folder name).
 * @throws {Error} When the magic is not "RFPD" or the length is neither 52000 nor 31488.
 */
export function parsePadconf(arrayBuffer) {
  const view = toDataView(arrayBuffer);
  let layout;
  if (view.byteLength === PADCONF_V3_LEN) layout = LAYOUT_V3;
  else if (view.byteLength === PADCONF_V2_LEN) layout = LAYOUT_V2;
  else {
    throw new Error(
      `PADCONF.BIN has an unexpected size (${view.byteLength} bytes; expected ${PADCONF_V3_LEN} or ${PADCONF_V2_LEN})`,
    );
  }
  if (readTag(view, 0) !== 'RFPD') {
    throw new Error('not a PADCONF.BIN file (missing "RFPD" header)');
  }

  let projectName = null;
  if (layout.nameOffset >= 0) {
    // Strip NUL/space padding at both ends, then cut at any NUL left inside.
    let raw = readLatin1Raw(view, layout.nameOffset, layout.nameSize).replace(/^[\0 ]+/, '');
    const nul = raw.indexOf('\0');
    if (nul !== -1) raw = raw.slice(0, nul);
    raw = raw.replace(/ +$/, '');
    projectName = raw === '' ? null : raw;
  }

  const pads = [];
  for (let i = 0; i < PAD_COUNT; i++) {
    const rec = layout.records + i * PAD_RECORD_SIZE;
    const fileSize = view.getUint32(rec, false);
    const start = view.getUint32(rec + 4, false);
    const end = view.getUint32(rec + 8, false);
    const name = readLatin1(view, layout.names + i * PAD_NAME_SIZE, PAD_NAME_SIZE).replace(/ +$/, '');
    pads.push({ id: padIdFromIndex(i), index: i, name, fileSize, start, end, loaded: fileSize > 0 });
  }
  return { version: layout.version, projectName, pads };
}

/**
 * Parse the start of a .SMP file. Only the first 16 bytes are needed.
 *
 * 0x00 "RFWV" magic, 0x08 sample rate (u32 BE), 0x0C channels (u32 BE),
 * 0x10 bits (u32 BE; reported as 16 when the buffer stops at 16 bytes).
 *
 * @param {ArrayBuffer} arrayBuffer  At least the first 16 bytes of the .SMP.
 * @returns {{ sampleRate: number, channels: number, bits: number }}
 * @throws {Error} When the magic is not "RFWV" or the buffer is too short.
 */
export function parseSmpHeader(arrayBuffer) {
  const view = toDataView(arrayBuffer);
  if (view.byteLength < 16) throw new Error('SMP header is too short');
  if (readTag(view, 0) !== 'RFWV') throw new Error('not an SMP file (missing "RFWV" header)');
  return {
    sampleRate: view.getUint32(0x08, false),
    channels: view.getUint32(0x0c, false),
    // Bit depth sits just past the first 16 bytes; assume 16 when only 16 bytes were read.
    bits: view.byteLength >= 0x14 ? view.getUint32(0x10, false) : 16,
  };
}

/**
 * Playing and full lengths in seconds for one pad.
 *
 *   bytesPerFrame = 2 * channels
 *   fullSec = (fileSize - 512) / bytesPerFrame / 48000
 *   playSec = (end - start) / bytesPerFrame / 48000   (fullSec when end <= start)
 *
 * @param {{ fileSize: number, start: number, end: number }} pad
 * @param {number} [channels=2]
 * @returns {{ playSec: number, fullSec: number }}
 */
export function padLengths(pad, channels = 2) {
  const ch = channels === 1 ? 1 : 2;
  const bytesPerSec = 2 * ch * SAMPLE_RATE;
  const fullSec = Math.max(0, pad.fileSize - SMP_HEADER_BYTES) / bytesPerSec;
  const playSec = pad.end > pad.start ? (pad.end - pad.start) / bytesPerSec : fullSec;
  return { playSec, fullSec };
}
