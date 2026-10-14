// importer.js — reads the folder picked with <input webkitdirectory> as an SD card.
// It builds the card index (names, lengths and paths only) and a path -> File map
// that lets this browser session play the files straight from disk. Audio is never
// read whole here: PADCONF.BIN is read whole (52 KB), every other file only by
// header slices.

import { parsePadconf, parseSmpHeader, padLengths } from './padconf.js';

/** A card project folder: P<slot>_<name>, e.g. P1_OLD, P16_PROJECT_16. */
const PROJECT_FOLDER_RE = /^P(\d{1,2})_(.+)$/i;
/** A folder named like an SP-404SX card or backup. */
const SX_NAME_RE = /SP-?404\s*SX/i;
/** An SP-404SX sample file inside its SMPL folder, e.g. SMPL/A0000001.WAV. */
const SX_SAMPLE_RE = /(?:^|\/)SMPL\/[A-J]\d{7}\.WAV$/i;
/** Audio files listed as card samples (extension, lower case). */
const SAMPLE_EXTS = new Set(['wav', 'aif', 'aiff']);
/** Bytes read from the start of an audio file to find its length. */
const HEADER_SLICE = 65536;
/** Server limits (api.php `card`). */
export const CARD_LIMITS = { samples: 5000, projects: 64, sx: 64, path: 400, seconds: 36000 };
/** How many files are read at the same time. */
const CONCURRENCY = 8;

/**
 * @typedef {Object} CardPad
 * @property {string} name
 * @property {number|null} playSec
 * @property {number|null} fullSec
 * @property {1|2} channels   From SMPL/BANKb-pp.SMP; 2 when unknown.
 * @property {boolean} approx  True when channels were not read from an SMP header.
 * @property {number} start   SMP byte offset where playback starts.
 * @property {number} end     SMP byte offset where playback ends.
 */

/**
 * @typedef {Object} CardProject
 * @property {string} id        "card-" + folder ("-2", "-3" added for repeated folder names).
 * @property {string} folder    Folder that holds PADCONF.BIN, e.g. "P1_OLD".
 * @property {number|null} slot 1..16 from a P<slot>_ folder, else null.
 * @property {string} name      PADCONF project name, else the folder name after "P<slot>_".
 * @property {number} modified  PADCONF.BIN lastModified (ms).
 * @property {Object<string, CardPad>} pads  Only loaded pads, keyed "A1".."J16".
 */

/**
 * @typedef {Object} CardSample
 * @property {string} path    Relative to the card root, e.g. "IMPORT/drums-loops/x.wav".
 * @property {string} folder  path without the file name ("" at the root).
 * @property {string} name    File name without its extension.
 * @property {"wav"|"aif"|"aiff"} ext
 * @property {number|null} sec  From the file header, rounded to ms; null if unreadable.
 */

/**
 * Read a picked card folder.
 *
 * Paths drop the first segment of webkitRelativePath (the picked folder), so they
 * are relative to the card root whether the user picks `card/` or the SD card itself.
 *
 * @param {FileList|File[]} fileList  Files from <input type="file" webkitdirectory>.
 * @returns {Promise<{ card: { samples: CardSample[], projects: CardProject[], sx: {folder: string, name: string}[] },
 *                     files: Map<string, File>, warnings: string[] }>}
 *   `files` maps card paths of every sample and every project .SMP to its File.
 */
