// store.js — app state, overrides, JSON export/import, localStorage persistence.
// Pure state functions take and return plain objects (no DOM, no storage) so the
// Node tests can import them. Only load() and save() touch localStorage.

import { BANKS } from './padconf.js';

/** localStorage key for the whole state document. */
export const STORAGE_KEY = 'sp404vault.v1';

/** Current state schema version. */
export const STATE_VERSION = 1;

/** Valid pad ids: bank letter A..J + pad number 1..16. */
const PAD_ID_RE = /^[A-J](?:[1-9]|1[0-6])$/;

/** Keys never copied from untrusted JSON (prototype pollution guard). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @typedef {Object} Pad
 * @property {string} name
 * @property {number} playSec
 * @property {number} fullSec
 * @property {number} channels
 * @property {boolean} approx
 */

/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} name
 * @property {string} folder
 * @property {"sd"|"manual"} source
 * @property {string} importedAt  ISO date.
 * @property {number|null} slot   NN from a PROJECT_NN folder, otherwise null.
 * @property {Object<string, Pad>} pads  Only loaded pads, keyed "A1".."J16".
 */

/**
 * @typedef {Object} State
 * @property {1} version
 * @property {Object<string, Project>} projects
 * @property {Object<string, Object<string, {name?: string, playSec?: number}>>} overrides
 * @property {{ projectId: string|null, bank: string }} ui
 */

