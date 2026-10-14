// store.js — pure helpers over the crate the server returns:
//   { memory: {"slot-NN": Slot}, overrides: {"slot-NN": {padId: {name?, playSec?}}},
//     names: {"slot-NN": string}, card: null | {readAt, samples, projects, sx} }
// No DOM, no storage, no network: the Node tests import this file directly.

import { BANKS } from './padconf.js';

/** Number of project slots in the SP-404MKII memory. */
export const SLOT_COUNT = 16;

/** Valid pad ids: bank letter A..J + pad number 1..16. */
const PAD_ID_RE = /^[A-J](?:[1-9]|1[0-6])$/;

/**
 * @typedef {Object} Pad
 * @property {string} name
 * @property {number|null} playSec
 * @property {number|null} fullSec
 * @property {1|2|null} channels
 * @property {boolean} approx
 * @property {number} [start]  SMP byte offset (card pads only).
 * @property {number} [end]    SMP byte offset (card pads only).
 */

/**
 * @typedef {Object} Slot
 * @property {string} id         "slot-01".."slot-16"
 * @property {number} slot       1..16
 * @property {string} name
 * @property {string} folder     Card project folder it was loaded from ("" when manual).
 * @property {"card"|"manual"} source
 * @property {string} loadedAt   ISO date.
 * @property {Object<string, Pad>} pads
 */

// ---------- Small helpers ----------

/** "slot-07" for 7. */
export function slotId(slot) {
  return `slot-${String(slot).padStart(2, '0')}`;
}

/** 7 for "slot-07"; null when not a slot id. */
function slotNumber(id) {
  const m = /^slot-(\d{2})$/.exec(String(id));
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= SLOT_COUNT ? n : null;
}

/** Pad ids of one bank, "A1".."A16". */
function bankPadIds(bank) {
  const ids = [];
  for (let n = 1; n <= 16; n++) ids.push(`${bank}${n}`);
  return ids;
}