export async function readCard(fileList) {
  const entries = [];
  for (const file of Array.from(fileList ?? [])) {
    const { path, picked } = cardPath(file);
    if (path) entries.push({ file, path, picked });
  }

  const warnings = [];
  const files = new Map();
  /** Lower-case path -> entry, for case-insensitive SMP lookup. */
  const byLower = new Map();
  for (const e of entries) byLower.set(e.path.toLowerCase(), e);

  // ── Projects: every PADCONF.BIN ──
  const padconfs = entries.filter((e) => basename(e.path).toLowerCase() === 'padconf.bin');
  const projectDirs = padconfs.map((e) => dirname(e.path));
  const projects = [];
  const usedIds = new Set();
  const parsedProjects = await mapLimit(padconfs, CONCURRENCY, (e) => readProject(e, byLower));
  for (const result of parsedProjects) {
    if (result.error) {
      warnings.push(`${result.folder}: ${result.error}`);
      continue;
    }
    const project = result.project;
    let id = `card-${project.folder}`;
    for (let n = 2; usedIds.has(id); n++) id = `card-${project.folder}-${n}`;
    usedIds.add(id);
    projects.push({ id, ...project });
    for (const smp of result.smpFiles) files.set(smp.path, smp.file);
  }
  projects.sort(
    (a, b) => (a.slot ?? 99) - (b.slot ?? 99) || naturalCompare(a.folder, b.folder) || naturalCompare(a.id, b.id),
  );
  if (projects.length > CARD_LIMITS.projects) {
    warnings.push(`Only the first ${CARD_LIMITS.projects} of ${projects.length} projects were kept.`);
    projects.length = CARD_LIMITS.projects;
  }

  // ── Samples: .wav/.aif/.aiff outside project folders ──
  const insideProject = (path) => projectDirs.some((dir) => dir === '' || path.startsWith(`${dir}/`));
  let audio = entries.filter((e) => {
    const name = basename(e.path);
    if (name.startsWith('.') || name.startsWith('._')) return false;
    if (!SAMPLE_EXTS.has(extension(name))) return false;
    return !insideProject(e.path);
  });
  const badPaths = audio.filter((e) => !isCleanPath(e.path));
  if (badPaths.length) {
    warnings.push(
      `${plural(badPaths.length, 'file was', 'files were')} skipped because the path is too long or has unusual characters: ${badPaths
        .slice(0, 3)
        .map((e) => e.path)
        .join(', ')}${badPaths.length > 3 ? ', …' : ''}`,
    );
    audio = audio.filter((e) => isCleanPath(e.path));
  }
  audio.sort((a, b) => naturalCompare(a.path, b.path));
  if (audio.length > CARD_LIMITS.samples) {
    warnings.push(`Only the first ${CARD_LIMITS.samples} of ${audio.length} samples were kept.`);
    audio = audio.slice(0, CARD_LIMITS.samples);
  }
  const lengths = await mapLimit(audio, CONCURRENCY, (e) => readAudioSeconds(e.file, extension(e.path)));
  const samples = audio.map((e, k) => {
    files.set(e.path, e.file);
    const name = basename(e.path);
    const ext = extension(name);
    // Trimmed like the server does; a name of only spaces falls back to the file name.
    const stem = name.slice(0, name.length - ext.length - 1).trim() || name.trim();
    return { path: e.path, folder: dirname(e.path), name: stem, ext, sec: lengths[k] };
  });
  const unknown = samples.filter((s) => s.sec === null).length;
  if (unknown) warnings.push(`${plural(unknown, 'sample has', 'samples have')} no readable length.`);

  // ── SP-404SX projects: listed by folder only ──
  const sx = findSx(entries);
  if (sx.length > CARD_LIMITS.sx) {
    warnings.push(`Only the first ${CARD_LIMITS.sx} of ${sx.length} SP-404SX folders were kept.`);
    sx.length = CARD_LIMITS.sx;
  }

  return { card: { samples, projects, sx }, files, warnings };
}

/**
 * The File holding one pad's audio in a card project read this session, or null.
 * Looks for <...>/<folder>/SMPL/BANKb-pp.SMP among the picked files, ignoring case.
 * Works for memory slots too: pass the slot's `folder`.
 *
 * @param {Map<string, File>} files  The `files` map from readCard.
 * @param {string} folder  Card project folder, e.g. "P1_OLD".
 * @param {string} padId   "A1".."J16".
 * @returns {File|null}
 */
export function findPadFile(files, folder, padId) {
  if (!files || typeof folder !== 'string' || folder === '' || !/^[A-J](?:[1-9]|1[0-6])$/.test(String(padId))) return null;
  let index = padFileIndex.get(files);
  if (!index || index.size !== files.size) {
    const map = new Map();
    for (const [path, file] of files) {
      const parts = path.split('/');
      const n = parts.length;
      if (n < 3 || parts[n - 2].toLowerCase() !== 'smpl') continue;
      const key = `${parts[n - 3].toLowerCase()}/${parts[n - 1].toLowerCase()}`;
      if (!map.has(key)) map.set(key, file);
    }
    index = { size: files.size, map };
    padFileIndex.set(files, index);
  }
  return index.map.get(`${folder.toLowerCase()}/${smpName(padId).toLowerCase()}`) ?? null;
}

/** files Map -> { size, map } lookup, rebuilt when the Map grows or shrinks. */
const padFileIndex = new WeakMap();

// ── Projects ──

