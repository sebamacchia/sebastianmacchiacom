// importer.js — turns a FileList from <input webkitdirectory> into parsed projects.
// Finds every PADCONF.BIN (case-insensitive); its parent folder is one project.

import { parsePadconf, parseSmpHeader, padLengths } from './padconf.js';

/**
 * @typedef {Object} ImportedPad
 * @property {string} name
 * @property {number} playSec   (End - Start) / bytesPerFrame / 48000
 * @property {number} fullSec   (fileSize - 512) / bytesPerFrame / 48000
 * @property {number} channels  From SMPL/BANKb-pp.SMP header; defaults to 2.
 * @property {boolean} approx   True when channels were not read from an SMP header.
 */

/**
 * @typedef {Object} ImportedProject
 * @property {string} id       "slot-NN" for PROJECT_NN folders, otherwise the folder name.
 * @property {string} name     Project name from PADCONF (v3) or the folder name (v2).
 * @property {string} folder   Folder that contains PADCONF.BIN.
 * @property {number|null} slot  NN from a PROJECT_NN folder, otherwise null.
 * @property {"sd"} source
 * @property {string} importedAt  ISO date.
 * @property {Object<string, ImportedPad>} pads  Only loaded pads, keyed "A1".."J16".
 */

/**
 * Scan a FileList for projects and parse each one.
 * Bad files are reported in `warnings` and skipped; the scan keeps going.
 *
 * @param {FileList|File[]} fileList  Files from <input type="file" webkitdirectory>.
 * @returns {Promise<{ projects: ImportedProject[], warnings: string[] }>}
 */
export async function findProjects(fileList) {
  const files = Array.from(fileList ?? []);
  /** Lower-case path -> file, for case-insensitive SMP lookup. */
  const byPath = new Map();
  /** PADCONF.BIN files in input order. */
  const padconfs = [];
  for (const file of files) {
    const path = filePath(file);
    byPath.set(path.toLowerCase(), file);
    if (basename(path).toLowerCase() === 'padconf.bin') padconfs.push({ file, path });
  }

  const projects = [];
  const warnings = [];
  const seen = new Set();
  const importedAt = new Date().toISOString();

  for (const { file, path } of padconfs) {
    const dir = dirname(path);
    const folder = basename(dir) || 'PADCONF';
    let parsed;
    try {
      parsed = parsePadconf(await file.arrayBuffer());
    } catch (err) {
      warnings.push(`${folder}: ${errorMessage(err)}`);
      continue;
    }

    const slotMatch = /^PROJECT_(\d{2})$/i.exec(folder);
    const id = slotMatch ? `slot-${slotMatch[1]}` : folder;
    if (seen.has(id)) {
      warnings.push(`${folder}: duplicate project (${path}); kept the first one found`);
      continue;
    }
    seen.add(id);

    const loaded = parsed.pads.filter((p) => p.loaded);
    const channelList = await Promise.all(loaded.map((p) => readChannels(byPath, dir, p.index)));
    const pads = {};
    loaded.forEach((p, k) => {
      const channels = channelList[k];
      const approx = channels === null;
      const ch = approx ? 2 : channels;
      const { playSec, fullSec } = padLengths(p, ch);
      pads[p.id] = { name: p.name, playSec, fullSec, channels: ch, approx };
    });

    projects.push({
      id,
      name: parsed.projectName ?? folder,
      folder,
      slot: slotMatch ? Number(slotMatch[1]) : null,
      source: 'sd',
      importedAt,
      pads,
    });
  }

  return { projects, warnings };
}

/** Relative path of a File from <input webkitdirectory>, with "/" separators. */
function filePath(file) {
  const p = file.webkitRelativePath || file.name || '';
  return p.replace(/\\/g, '/');
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

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * Channel count from <dir>/SMPL/BANKb-pp.SMP, or null when the file is
 * missing or its header can't be read (caller assumes stereo, approx).
 */
async function readChannels(byPath, dir, index) {
  const b = Math.floor(index / 16) + 1;
  const pp = String((index % 16) + 1).padStart(2, '0');
  const rel = `SMPL/BANK${b}-${pp}.SMP`;
  const file = byPath.get((dir ? `${dir}/${rel}` : rel).toLowerCase());
  if (!file) return null;
  try {
    const { channels } = parseSmpHeader(await file.slice(0, 16).arrayBuffer());
    return channels === 1 || channels === 2 ? channels : null;
  } catch {
    return null;
  }
}