// ---------- Helpers ----------

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isLength(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Slot number from a "slot-NN" project id, else null. */
function slotFromId(id) {
  const m = /^slot-(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** Pad ids of one bank, "A1".."A16". */
function bankPadIds(bank) {
  const ids = [];
  for (let n = 1; n <= 16; n++) ids.push(`${bank}${n}`);
  return ids;
}

/** Shallow-copy every level of state we might change. */
function cloneState(state) {
  const projects = {};
  for (const [id, p] of Object.entries(state.projects ?? {})) projects[id] = { ...p, pads: { ...p.pads } };
  const overrides = {};
  for (const [id, o] of Object.entries(state.overrides ?? {})) {
    overrides[id] = {};
    for (const [padId, f] of Object.entries(o)) overrides[id][padId] = { ...f };
  }
  return {
    version: STATE_VERSION,
    projects,
    overrides,
    ui: { projectId: state.ui?.projectId ?? null, bank: state.ui?.bank ?? 'A' },
  };
}

// ---------- Pure state functions ----------

/**
 * Create an empty state document.
 * @returns {State}
 */
export function createStore() {
  return { version: STATE_VERSION, projects: {}, overrides: {}, ui: { projectId: null, bank: 'A' } };
}

/**
 * Merge imported projects into state. Replaces `projects[id].pads` for each
 * imported project; never touches `overrides`.
 * Sets `ui.projectId` to the first imported project when none is selected
 * (or the selected one no longer exists).
 * @param {State} state
 * @param {import('./importer.js').ImportedProject[]} projects
 * @returns {State} New state.
 */
export function applyImport(state, projects) {
  const next = cloneState(state);
  const now = new Date().toISOString();
  for (const p of projects ?? []) {
    const pads = {};
    for (const [padId, pad] of Object.entries(p.pads ?? {})) pads[padId] = { ...pad };
    next.projects[p.id] = {
      id: p.id,
      name: p.name,
      folder: p.folder,
      source: 'sd',
      importedAt: p.importedAt ?? now,
      slot: p.slot ?? slotFromId(p.id),
      pads,
    };
  }
  const current = next.ui.projectId;
  if ((current == null || !next.projects[current]) && projects && projects.length > 0) {
    next.ui.projectId = projects[0].id;
  }
  return next;
}

/**
 * Set a manual override for one pad. A manual edit wins over the SD value.
 * Field rules: `name: ''` (or null/undefined given explicitly) clears the name
 * override; `playSec: undefined|null|''` given explicitly clears the length
 * override. A key that is absent from `fields` keeps its current override.
 * When no field is left, the override entry is removed.
 * @param {State} state
 * @param {string} projectId
 * @param {string} padId  e.g. "A1"
 * @param {{ name?: string, playSec?: number }} fields
 * @returns {State} New state.
 * @throws {Error} On an invalid pad id or a negative / non-numeric length.
 */
export function setOverride(state, projectId, padId, fields) {
  if (!PAD_ID_RE.test(padId)) throw new Error(`Invalid pad "${padId}"`);
  const f = fields ?? {};
  const next = cloneState(state);
  const entry = { ...(next.overrides[projectId]?.[padId] ?? {}) };

  if ('name' in f) {
    const name = f.name == null ? '' : String(f.name).trim();
    if (name === '') delete entry.name;
    else entry.name = name;
  }
  if ('playSec' in f) {
    const v = f.playSec;
    if (v === undefined || v === null || v === '') delete entry.playSec;
    else if (isLength(v)) entry.playSec = v;
    else throw new Error('Length must be zero or a positive number of seconds');
  }

  const projectOverrides = { ...(next.overrides[projectId] ?? {}) };
  if (Object.keys(entry).length > 0) projectOverrides[padId] = entry;
  else delete projectOverrides[padId];

  if (Object.keys(projectOverrides).length > 0) next.overrides[projectId] = projectOverrides;
  else delete next.overrides[projectId];
  return next;
}

/**
 * Remove the manual override for one pad (Reset to SD value).
 * @param {State} state
 * @param {string} projectId
 * @param {string} padId
 * @returns {State} New state.
 */
export function clearOverride(state, projectId, padId) {
  const next = cloneState(state);
  const projectOverrides = next.overrides[projectId];
  if (projectOverrides) {
    delete projectOverrides[padId];
    if (Object.keys(projectOverrides).length === 0) delete next.overrides[projectId];
  }
  return next;
}

/**
 * Pads to display for one bank: `{ ...pads[id], ...overrides[id] }`, plus an
 * `edited` flag when an override exists and a `fromSd` flag when the pad has an
 * imported value (so "Reset to SD value" can be offered).
 * A pad that only has an override (manual project, or an empty pad typed in by
 * hand) appears with `fullSec`/`channels` = null and `playSec` = null unless set.
 * @param {State} state
 * @param {string} projectId
 * @param {string} bank  "A".."J"
 * @returns {Object<string, Pad & { edited: boolean, fromSd: boolean }>} Keyed by pad id, only non-empty pads.
 */
export function getDisplayPads(state, projectId, bank) {
  const out = {};
  if (projectId == null || !BANKS.includes(bank) || bank.length !== 1) return out;
  const pads = state.projects?.[projectId]?.pads ?? {};
  const overrides = state.overrides?.[projectId] ?? {};
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
 * Add an empty manual project (`source: "manual"`, id `manual-<timestamp>`)
 * and select it (`ui.projectId`, bank A).
 * @param {State} state
 * @param {string} name
 * @param {number} [now=Date.now()]  Injected for tests.
 * @returns {{ state: State, projectId: string }}
 */
export function addManualProject(state, name, now = Date.now()) {
  const next = cloneState(state);
  let projectId = `manual-${now}`;
  for (let n = 2; next.projects[projectId]; n++) projectId = `manual-${now}-${n}`;
  const clean = String(name ?? '').trim() || 'Untitled project';
  next.projects[projectId] = {
    id: projectId,
    name: clean,
    folder: '',
    source: 'manual',
    importedAt: new Date(now).toISOString(),
    slot: null,
    pads: {},
  };
  next.ui = { projectId, bank: 'A' };
  return { state: next, projectId };
}

/**
 * Change the remembered view (selected project and/or bank).
 * @param {State} state
 * @param {{ projectId?: string|null, bank?: string }} view
 * @returns {State} New state.
 */
export function setView(state, view) {
  const next = cloneState(state);
  if (view && 'projectId' in view) next.ui.projectId = view.projectId ?? null;
  if (view && typeof view.bank === 'string' && view.bank.length === 1 && BANKS.includes(view.bank)) {
    next.ui.bank = view.bank;
  }
  return next;
}

/**
 * Projects for the selector, sorted by slot number (slotless last), then name.
 * `padCount` counts every pad that would be displayed (imported or edited).
 * @param {State} state
 * @returns {{ id: string, name: string, folder: string, source: "sd"|"manual", slot: number|null, padCount: number }[]}
 */
export function listProjects(state) {
  const list = Object.values(state.projects ?? {}).map((p) => {
    const ids = new Set([...Object.keys(p.pads ?? {}), ...Object.keys(state.overrides?.[p.id] ?? {})]);
    const slot = p.slot ?? slotFromId(p.id);
    return { id: p.id, name: p.name, folder: p.folder ?? '', source: p.source, slot, padCount: ids.size };
  });
  list.sort((a, b) => {
    if (a.slot !== b.slot) {
      if (a.slot == null) return 1;
      if (b.slot == null) return -1;
      return a.slot - b.slot;
    }
    return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  });
  return list;
}

/**
 * Which banks hold anything to show: an imported pad or a manual edit
 * (same rule as getDisplayPads, so a bank is never dimmed while showing a pad).
 * @param {State} state
 * @param {string} projectId
 * @returns {Object<string, boolean>} { A: bool, ..., J: bool }
 */
export function bankHasSamples(state, projectId) {
  const result = {};
  for (const b of BANKS) result[b] = false;
  const ids = [
    ...Object.keys(state.projects?.[projectId]?.pads ?? {}),
    ...Object.keys(state.overrides?.[projectId] ?? {}),
  ];
  for (const id of ids) if (id[0] in result) result[id[0]] = true;
  return result;
}

/**
 * Serialize state for the JSON export download.
 * @param {State} state
 * @returns {string} JSON text.
 */
export function toJSON(state) {
  return JSON.stringify(cloneState(state), null, 2);
}

/**
 * Validate a parsed state document and return a clean copy.
 * Unknown keys are dropped; malformed pads and overrides are skipped.
 * @param {unknown} data
 * @returns {State}
 * @throws {Error} With a user-readable message.
 */
function normalizeState(data) {
  if (!isObject(data)) throw new Error('This file is not an SP404Vault export.');
  if (data.version !== STATE_VERSION) {
    throw new Error(
      data.version === undefined
        ? 'This file is not an SP404Vault export (no version).'
        : `This export has version ${JSON.stringify(data.version)}; this app reads version ${STATE_VERSION}.`,
    );
  }
  if (!isObject(data.projects)) throw new Error('This export has no project list.');
  if (data.overrides !== undefined && !isObject(data.overrides)) throw new Error('This export has invalid manual edits.');

  const state = createStore();
  for (const [id, p] of Object.entries(data.projects)) {
    if (UNSAFE_KEYS.has(id)) continue;
    if (!isObject(p)) throw new Error(`Project "${id}" in this export is invalid.`);
    const pads = {};
    for (const [padId, pad] of Object.entries(isObject(p.pads) ? p.pads : {})) {
      if (!PAD_ID_RE.test(padId) || !isObject(pad)) continue;
      pads[padId] = {
        name: typeof pad.name === 'string' ? pad.name : '',
        playSec: isLength(pad.playSec) ? pad.playSec : null,
        fullSec: isLength(pad.fullSec) ? pad.fullSec : null,
        channels: pad.channels === 1 || pad.channels === 2 ? pad.channels : 2,
        approx: Boolean(pad.approx),
      };
    }
    state.projects[id] = {
      id,
      name: typeof p.name === 'string' && p.name !== '' ? p.name : id,
      folder: typeof p.folder === 'string' ? p.folder : '',
      source: p.source === 'manual' ? 'manual' : 'sd',
      importedAt: typeof p.importedAt === 'string' ? p.importedAt : '',
      slot: Number.isInteger(p.slot) ? p.slot : slotFromId(id),
      pads,
    };
  }
  for (const [projectId, o] of Object.entries(data.overrides ?? {})) {
    if (UNSAFE_KEYS.has(projectId) || !isObject(o)) continue;
    const clean = {};
    for (const [padId, f] of Object.entries(o)) {
      if (!PAD_ID_RE.test(padId) || !isObject(f)) continue;
      const entry = {};
      if (typeof f.name === 'string' && f.name !== '') entry.name = f.name;
      if (isLength(f.playSec)) entry.playSec = f.playSec;
      if (Object.keys(entry).length > 0) clean[padId] = entry;
    }
    if (Object.keys(clean).length > 0) state.overrides[projectId] = clean;
  }
  if (isObject(data.ui)) {
    const pid = data.ui.projectId;
    state.ui.projectId = typeof pid === 'string' && state.projects[pid] ? pid : null;
    if (typeof data.ui.bank === 'string' && data.ui.bank.length === 1 && BANKS.includes(data.ui.bank)) {
      state.ui.bank = data.ui.bank;
    }
  }
  if (state.ui.projectId === null) state.ui.projectId = listProjects(state)[0]?.id ?? null;
  return state;
}

/**
 * Parse and validate an imported JSON export. Replaces all state.
 * @param {string} text
 * @returns {State}
 * @throws {Error} When the JSON is invalid or `version` is not supported.
 */
export function fromJSON(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  return normalizeState(data);
}

// ---------- localStorage access (browser only) ----------

/**
 * Load state from localStorage. Every access is wrapped in try/catch; on
 * failure returns a fresh store and `ok: false` so the UI can warn.
 * Nothing saved yet (first visit) is `ok: true` with a fresh store.
 * @param {Storage} [storage] defaults to globalThis.localStorage (read inside the try)
 * @returns {{ state: State, ok: boolean }}
 */
export function load(storage) {
  try {
    // Resolved inside the try: reading globalThis.localStorage throws
    // SecurityError when site data is blocked.
    const s = storage ?? globalThis.localStorage;
    const raw = s.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return { state: createStore(), ok: true };
    return { state: fromJSON(raw), ok: true };
  } catch {
    return { state: createStore(), ok: false };
  }
}

/**
 * Save state to localStorage (try/catch wrapped).
 * @param {State} state
 * @param {Storage} [storage] defaults to globalThis.localStorage (read inside the try)
 * @returns {boolean} true when saved.
 */
export function save(state, storage) {
  try {
    const s = storage ?? globalThis.localStorage;
    s.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