async function readProject(entry, byLower) {
  const dir = dirname(entry.path);
  // A PADCONF.BIN in the picked folder itself: its folder is the picked folder.
  const folder = basename(dir) || entry.picked || 'PADCONF';
  let parsed;
  try {
    parsed = parsePadconf(await entry.file.arrayBuffer());
  } catch (err) {
    return { folder, error: errorMessage(err) };
  }
  const m = PROJECT_FOLDER_RE.exec(folder);
  const n = m ? Number(m[1]) : null;
  const slot = n !== null && n >= 1 && n <= 16 ? n : null;
  const name = parsed.projectName ?? (m ? m[2] : folder);

  const loaded = parsed.pads.filter((p) => p.loaded);
  const smpFiles = [];
  const channelList = await mapLimit(loaded, CONCURRENCY, async (p) => {
    const rel = `SMPL/${smpName(p.id)}`;
    const smp = byLower.get((dir ? `${dir}/${rel}` : rel).toLowerCase());
    if (!smp) return null;
    smpFiles.push(smp);
    return readChannels(smp.file);
  });
  const pads = {};
  loaded.forEach((p, k) => {
    const channels = channelList[k];
    const approx = channels === null;
    const ch = approx ? 2 : channels;
    const { playSec, fullSec } = padLengths(p, ch);
    pads[p.id] = { name: p.name, playSec, fullSec, channels: ch, approx, start: p.start, end: p.end };
  });
  const modified = Number.isFinite(entry.file.lastModified) ? entry.file.lastModified : 0;
  return { project: { folder, slot, name, modified, pads }, smpFiles };
}

/** "BANK1-01.SMP" for pad A1, "BANK10-16.SMP" for J16. */
function smpName(padId) {
  const bank = padId.charCodeAt(0) - 64;
  return `BANK${bank}-${String(Number(padId.slice(1))).padStart(2, '0')}.SMP`;
}

/** Channels from the first 16 bytes of an SMP, or null when unreadable. */
async function readChannels(file) {
  try {
    const { channels } = parseSmpHeader(await file.slice(0, 16).arrayBuffer());
    return channels === 1 || channels === 2 ? channels : null;
  } catch {
    return null;
  }
}

// ── Sample lengths from headers ──

/**
 * Length in seconds of a WAV or AIFF from its header, or null.
 * Reads `slice(0, 65536)`, plus one more 64 KB slice per chunk header that lies
 * beyond what was read (rare: big metadata chunks before the audio).
 * @param {File} file
 * @param {string} ext  "wav" | "aif" | "aiff"
 * @returns {Promise<number|null>}
 */
export async function readAudioSeconds(file, ext) {
  try {
    const reader = windowReader(file);
    const sec = ext === 'wav' ? await wavSeconds(reader, file.size) : await aiffSeconds(reader, file.size);
    if (sec === null || !Number.isFinite(sec) || sec < 0 || sec > CARD_LIMITS.seconds) return null;
    return Math.round(sec * 1000) / 1000;
  } catch {
    return null;
  }
}

/** Reads bytes at any offset through 64 KB windows of the file. */
function windowReader(file) {
  let base = -1;
  let view = null;
  let reads = 0;
  return async function bytes(offset, length) {
    if (!view || offset < base || offset + length > base + view.byteLength) {
      if (++reads > 32) throw new Error('header too scattered');
      base = offset;
      view = new DataView(await file.slice(offset, offset + Math.max(HEADER_SLICE, length)).arrayBuffer());
    }
    if (offset + length > base + view.byteLength) return null; // past the end of the file
    return new DataView(view.buffer, view.byteOffset + (offset - base), length);
  };
}