/** Lower case, accents removed: "Cúmbia" -> "cumbia". */
export function plain(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** A card project by its id ("card-P1_OLD"), or undefined. */
function cardProject(crate, id) {
  const list = crate?.card?.projects;
  return Array.isArray(list) ? list.find((p) => p && p.id === id) : undefined;
}

/**
 * Pads and overrides for a memory slot ("slot-01") or a card project ("card-P1_OLD").
 * Card projects are read-only, so they never have overrides.
 */
function padsAndOverrides(crate, id) {
  if (typeof id === 'string' && id.startsWith('card-')) {
    return { pads: cardProject(crate, id)?.pads ?? {}, overrides: {} };
  }
  return { pads: crate?.memory?.[id]?.pads ?? {}, overrides: crate?.overrides?.[id] ?? {} };
}

// ---------- Display ----------

/**
 * Pads to display for one bank: `{ ...pads[id], ...overrides[id] }`, plus an
 * `edited` flag when an override exists and `fromSd` when the pad came from the
 * card (so "Use SD card value" can be offered). A pad that only has an override
 * (an empty pad written in by hand) appears with `fullSec`/`channels` = null and
 * `playSec` = null unless set.
 *
 * `slotId` may also be a card project id ("card-P1_OLD") to show its read-only grid.
 *
 * @param {object} crate
 * @param {string} slotId  "slot-01".."slot-16" or a card project id.
 * @param {string} bank    "A".."J"
 * @returns {Object<string, Pad & { edited: boolean, fromSd: boolean }>} Keyed by pad id, only non-empty pads.
 */
export function getDisplayPads(crate, slotId, bank) {
  const out = {};
  if (slotId == null || typeof bank !== 'string' || bank.length !== 1 || !BANKS.includes(bank)) return out;
  const { pads, overrides } = padsAndOverrides(crate, slotId);
  for (const padId of bankPadIds(bank)) {
    const base = pads[padId];
    const ov = overrides[padId];
    if (!base && !ov) continue;
    const defaults = { name: '', playSec: null, fullSec: null, channels: null, approx: false };
    out[padId] = { ...defaults, ...base, ...ov, edited: Boolean(ov), fromSd: Boolean(base) };
  }
  return out;
}

/**
 * Which banks hold anything to show: a pad or a hand edit (same rule as
 * getDisplayPads, so a bank is never dimmed while showing a pad).
 * Works for a memory slot id or a card project id.
 * @param {object} crate
 * @param {string} slotId
 * @returns {Object<string, boolean>} { A: bool, ..., J: bool }
 */
export function bankHasSamples(crate, slotId) {
  const result = {};
  for (const b of BANKS) result[b] = false;
  const { pads, overrides } = padsAndOverrides(crate, slotId);
  for (const id of [...Object.keys(pads), ...Object.keys(overrides)]) {
    if (PAD_ID_RE.test(id)) result[id[0]] = true;
  }
  return result;
}

/**
 * All 16 memory slots, in order, for the slot picker.
 * `name` is the rename (names) if any, else the slot's name, else "".
 * `source` is null for a slot with nothing in memory.
 * `padCount` counts every pad that would be displayed (from the card or edited).
 * @param {object} crate
 * @returns {{ id: string, slot: number, name: string, source: "card"|"manual"|null, padCount: number }[]}
 */
export function listSlots(crate) {
  const list = [];
  for (let n = 1; n <= SLOT_COUNT; n++) {
    const id = slotId(n);
    const entry = crate?.memory?.[id];
    const ids = new Set([...Object.keys(entry?.pads ?? {}), ...Object.keys(crate?.overrides?.[id] ?? {})]);
    const name = crate?.names?.[id] || entry?.name || '';
    list.push({ id, slot: n, name, source: entry?.source ?? null, padCount: ids.size });
  }
  return list;
}

// ---------- Search ----------

/**
 * @typedef {Object} MemoryHit
 * @property {"memory"} kind
 * @property {string} name      Shown name (with the hand edit).
 * @property {string} where     "Memory 01, bank C, pad 7"
 * @property {string} slotId    "slot-01"
 * @property {number} slot      1
 * @property {string} bank      "C"
 * @property {string} padId     "C7"
 * @property {number|null} sec  playSec
 */

/**
 * @typedef {Object} SampleHit
 * @property {"sample"} kind
 * @property {string} name     Sample name (file name without extension).
 * @property {string} where    Its folder, "IMPORT/drums-loops" ("SD card" at the root).
 * @property {string} path     Card path, key of readCard's `files` map.
 * @property {string} folder
 * @property {number|null} sec
 */

/**
 * @typedef {Object} CardPadHit
 * @property {"card"} kind
 * @property {string} name
 * @property {string} where      "Card project OLD, bank A, pad 2"
 * @property {string} projectId  "card-P1_OLD"
 * @property {string} bank
 * @property {string} padId
 * @property {number|null} sec   playSec
 */

/**
 * Search memory pads, card samples and card-project pads by name, ignoring
 * case and accents. Results come in that order: memory (slot, bank, pad), then
 * card samples (card order), then card-project pads (card order, bank, pad).
 * An empty or blank query returns [].
 *
 * @param {object} crate
 * @param {string} query
 * @param {number} [limit=Infinity]  Stop after this many results.
 * @returns {(MemoryHit|SampleHit|CardPadHit)[]}
 */
export function searchAll(crate, query, limit = Infinity) {
  const q = plain(query).trim();
  const hits = [];
  if (q === '') return hits;
  const full = () => hits.length >= limit;
  const matches = (name) => plain(name).includes(q);
  const two = (n) => String(n).padStart(2, '0');

  // Memory, with hand edits applied.
  for (const s of listSlots(crate)) {
    if (s.padCount === 0) continue;
    for (const bank of BANKS) {
      const pads = getDisplayPads(crate, s.id, bank);
      for (const [padId, pad] of Object.entries(pads)) {
        if (!matches(pad.name)) continue;
        const where = `Memory ${two(s.slot)}, bank ${bank}, pad ${padId.slice(1)}`;
        hits.push({ kind: 'memory', name: pad.name, where, slotId: s.id, slot: s.slot, bank, padId, sec: pad.playSec ?? null });
        if (full()) return hits;
      }
    }
  }

  const card = crate?.card;
  for (const sample of Array.isArray(card?.samples) ? card.samples : []) {
    if (!sample || !matches(sample.name)) continue;
    hits.push({
      kind: 'sample',
      name: sample.name,
      where: sample.folder || 'SD card',
      path: sample.path,
      folder: sample.folder ?? '',
      sec: sample.sec ?? null,
    });
    if (full()) return hits;
  }

  for (const project of Array.isArray(card?.projects) ? card.projects : []) {
    if (!project) continue;
    for (const bank of BANKS) {
      for (const padId of bankPadIds(bank)) {
        const pad = project.pads?.[padId];
        if (!pad || !matches(pad.name)) continue;
        hits.push({
          kind: 'card',
          name: pad.name,
          where: `Card project ${project.name || project.folder}, bank ${bank}, pad ${padId.slice(1)}`,
          projectId: project.id,
          bank,
          padId,
          sec: pad.playSec ?? null,
        });
        if (full()) return hits;
      }
    }
  }
  return hits;
}

// ---------- Overrides (same rules as api.php `pad`) ----------

function cloneOverrides(crate) {
  const overrides = {};
  for (const [id, o] of Object.entries(crate?.overrides ?? {})) {
    overrides[id] = {};
    for (const [padId, f] of Object.entries(o)) overrides[id][padId] = { ...f };
  }
  return overrides;
}

/**
 * Set a hand edit on one pad of a memory slot (an optimistic copy of what the
 * server does). `name: ''`/null clears the name, `playSec: null|''` clears the
 * length, a key left out keeps its value, an empty edit is removed.
 * @param {object} crate
 * @param {string} slotId
 * @param {string} padId
 * @param {{ name?: string|null, playSec?: number|null }} fields
 * @returns {object} New crate (memory, names and card shared with the input).
 * @throws {Error} On an invalid slot or pad id, or a negative / non-numeric length.
 */
export function setOverride(crate, slotId, padId, fields) {
  if (slotNumber(slotId) === null) throw new Error(`Invalid slot "${slotId}"`);
  if (!PAD_ID_RE.test(padId)) throw new Error(`Invalid pad "${padId}"`);
  const f = fields ?? {};
  const overrides = cloneOverrides(crate);
  const entry = { ...(overrides[slotId]?.[padId] ?? {}) };
  if ('name' in f) {
    const name = f.name == null ? '' : String(f.name).trim();
    if (name === '') delete entry.name;
    else entry.name = name;
  }
  if ('playSec' in f) {
    const v = f.playSec;
    if (v === undefined || v === null || v === '') delete entry.playSec;
    else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) entry.playSec = v;
    else throw new Error('Length must be zero or a positive number of seconds');
  }
  const slotOverrides = { ...(overrides[slotId] ?? {}) };
  if (Object.keys(entry).length > 0) slotOverrides[padId] = entry;
  else delete slotOverrides[padId];
  if (Object.keys(slotOverrides).length > 0) overrides[slotId] = slotOverrides;
  else delete overrides[slotId];
  return { ...crate, overrides };
}

/**
 * Remove the hand edit of one pad (Use SD card value / Clear pad).
 * @param {object} crate
 * @param {string} slotId
 * @param {string} padId
 * @returns {object} New crate.
 */
export function clearOverride(crate, slotId, padId) {
  const overrides = cloneOverrides(crate);
  if (overrides[slotId]) {
    delete overrides[slotId][padId];
    if (Object.keys(overrides[slotId]).length === 0) delete overrides[slotId];
  }
  return { ...crate, overrides };
}