function tagAt(view, offset) {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

async function wavSeconds(bytes, size) {
  const head = await bytes(0, 12);
  if (!head || tagAt(head, 0) !== 'RIFF' || tagAt(head, 8) !== 'WAVE') return null;
  let fmt = null;
  let dataSize = null;
  let factFrames = null;
  for (let offset = 12, guard = 0; offset + 8 <= size && guard < 1000; guard++) {
    const h = await bytes(offset, 8);
    if (!h) break;
    const id = tagAt(h, 0);
    const chunkSize = h.getUint32(4, true);
    if (id === 'fmt ') {
      const b = await bytes(offset + 8, 16);
      if (!b) return null;
      fmt = {
        tag: b.getUint16(0, true),
        rate: b.getUint32(4, true),
        byteRate: b.getUint32(8, true),
        blockAlign: b.getUint16(12, true),
      };
    } else if (id === 'fact' && chunkSize >= 4) {
      const b = await bytes(offset + 8, 4);
      if (b) factFrames = b.getUint32(0, true);
    } else if (id === 'data') {
      const available = Math.max(0, size - (offset + 8));
      // 0 and 0xFFFFFFFF mean "unknown" in streamed files; trust the file size then.
      dataSize = chunkSize === 0 || chunkSize === 0xffffffff ? available : Math.min(chunkSize, available);
      if (fmt) break;
    }
    offset += 8 + chunkSize + (chunkSize & 1);
  }
  if (!fmt || dataSize === null || !(fmt.rate > 0)) return null;
  const pcm = fmt.tag === 1 || fmt.tag === 3 || fmt.tag === 0xfffe;
  if (pcm && fmt.blockAlign > 0) return Math.floor(dataSize / fmt.blockAlign) / fmt.rate;
  if (factFrames !== null) return factFrames / fmt.rate;
  if (fmt.byteRate > 0) return dataSize / fmt.byteRate;
  return null;
}

async function aiffSeconds(bytes, size) {
  const head = await bytes(0, 12);
  if (!head || tagAt(head, 0) !== 'FORM') return null;
  const form = tagAt(head, 8);
  if (form !== 'AIFF' && form !== 'AIFC') return null;
  for (let offset = 12, guard = 0; offset + 8 <= size && guard < 1000; guard++) {
    const h = await bytes(offset, 8);
    if (!h) break;
    const chunkSize = h.getUint32(4, false);
    if (tagAt(h, 0) === 'COMM') {
      const b = await bytes(offset + 8, 18);
      if (!b) return null;
      const frames = b.getUint32(2, false);
      const rate = extended80(b, 8);
      return rate > 0 ? frames / rate : null;
    }
    offset += 8 + chunkSize + (chunkSize & 1);
  }
  return null;
}

/** IEEE 754 80-bit extended float (AIFF sample rate), big-endian. */
export function extended80(view, offset) {
  const se = view.getUint16(offset, false);
  const hi = view.getUint32(offset + 2, false);
  const lo = view.getUint32(offset + 6, false);
  const exponent = se & 0x7fff;
  if (exponent === 0 && hi === 0 && lo === 0) return 0;
  if (exponent === 0x7fff) return NaN;
  const value = (hi * 2 ** 32 + lo) * 2 ** (exponent - 16383 - 63);
  return se & 0x8000 ? -value : value;
}

// ── SP-404SX ──

function findSx(entries) {
  const found = new Map();
  const add = (folder, name) => {
    if (!found.has(folder)) found.set(folder, { folder, name });
  };
  for (const e of entries) {
    const parts = dirname(e.path).split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (SX_NAME_RE.test(parts[i])) add(parts.slice(0, i + 1).join('/'), parts[i]);
    }
    if (SX_SAMPLE_RE.test(e.path)) {
      const smplDir = dirname(e.path);
      const folder = dirname(smplDir);
      add(folder, basename(folder) || e.picked || 'SP-404SX');
    }
  }
  return [...found.values()]
    .filter((s) => isCleanPath(s.folder) || s.folder === '')
    .sort((a, b) => naturalCompare(a.folder, b.folder));
}

// ── Paths and small helpers ──

/**
 * Path of a File relative to the picked folder, with "/" separators.
 * `picked` is the picked folder's own name (the dropped first segment).
 */
function cardPath(file) {
  const rel = String(file.webkitRelativePath || '').replace(/\\/g, '/');
  if (rel.includes('/')) {
    const cut = rel.indexOf('/');
    return { path: rel.slice(cut + 1), picked: rel.slice(0, cut) };
  }
  return { path: rel || String(file.name || ''), picked: '' };
}

/** The rules api.php applies to a card path. */
function isCleanPath(path) {
  return (
    path.length > 0 &&
    path.length <= CARD_LIMITS.path &&
    !path.startsWith('/') &&
    !path.split('/').includes('..') &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(path)
  );
}

function basename(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Parent directory path ("" for a file at the top level). */
function dirname(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Lower-case extension without the dot, "" when none. */
function extension(name) {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** Compare with numbers in natural order ("2" before "10"), ignoring case. */
export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

/** Map with at most `limit` promises running; results keep input order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
