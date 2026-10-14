// app.js — the SP404MK2 crate front end.
// The server (api.php) keeps the crate: the sampler's memory (16 slots) and the list of what
// is on the SD card. This page shows both and sends changes. No audio is ever uploaded: a
// sound plays only in a tab where the card folder was picked, straight from this computer.
// All data goes into the page with textContent, never as HTML.

import { readCard, findPadFile } from './importer.js';
import { getDisplayPads, listSlots, bankHasSamples, searchAll } from './store.js';
import { BANKS, decodeSmp } from './padconf.js';

const BANK_LIST = BANKS.split('');
const PAD_RE = /^[A-J](?:[1-9]|1[0-6])$/;
const SLOTS = 16;
const MAX_RESULTS = 200;
const MAX_BODY_CHARS = 1950000; // the server takes at most 2 MB per request
const LAST_SLOT_KEY = 'sp404crate.slot';
const OTHER_KEY = '~other';
const EXPORT_KEY = '~export';

const $ = (id) => document.getElementById(id);
const home = $('home'), cardScreen = $('card'), problemStrip = $('problem');
const padSheet = $('padSheet'), nameSheet = $('nameSheet'), gate = $('gate');
const search = $('search'), tabs = $('tabs'), pads = $('pads');
const cpTabs = $('cpTabs'), cpPads = $('cpPads');

/** The crate as the server last sent it. */
let crate = emptyCrate();
/** The card folder picked in this tab: card path -> File. Never leaves this computer. */
const session = { files: null };
/** What the screens show. */
const view = { route: null, slot: 1, bank: 'A', mark: null };
/** The pad open in the pad sheet. */
let editing = null;
let gateMode = 'login';
let returnFocus = null;
// A sheet adds one history entry so the phone's back button closes it.
let layerEntry = false;
let afterLayerPop = null;
/** Scroll positions by screen, restored when the back button returns to one. */
const scrolls = new Map();
/** The result of "Load all projects into memory", shown until the card menu is left. */
let loadAllReport = null;

// ── Server ──────────────────────────────────────────────────────────────────

async function api(action, body) {
  const options = { headers: { 'X-Crate': '1' }, credentials: 'same-origin' };
  if (body) {
    Object.assign(options, { method: 'POST', body: JSON.stringify(body) });
    options.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch('api.php?a=' + action, options);
  } catch {
    throw new Error('No connection. Check the internet and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && action !== 'login' && action !== 'setup') showGate('login');
  if (!res.ok || data.ok === false) throw new Error(data.error || 'The server failed. Try again.');
  return data;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function emptyCrate() {
  return { memory: {}, overrides: {}, names: {}, card: null };
}

const own = (obj, key) => (obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pad2 = (n) => String(n).padStart(2, '0');
const slotKey = (n) => 'slot-' + pad2(n);
const validSlot = (n) => Number.isInteger(n) && n >= 1 && n <= SLOTS;
const plural = (n, one, many) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Seconds as m:ss.s (rounded to tenths first, so 59.96 s reads 1:00.0). */
function formatLength(sec) {
  const tenths = Math.round(sec * 10);
  const m = Math.floor(tenths / 600);
  const s = ((tenths % 600) / 10).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

const hasLength = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** m:ss.s, ss.s or m:ss as seconds. Empty is null, anything unreadable is NaN. */
function parseLength(text) {
  const t = String(text).trim().replace(/^≈/, '');
  if (t === '') return null;
  const match = /^(?:(\d+):)?(\d+(?:[.,]\d+)?)$/.exec(t);
  if (!match) return NaN;
  const min = match[1] ? Number(match[1]) : 0;
  const sec = Number(match[2].replace(',', '.'));
  if (match[1] && sec >= 60) return NaN;
  return min * 60 + sec;
}

/** "14 Oct 2026" */
function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function say(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A sample name that may break after _ - . / (and anywhere else if it has to). */
function breakable(text) {
  const frag = document.createDocumentFragment();
  for (const part of String(text).split(/(?<=[_.\-/])/)) {
    if (frag.childNodes.length) frag.append(document.createElement('wbr'));
    frag.append(part);
  }
  return frag;
}

function readLastSlot() {
  try {
    const n = Number(localStorage.getItem(LAST_SLOT_KEY));
    return validSlot(n) ? n : 1;
  } catch {
    return 1;
  }
}

function saveLastSlot(n) {
  try {
    localStorage.setItem(LAST_SLOT_KEY, String(n));
  } catch {
    // Per-device convenience only; nothing to do when storage is blocked.
  }
}

// ── Crate ───────────────────────────────────────────────────────────────────

function setCrate(next) {
  const card = isObj(next?.card) ? next.card : null;
  crate = {
    memory: isObj(next?.memory) ? next.memory : {},
    overrides: isObj(next?.overrides) ? next.overrides : {},
    names: isObj(next?.names) ? next.names : {},
    card: card && {
      readAt: card.readAt ?? null,
      samples: Array.isArray(card.samples) ? card.samples : [],
      projects: Array.isArray(card.projects) ? card.projects : [],
      sx: Array.isArray(card.sx) ? card.sx : [],
    },
  };
  groupsCache = null;
}

async function load() {
  const data = await api('list');
  setCrate(data.crate);
}

/** Take the crate from a write's answer, or ask for it when the answer has none. */
async function takeCrate(data) {
  if (isObj(data?.crate)) setCrate(data.crate);
  else await load();
}

/** The 16 memory slots with the names people see (a rename wins over the project's name). */
function slots() {
  const rows = listSlots(crate);
  return Array.from({ length: SLOTS }, (_, i) => {
    const slot = i + 1;
    const id = slotKey(slot);
    const row = rows.find((r) => r.id === id || r.slot === slot) ?? {};
    const mem = own(crate.memory, id);
    const name = own(crate.names, id) || mem?.name || row.name || '';
    return { id, slot, name, source: mem?.source ?? row.source ?? null, padCount: row.padCount ?? 0, mem };
  });
}

function slotInfo(n) {
  return slots()[n - 1];
}

/** True when the slot holds anything at all: pads, edits or a name. */
function slotUsed(n) {
  const id = slotKey(n);
  return Boolean(own(crate.memory, id) || Object.keys(own(crate.overrides, id) ?? {}).length || own(crate.names, id));
}

const slotLabel = (s) => `${pad2(s.slot)} ${s.name || 'Empty'}`;

function cardProjects() {
  return (crate.card?.projects ?? []).slice().sort((a, b) => {
    const sa = validSlot(a.slot) ? a.slot : 99, sb = validSlot(b.slot) ? b.slot : 99;
    return sa - sb || natural.compare(a.name || a.folder, b.name || b.folder);
  });
}

const findCardProject = (id) => (crate.card?.projects ?? []).find((p) => p.id === id) ?? null;
const cardProjectName = (p) => p.name || p.folder || p.id;

// ── Sample folders ──────────────────────────────────────────────────────────

let groupsCache = null;

/** Which list a sample's folder belongs in: each IMPORT folder, the exported samples, or Other. */
function groupOf(folder) {
  const f = String(folder ?? '');
  const imp = /^(?:.*\/)?IMPORT\/(.+)$/i.exec(f);
  if (imp) return { key: f, label: imp[1], order: 0 };
  if (/^(?:.*\/)?EXPORT\/SAMPLE$/i.test(f)) return { key: EXPORT_KEY, label: 'Exported samples', order: 1 };
  const exp = /^(?:.*\/)?EXPORT\/SAMPLE\/(.+)$/i.exec(f);
  if (exp) return { key: f, label: `Exported samples/${exp[1]}`, order: 1 };
  return { key: OTHER_KEY, label: 'Other', order: 2 };
}

/** Sample folders in list order, each with its samples sorted by name (numbers in natural order). */
function sampleGroups() {
  if (groupsCache) return groupsCache;
  const byKey = new Map();
  for (const s of crate.card?.samples ?? []) {
    if (!isObj(s) || typeof s.path !== 'string') continue;
    const g = groupOf(s.folder);
    if (!byKey.has(g.key)) byKey.set(g.key, { ...g, samples: [] });
    byKey.get(g.key).samples.push(s);
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.samples.sort((a, b) => natural.compare(a.name ?? '', b.name ?? '') || natural.compare(a.path, b.path));
  groups.sort((a, b) => a.order - b.order || natural.compare(a.label, b.label));
  groupsCache = groups;
  return groups;
}

// ── Card files picked in this tab ───────────────────────────────────────────

function setFiles(files) {
  session.files = files instanceof Map ? files : new Map(files ?? []);
}

/** The SMP file for a pad of the project in `folder`: SMPL/BANK<1-10>-<01-16>.SMP. */
function smpFile(folder, padId) {
  return session.files ? findPadFile(session.files, folder, padId) : null;
}

/** What to play for a pad, or null when this tab has no sound for it. */
function padSound(folder, pad, padId, key, label) {
  if (!pad) return null;
  const file = smpFile(folder, padId);
  if (!file) return null;
  return { key, label, kind: 'smp', file, start: pad.start, end: pad.end };
}

function memorySound(slot, padId, label) {
  const mem = own(crate.memory, slotKey(slot));
  if (!mem || mem.source !== 'card') return null;
  return padSound(mem.folder, own(mem.pads, padId), padId, `m:${slot}:${padId}`, label);
}

function cardPadSound(project, padId, label) {
  return padSound(project.folder, own(project.pads, padId), padId, `c:${project.id}:${padId}`, label);
}

function sampleSound(sample) {
  const file = session.files?.get(sample.path);
  if (!file) return null;
  return { key: 's:' + sample.path, label: sample.name || sample.path, kind: 'file', file, ext: String(sample.ext || '').toLowerCase() };
}

// ── Playback: one sound at a time ───────────────────────────────────────────

const player = { key: null, label: '', audio: null, url: null, source: null, token: 0 };
let audioCtx = null;
let barTimer = 0;

/** The Web Audio context, made and resumed inside the tap so the browser lets it play. */
function audioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error("This browser can't play sounds.");
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function stopPlayback({ keepBar = false } = {}) {
  player.token++;
  if (player.audio) {
    const a = player.audio;
    a.onended = a.onerror = null;
    a.pause();
    a.removeAttribute('src');
    try { a.load(); } catch { /* already released */ }
  }
  if (player.url) URL.revokeObjectURL(player.url);
  if (player.source) {
    player.source.onended = null;
    try { player.source.stop(); } catch { /* not started */ }
    player.source.disconnect();
  }
  player.audio = player.url = player.source = null;
  player.key = null;
  syncPlayButtons();
  if (!keepBar) hideBar();
}

async function togglePlay(sound) {
  if (!sound) return;
  if (player.key === sound.key) {
    stopPlayback();
    return;
  }
  stopPlayback({ keepBar: true });
  const token = player.token;
  player.key = sound.key;
  player.label = sound.label;
  syncPlayButtons();
  showBar('Playing ' + sound.label);
  try {
    if (sound.kind === 'smp') await playSmp(sound, token);
    else await playFile(sound, token);
  } catch (err) {
    if (token !== player.token) return;
    stopPlayback({ keepBar: true });
    showMessage(err.message || "This sound can't play.");
  }
}

function playFile(sound, token) {
  const aiff = sound.ext === 'aif' || sound.ext === 'aiff';
  // Unlock Web Audio inside the tap too, in case the AIFF has to be decoded by hand.
  if (aiff) audioContext();
  const url = URL.createObjectURL(sound.file);
  const audio = new Audio(url);
  player.audio = audio;
  player.url = url;
  audio.onended = () => {
    if (token === player.token) stopPlayback();
  };
  return audio.play().catch(async (err) => {
    if (token !== player.token) return;
    if (err && err.name === 'NotAllowedError') throw new Error('The browser blocked the sound. Tap play again.');
    if (!aiff) throw new Error("This file can't play in this browser.");
    // Not every browser plays AIFF in <audio>: release it and try Web Audio.
    audio.onended = null;
    audio.removeAttribute('src');
    URL.revokeObjectURL(url);
    player.audio = player.url = null;
    const ctx = audioContext();
    let buffer;
    try {
      buffer = await ctx.decodeAudioData(await sound.file.arrayBuffer());
    } catch {
      throw new Error("This file type can't play in this browser.");
    }
    playBuffer(ctx, buffer, token);
  });
}

async function playSmp(sound, token) {
  const ctx = audioContext();
  const start = Number.isFinite(sound.start) ? sound.start : undefined;
  const end = Number.isFinite(sound.end) ? sound.end : undefined;
  const data = decodeSmp(await sound.file.arrayBuffer(), start, end);
  if (token !== player.token) return;
  if (!data.left.length) throw new Error('This pad has no sound between its start and end.');
  const buffer = ctx.createBuffer(data.right ? 2 : 1, data.left.length, data.sampleRate || 48000);
  buffer.copyToChannel(data.left, 0);
  if (data.right) buffer.copyToChannel(data.right, 1);
  playBuffer(ctx, buffer, token);
}

function playBuffer(ctx, buffer, token) {
  if (token !== player.token) return;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = () => {
    if (token === player.token) stopPlayback();
  };
  player.source = source;
  source.start();
}

/** Every play button shows play or stop, and says which in its label. */
function syncPlayButtons() {
  for (const b of document.querySelectorAll('button.play')) {
    const on = b.dataset.key === player.key;
    b.classList.toggle('playing', on);
    b.setAttribute('aria-label', (on ? 'Stop ' : 'Play ') + b.dataset.label);
    b.title = on ? 'Stop' : 'Play';
  }
}

function playButton(sound) {
  const b = make('button', 'play');
  b.type = 'button';
  b.dataset.key = sound.key;
  b.dataset.label = sound.label;
  b.onclick = (e) => {
    e.stopPropagation();
    togglePlay(sound);
  };
  const on = sound.key === player.key;
  b.classList.toggle('playing', on);
  b.setAttribute('aria-label', (on ? 'Stop ' : 'Play ') + sound.label);
  b.title = on ? 'Stop' : 'Play';
  return b;
}

function showBar(text) {
  clearTimeout(barTimer);
  const bar = $('playerBar');
  bar.classList.remove('message');
  $('playerText').textContent = text;
  $('playerStop').textContent = 'Stop';
  bar.hidden = false;
}

function showMessage(text) {
  clearTimeout(barTimer);
  const bar = $('playerBar');
  bar.classList.add('message');
  $('playerText').textContent = text;
  $('playerStop').textContent = 'OK';
  bar.hidden = false;
  barTimer = setTimeout(hideBar, 7000);
}

function hideBar() {
  clearTimeout(barTimer);
  $('playerBar').hidden = true;
}

$('playerStop').onclick = () => {
  if (player.key) stopPlayback();
  else hideBar();
};

// ── Layers (sheets) ─────────────────────────────────────────────────────────

/** Only one full-screen layer is open at a time; the page behind must not scroll. */
function show(layer) {
  for (const each of [padSheet, nameSheet, gate]) each.hidden = each !== layer;
  document.body.classList.toggle('locked', Boolean(layer));
  if (layer) layer.scrollTop = 0;
}

function openLayer(layer, focusEl) {
  returnFocus = document.activeElement;
  show(layer);
  if (!layerEntry) {
    history.pushState({ ...(history.state || {}), layer: true }, '');
    layerEntry = true;
  }
  if (focusEl) focusEl.focus({ preventScroll: true });
}

/** Close the open sheet, then run `then` once the history is back where it was. */
function closeLayer(then) {
  show(null);
  const done = () => {
    if (then) then();
    else if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  };
  if (layerEntry) {
    layerEntry = false;
    afterLayerPop = done;
    history.back();
  } else {
    done();
  }
}

window.addEventListener('popstate', () => {
  if (afterLayerPop) {
    const f = afterLayerPop;
    afterLayerPop = null;
    f();
    return;
  }
  if (layerEntry) {
    // The back button was pressed with a sheet open: close it and stay here.
    layerEntry = false;
    closeLayer();
    return;
  }
  if (!gate.hidden) return;
  route({ restore: true });
});

// ── Routes ──────────────────────────────────────────────────────────────────
//   #m=01&b=A[&pad=A7][&q=text]       memory slot, bank, marked pad, search
//   #card                             the card menu
//   #card/s                           sample folders
//   #card/s/<folder>[&mark=<path>]    samples in one folder, one marked
//   #card/p                           card projects
//   #card/p/<id>&b=A[&pad=A2]         one card project
//   #card/sx                          SP-404SX projects

function parseRoute(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (h === 'card' || h.startsWith('card/') || h.startsWith('card&')) {
    const amp = h.indexOf('&');
    const path = amp === -1 ? h : h.slice(0, amp);
    const q = new URLSearchParams(amp === -1 ? '' : h.slice(amp + 1));
    const [, kind = '', ...rest] = path.split('/');
    let arg = null;
    if (rest.length) {
      try {
        arg = decodeURIComponent(rest.join('/'));
      } catch {
        arg = null;
      }
    }
    if (kind === 's' && arg != null) return { screen: 'card', view: 'folder', key: arg, mark: q.get('mark') };
    if (kind === 's') return { screen: 'card', view: 'samples' };
    if (kind === 'p' && arg != null) return { screen: 'card', view: 'project', id: arg, bank: q.get('b'), pad: q.get('pad') };
    if (kind === 'p') return { screen: 'card', view: 'projects' };
    if (kind === 'sx') return { screen: 'card', view: 'sx' };
    return { screen: 'card', view: 'menu' };
  }
  const q = new URLSearchParams(h);
  const m = Number(q.get('m'));
  return { screen: 'memory', slot: validSlot(m) ? m : null, bank: q.get('b'), pad: q.get('pad'), q: q.get('q') || '' };
}

function memoryHash(slot, bank, pad, query) {
  const q = new URLSearchParams({ m: pad2(slot), b: bank });
  if (pad) q.set('pad', pad);
  if (query) q.set('q', query);
  return '#' + q.toString();
}

function cardHash(kind, arg, params) {
  let h = '#card' + (kind ? '/' + kind : '') + (arg != null ? '/' + encodeURIComponent(arg) : '');
  if (params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    const s = q.toString();
    if (s) h += '&' + s;
  }
  return h;
}

/** A screen's identity without its marks: two hashes with the same key are the same screen. */
function routeKey(r) {
  if (r.screen === 'memory') return r.q ? 'search' : 'memory';
  return ['card', r.view, r.key ?? r.id ?? ''].join('/');
}

/** Where the in-page back button leads when the page was opened straight from an address. */
function parentHash(r) {
  if (r.screen === 'memory') return null;
  if (r.view === 'menu') return memoryHash(view.slot, firstBank(view.slot));
  if (r.view === 'folder') return cardHash('s');
  if (r.view === 'project') return cardHash('p');
  return cardHash();
}

function routeName(r) {
  if (r.screen === 'memory') return r.q ? 'Search' : 'Memory';
  if (r.view === 'menu') return 'SD card';
  if (r.view === 'samples') return 'Sample';
  if (r.view === 'projects') return 'Project';
  if (r.view === 'sx') return 'Project (SX)';
  if (r.view === 'folder') return sampleGroups().find((g) => g.key === r.key)?.label ?? 'Sample';
  const p = findCardProject(r.id);
  return p ? cardProjectName(p) : 'Project';
}

/** Go forward to another screen; the back button returns here. */
function go(hash) {
  if (view.route) scrolls.set(routeKey(view.route), window.scrollY);
  history.pushState({ from: location.hash || '#' }, '', hash);
  route();
}

/** The in-page back button: where this screen was opened from, or its parent. */
function goBack() {
  const from = history.state?.from;
  if (from) {
    history.back();
    return;
  }
  const parent = parentHash(view.route);
  if (!parent) return;
  history.replaceState(null, '', parent);
  route();
}

/** Show the screen the address asks for. `restore` is true when the back button brought us here. */
function route({ restore = false } = {}) {
  const r = parseRoute(location.hash);
  const before = view.route;
  const sameScreen = before && routeKey(before) === routeKey(r);
  if (before && before.screen === 'card' && before.view === 'menu' && !(r.screen === 'card' && r.view === 'menu')) loadAllReport = null;
  view.route = r;
  problemStrip.hidden = true;
  home.hidden = r.screen !== 'memory';
  cardScreen.hidden = r.screen !== 'card';

  if (!sameScreen) {
    hideLoad();
    hideConfirm();
  }
  let focusEl = null;
  if (r.screen === 'memory') focusEl = showMemory(r);
  else focusEl = showCard(r);

  if (sameScreen) return;
  const marked = document.querySelector('#home:not([hidden]) .marked, #card:not([hidden]) .marked');
  if (marked) {
    marked.scrollIntoView({ block: 'center' });
    (marked.matches('button') ? marked : marked.querySelector('button') ?? marked).focus({ preventScroll: true });
  } else if (restore && scrolls.has(routeKey(r))) {
    window.scrollTo(0, scrolls.get(routeKey(r)));
  } else if (before) {
    window.scrollTo(0, 0);
    if (focusEl) focusEl.focus({ preventScroll: true });
  }
}

/** The first bank with something in it, or A. */
function firstBank(slot) {
  const has = bankHasSamples(crate, slotKey(slot)) ?? {};
  return BANK_LIST.find((b) => has[b]) ?? 'A';
}

// ── Home: memory ────────────────────────────────────────────────────────────

function showMemory(r) {
  const slot = r.slot ?? view.slot ?? readLastSlot();
  const bank = BANK_LIST.includes(r.bank) ? r.bank : firstBank(slot);
  const mark = r.pad && PAD_RE.test(r.pad) && r.pad[0] === bank ? r.pad : null;
  if (view.slot !== slot) hideConfirm();
  view.slot = slot;
  view.bank = bank;
  view.mark = mark;
  saveLastSlot(slot);
  if (search.value !== r.q && document.activeElement !== search) search.value = r.q;
  const canonical = memoryHash(slot, bank, mark, r.q);
  if (location.hash !== canonical) history.replaceState(history.state, '', canonical);
  renderHome();
  return $('slotName');
}

function renderHome() {
  const all = slots();
  const total = all.reduce((sum, s) => sum + s.padCount, 0);
  $('count').textContent = total ? plural(total, 'sample', 'samples') : '';
  $('openCardSub').textContent = crate.card?.readAt
    ? `SD card, read ${formatDate(crate.card.readAt)}`
    : 'SD card, not read yet';

  const q = search.value.trim();
  $('results').hidden = !q;
  $('memoryView').hidden = Boolean(q);
  if (q) renderResults(q);
  else renderMemory(all);
}

function renderMemory(all = slots()) {
  const select = $('slotSelect');
  select.replaceChildren(...all.map((s) => {
    const o = make('option', null, slotLabel(s));
    o.value = String(s.slot);
    return o;
  }));
  select.value = String(view.slot);

  const s = all[view.slot - 1];
  const parts = [`Slot ${pad2(s.slot)}`];
  if (s.mem?.source === 'card') parts.push(`from card folder ${s.mem.folder || s.mem.name || ''}`.trim());
  else if (s.mem || s.padCount) parts.push('written by hand');
  if (s.padCount) parts.push(plural(s.padCount, 'sample', 'samples'));
  $('slotLabel').textContent = parts.join(', ');
  $('slotName').textContent = s.name || 'Empty';
  $('slotName').classList.toggle('is-empty', !s.name);
  $('slotHint').hidden = s.padCount > 0;
  $('clearSlot').disabled = !slotUsed(s.slot);

  const id = slotKey(view.slot);
  renderTabs(tabs, bankHasSamples(crate, id) ?? {}, view.bank, 'pads', (b) => setBank(b));

  const shown = getDisplayPads(crate, id, view.bank) ?? {};
  const overrides = own(crate.overrides, id);
  renderGrid(pads, {
    bank: view.bank,
    mark: view.mark,
    pad: (padId) => own(shown, padId) ?? null,
    approx: (padId, pad) => pad.approx && !hasLength(own(own(overrides, padId), 'playSec')),
    sound: (padId, label) => memorySound(view.slot, padId, label),
    open: openPad,
  });
  say($('slotError'), '');
}

function setBank(bank, focusTab = false) {
  if (!BANK_LIST.includes(bank)) return;
  view.bank = bank;
  view.mark = null;
  history.replaceState(history.state, '', memoryHash(view.slot, bank));
  view.route = parseRoute(location.hash);
  renderMemory();
  if (focusTab) $('tab-pads-' + bank).focus();
}

$('slotSelect').onchange = (e) => {
  const slot = Number(e.target.value);
  if (!validSlot(slot)) return;
  hideConfirm();
  history.replaceState(history.state, '', memoryHash(slot, firstBank(slot)));
  route();
};

// ── Banks and pads (memory and card projects share them) ────────────────────

function renderTabs(container, has, current, gridId, onPick) {
  container.replaceChildren(...BANK_LIST.map((b) => {
    const tab = make('button', has[b] ? '' : 'none', b);
    tab.type = 'button';
    tab.id = `tab-${gridId}-${b}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(b === current));
    tab.setAttribute('aria-controls', gridId);
    tab.setAttribute('aria-label', `Bank ${b}${has[b] ? '' : ', empty'}`);
    tab.tabIndex = b === current ? 0 : -1;
    tab.onclick = () => onPick(b);
    return tab;
  }));
  $(gridId).setAttribute('aria-labelledby', `tab-${gridId}-${current}`);
}

/**
 * Pads 1-16 of one bank as a 4x4 grid. With `open`, each cell is a button that opens the pad
 * sheet; without it the grid is read only. A pad with a sound in this tab gets a play button.
 */
function renderGrid(container, { bank, mark, pad: getPad, approx, sound, open }) {
  const cells = [];
  for (let num = 1; num <= 16; num++) {
    const padId = bank + num;
    const pad = getPad(padId);
    const cell = make(open ? 'button' : 'div', 'pad');
    if (open) {
      cell.type = 'button';
      cell.onclick = () => open(padId);
    } else {
      cell.classList.add('readonly');
    }
    cell.dataset.pad = padId;
    if (padId === mark) {
      cell.classList.add('marked');
      if (!open) cell.tabIndex = -1;
    }
    if (!pad) cell.classList.add('blank');
    const name = pad ? pad.name || 'No name' : '';
    const isApprox = pad && approx(padId, pad);
    const length = pad && hasLength(pad.playSec) ? formatLength(pad.playSec) : '';
    const title = make('span', 'title');
    if (pad) title.append(breakable(name));
    else title.textContent = '—';
    const foot = make('span', 'foot');
    if (pad && pad.edited) foot.append(make('span', 'edited', 'edited'));
    if (length) foot.append(make('span', 'len', (isApprox ? '≈' : '') + length));
    cell.append(make('span', 'num', String(num)), title, foot);
    // The cell may cut the name short, so the full name is in the label and the tooltip.
    const label = [`Pad ${num}`, pad ? name : 'empty'];
    if (length) label.push((isApprox ? 'about ' : '') + length);
    if (pad && pad.edited) label.push('edited');
    if (open) cell.setAttribute('aria-label', label.join(', '));
    if (pad) cell.title = name;
    const li = make('li');
    li.append(cell);
    const s = pad ? sound(padId, `pad ${num}, ${name}`) : null;
    if (s) {
      cell.classList.add('playable');
      li.append(playButton(s));
    }
    cells.push(li);
  }
  container.replaceChildren(...cells);
  // One cell is in the tab order; the arrow keys move between the others.
  if (open) setPadStop(container, container.querySelector('.marked') ?? container.querySelector('.pad'));
}

// The banks sit in two rows of five, as on the sampler: left and right move along
// the row, up and down jump to the bank above or below.
function bankKeys(container, current, pick) {
  container.addEventListener('keydown', (e) => {
    const at = BANK_LIST.indexOf(current());
    const row = at - (at % 5);
    let next = null;
    if (e.key === 'ArrowRight') next = BANK_LIST[row + ((at % 5) + 1) % 5];
    else if (e.key === 'ArrowLeft') next = BANK_LIST[row + ((at % 5) + 4) % 5];
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') next = BANK_LIST[(at + 5) % 10];
    else if (e.key === 'Home') next = BANK_LIST[0];
    else if (e.key === 'End') next = BANK_LIST[BANK_LIST.length - 1];
    if (!next) return;
    e.preventDefault();
    pick(next);
  });
}
bankKeys(tabs, () => view.bank, (b) => setBank(b, true));
bankKeys(cpTabs, () => parseRoute(location.hash).bank ?? 'A', (b) => setCardBank(b, true));

/** Make `cell` the one pad in the tab order. */
function setPadStop(container, cell) {
  if (!cell) return;
  for (const each of container.querySelectorAll('.pad')) each.tabIndex = each === cell ? 0 : -1;
}

pads.addEventListener('focusin', (e) => {
  if (e.target.classList.contains('pad')) setPadStop(pads, e.target);
});

// Arrow keys move across the 4x4 grid: left and right by one pad, up and down by a row.
pads.addEventListener('keydown', (e) => {
  const cell = e.target.closest('.pad');
  if (!cell) return;
  const num = Number(cell.dataset.pad.slice(1));
  let next = null;
  if (e.key === 'ArrowRight') next = num + 1;
  else if (e.key === 'ArrowLeft') next = num - 1;
  else if (e.key === 'ArrowDown') next = num + 4;
  else if (e.key === 'ArrowUp') next = num - 4;
  else if (e.key === 'Home') next = 1;
  else if (e.key === 'End') next = 16;
  if (next == null) return;
  e.preventDefault();
  if (next < 1 || next > 16) return;
  const target = pads.querySelector(`[data-pad="${view.bank}${next}"]`);
  if (target) target.focus();
});

// ── Rename and clear a slot ─────────────────────────────────────────────────

function hideConfirm() {
  $('confirmStrip').hidden = true;
  $('slotActions').hidden = false;
}

$('rename').onclick = () => {
  const slot = view.slot;
  const id = slotKey(slot);
  const mem = own(crate.memory, id);
  $('nameTitle').textContent = `Rename slot ${pad2(slot)}`;
  $('nameText').textContent = mem?.source === 'card' && mem.name
    ? `Leave it empty to use the project's own name, ${mem.name}. Loading another project into this slot removes the name.`
    : 'Leave it empty to remove the name.';
  $('nameInput').value = own(crate.names, id) ?? mem?.name ?? '';
  say($('nameError'), '');
  nameBusy(false);
  openLayer(nameSheet, $('nameInput'));
};

function nameBusy(on) {
  for (const button of nameSheet.querySelectorAll('button')) button.disabled = on;
  $('nameSave').textContent = on ? 'Saving' : 'Save';
}

$('nameForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('nameInput').value.trim();
  const slot = view.slot;
  nameBusy(true);
  try {
    await takeCrate(await api('rename', { slot, name }));
  } catch (err) {
    if (!nameSheet.hidden) {
      nameBusy(false);
      say($('nameError'), err.message);
    }
    return;
  }
  closeLayer(() => {
    renderHome();
    $('slotName').focus({ preventScroll: true });
  });
};
$('nameCancel').onclick = () => closeLayer();

// Clearing a slot is asked in the page, never with confirm().
$('clearSlot').onclick = () => {
  const s = slotInfo(view.slot);
  $('confirmTitle').textContent = `Clear slot ${pad2(s.slot)}${s.name ? ', ' + s.name : ''}?`;
  $('confirmText').textContent = 'Its pads, your edits and its name are removed from memory. The SD card is not touched: you can load the project again from Projects.';
  say($('confirmError'), '');
  $('slotActions').hidden = true;
  $('confirmStrip').hidden = false;
  $('confirmCancel').focus();
};
$('confirmCancel').onclick = () => {
  hideConfirm();
  $('clearSlot').focus();
};
$('confirmClear').onclick = async () => {
  const slot = view.slot;
  $('confirmClear').disabled = $('confirmCancel').disabled = true;
  try {
    await takeCrate(await api('clear', { slot }));
  } catch (err) {
    say($('confirmError'), err.message);
    return;
  } finally {
    $('confirmClear').disabled = $('confirmCancel').disabled = false;
  }
  stopPlayback();
  hideConfirm();
  history.replaceState(history.state, '', memoryHash(slot, 'A'));
  route();
  $('slotName').focus({ preventScroll: true });
};

// ── Pad sheet ───────────────────────────────────────────────────────────────

function openPad(padId) {
  const slot = view.slot;
  const id = slotKey(slot);
  const card = own(own(crate.memory, id)?.pads, padId) ?? null;
  const edit = own(own(crate.overrides, id), padId) ?? null;
  const shown = own(getDisplayPads(crate, id, padId[0]) ?? {}, padId) ?? null;
  editing = { slot, padId, card, edit };

  $('padWhere').textContent = `Memory ${pad2(slot)}, bank ${padId[0]}, pad ${padId.slice(1)}`;
  $('padTitle').textContent = shown?.name || (shown ? 'No name' : 'Empty pad');
  $('padName').value = shown?.name ?? '';
  $('padLength').value = shown && hasLength(shown.playSec) ? formatLength(shown.playSec) : '';

  $('padCardStrip').hidden = !card;
  if (card) {
    const len = hasLength(card.playSec) ? (card.approx ? '≈' : '') + formatLength(card.playSec) : '';
    $('padCardValue').textContent = [card.name || 'No name', len].filter(Boolean).join(', ');
  }
  $('padUseCard').hidden = !(card && edit);
  $('padClearStrip').hidden = !(edit && !card);
  say($('padError'), '');
  padBusy(false);
  openLayer(padSheet, $('padName'));
}

function padBusy(on) {
  for (const button of padSheet.querySelectorAll('button')) button.disabled = on;
  $('padSave').textContent = on ? 'Saving' : 'Save';
}

async function sendPad(body) {
  const target = editing;
  padBusy(true);
  say($('padError'), '');
  try {
    await takeCrate(await api('pad', { slot: target.slot, padId: target.padId, ...body }));
  } catch (err) {
    if (!padSheet.hidden) {
      padBusy(false);
      say($('padError'), err.message);
    }
    return;
  }
  editing = null;
  closeLayer(() => {
    // The pad just changed is the current item: mark it and keep it in view.
    if (view.slot !== target.slot || home.hidden) return;
    view.mark = target.padId;
    view.bank = target.padId[0];
    history.replaceState(history.state, '', memoryHash(view.slot, view.bank, view.mark));
    view.route = parseRoute(location.hash);
    renderHome();
    const cell = pads.querySelector(`[data-pad="${target.padId}"]`);
    if (cell) cell.focus({ preventScroll: true });
  });
}

$('padForm').onsubmit = (e) => {
  e.preventDefault();
  if (!editing) return;
  const { card } = editing;
  const name = $('padName').value.trim();
  const typed = $('padLength').value.trim();
  const sec = parseLength(typed);
  if (Number.isNaN(sec) || (sec != null && sec > 7200)) {
    say($('padError'), 'Write the length as minutes and seconds, like 0:03.4, or leave it empty.');
    $('padLength').focus();
    return;
  }
  // A value that is the same as the loaded project's is not an edit, so it is not kept as one.
  const sameName = card && name === (card.name || '');
  const sameLength = card && (sec == null ? !hasLength(card.playSec) : hasLength(card.playSec) && typed.replace(/^≈/, '') === formatLength(card.playSec));
  const body = {
    name: sameName ? '' : name,
    playSec: sameLength || sec == null ? null : Math.round(sec * 1000) / 1000,
  };
  if (!card && !body.name && body.playSec == null && !editing.edit) {
    closeLayer(); // nothing typed on an empty pad
    return;
  }
  if (card && sameName && (sameLength || sec == null) && !editing.edit) {
    closeLayer(); // nothing changed
    return;
  }
  if (!body.name && body.playSec == null) {
    sendPad({ clear: true });
    return;
  }
  sendPad(body);
};
$('padUseCard').onclick = () => sendPad({ clear: true });
$('padClear').onclick = () => sendPad({ clear: true });
$('padCancel').onclick = () => {
  editing = null;
  closeLayer();
};
$('padName').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  $('padLength').focus();
});

// ── Search: memory and card ─────────────────────────────────────────────────

/** Where a search hit leads: the memory slot, the card folder or the card project, marked. */
function hitHash(hit) {
  const padId = typeof hit.padId === 'string' && PAD_RE.test(hit.padId) ? hit.padId : null;
  const kind = hit.kind ?? hit.type;
  if (kind === 'sample' || (!padId && typeof hit.path === 'string')) {
    const sample = (crate.card?.samples ?? []).find((s) => s.path === hit.path);
    return cardHash('s', groupOf(sample?.folder ?? hit.folder).key, { mark: hit.path });
  }
  if (!padId) return null;
  const slotId = hit.slotId ?? (validSlot(hit.slot) ? slotKey(hit.slot) : null);
  const m = /^slot-(\d{2})$/.exec(slotId ?? '');
  if (kind === 'memory' || (m && !hit.projectId && !hit.cardProjectId)) {
    return m ? memoryHash(Number(m[1]), padId[0], padId) : null;
  }
  const projectId = hit.cardProjectId ?? hit.projectId;
  return projectId ? cardHash('p', projectId, { b: padId[0], pad: padId }) : null;
}

function renderResults(q) {
  let hits = [];
  try {
    hits = searchAll(crate, q) ?? [];
  } catch {
    hits = [];
  }
  const rows = [];
  for (const hit of hits.slice(0, MAX_RESULTS)) {
    const target = hitHash(hit);
    const button = make('button', 'row result');
    button.type = 'button';
    const text = make('span');
    const title = make('span', 'title');
    title.append(breakable(hit.name || 'No name'));
    text.append(title, make('span', 'sub', hit.where || ''));
    button.append(text);
    if (target) button.onclick = () => go(target);
    else button.disabled = true;
    const li = make('li');
    li.append(button);
    rows.push(li);
  }
  $('resultList').replaceChildren(...rows);
  say($('more'), hits.length > MAX_RESULTS
    ? `Showing the first ${MAX_RESULTS} of ${plural(hits.length, 'result', 'results')}. Type more of the name to narrow it down.`
    : '');
  $('noResults').hidden = hits.length > 0;
}

search.addEventListener('input', () => {
  const q = search.value.trim();
  history.replaceState(history.state, '', memoryHash(view.slot, view.bank, null, q));
  view.route = parseRoute(location.hash);
  view.mark = null;
  renderHome();
});

// ── Card ────────────────────────────────────────────────────────────────────

function showCard(r) {
  for (const id of ['cardMenu', 'cardList', 'cardProject']) $(id).hidden = true;
  const from = history.state?.from ? parseRoute(history.state.from) : null;
  const back = from ?? (parentHash(r) ? parseRoute(parentHash(r)) : null);
  $('cardBack').textContent = back ? routeName(back) : 'Memory';
  if (r.view === 'menu') return renderCardMenu();
  if (r.view === 'project') return renderCardProject(r);
  return renderCardList(r);
}

function cardSummary() {
  const c = crate.card;
  if (!c) return 'Not read yet';
  return [`Read ${formatDate(c.readAt)}`, plural(c.samples.length, 'sample', 'samples'), plural(c.projects.length, 'project', 'projects')].join(', ');
}

function renderCardMenu() {
  $('cardMenu').hidden = false;
  $('cardStatus').textContent = cardSummary();
  $('playState').textContent = session.files
    ? "Playing from this computer's card folder."
    : 'Playing works on this computer after you read the card folder.';
  const c = crate.card;
  const groups = sampleGroups();
  $('menuSampleSub').textContent = c ? `${plural(c.samples.length, 'sample', 'samples')}, ${plural(groups.length, 'folder', 'folders')}` : '';
  $('menuProjectSub').textContent = c ? plural(c.projects.length, 'project', 'projects') : '';
  $('menuSxSub').textContent = c ? (c.sx.length ? plural(c.sx.length, 'project', 'projects') : 'None') : '';
  renderLoadAll();
  return $('cardTitle');
}

function renderCardList(r) {
  $('cardList').hidden = false;
  const c = crate.card;
  const rows = [];
  let label = cardSummary(), title = '', note = '', emptyTitle = '', emptyText = '';

  if (r.view === 'samples') {
    title = 'Sample';
    for (const g of sampleGroups()) {
      const button = make('button', 'row result');
      button.type = 'button';
      const text = make('span');
      const t = make('span', 'title');
      t.append(breakable(g.label));
      text.append(t, make('span', 'sub', plural(g.samples.length, 'sample', 'samples')));
      button.append(text);
      button.onclick = () => go(cardHash('s', g.key));
      rows.push(wrapLi(button));
    }
    emptyTitle = 'No samples.';
    emptyText = c ? 'The card has no WAV or AIFF files outside its projects.' : 'Read the card folder first.';
  } else if (r.view === 'folder') {
    const g = sampleGroups().find((each) => each.key === r.key);
    title = g ? g.label : 'Not on the card';
    label = g ? `${groupPath(g)}, ${plural(g.samples.length, 'sample', 'samples')}` : 'Sample';
    if (g) {
      if (!session.files) note = 'Read the card folder on this computer to play these.';
      for (const s of g.samples) rows.push(sampleRow(s, s.path === r.mark));
    }
    emptyTitle = 'Nothing here.';
    emptyText = 'This folder is not in the card list. Read the card folder again.';
  } else if (r.view === 'projects') {
    title = 'Project';
    for (const p of cardProjects()) {
      const button = make('button', 'row');
      button.type = 'button';
      button.append(make('span', 'num', validSlot(p.slot) ? pad2(p.slot) : ''));
      const text = make('span');
      const t = make('span', 'title');
      t.append(breakable(cardProjectName(p)));
      text.append(t, make('span', 'sub', `${plural(Object.keys(p.pads ?? {}).length, 'sample', 'samples')}, folder ${p.folder}`));
      button.append(text);
      button.onclick = () => go(cardHash('p', p.id));
      rows.push(wrapLi(button));
    }
    emptyTitle = 'No projects.';
    emptyText = c ? 'The card has no project folders with a PADCONF.BIN.' : 'Read the card folder first.';
  } else {
    title = 'Project (SX)';
    for (const p of c?.sx ?? []) {
      const li = make('li', 'row-wrap');
      const text = make('span', 'text');
      const t = make('span', 'title');
      t.append(breakable(p.name || p.folder || ''));
      text.append(t, make('span', 'sub', p.folder ? `Folder ${p.folder}` : ''));
      li.append(text);
      rows.push(li);
    }
    emptyTitle = 'None.';
    emptyText = c ? 'No SP-404SX projects on this card.' : 'Read the card folder first.';
  }

  $('listLabel').textContent = label;
  $('listTitle').textContent = title;
  say($('listNote'), note);
  $('cardRows').replaceChildren(...rows);
  $('listEmpty').hidden = rows.length > 0;
  $('listEmptyTitle').textContent = emptyTitle;
  $('listEmptyText').textContent = emptyText;
  return $('listTitle');
}

/** Where a sample folder is on the card, for the label over its name. */
function groupPath(g) {
  if (g.key === EXPORT_KEY) return 'EXPORT/SAMPLE';
  if (g.key === OTHER_KEY) return 'Outside IMPORT and EXPORT';
  return g.key;
}

function wrapLi(node) {
  const li = make('li');
  li.append(node);
  return li;
}

function sampleRow(s, marked) {
  const li = make('li', 'row-wrap');
  li.dataset.path = s.path;
  if (marked) {
    li.classList.add('marked');
    li.tabIndex = -1;
  }
  const text = make('span', 'text');
  const t = make('span', 'title');
  t.append(breakable(s.name || s.path));
  const len = hasLength(s.sec) ? formatLength(s.sec) : 'Length unknown';
  text.append(t, make('span', 'sub len-sub', [len, String(s.ext || '').toUpperCase()].filter(Boolean).join(', ')));
  li.append(text);
  const sound = sampleSound(s);
  if (sound) li.append(playButton(sound));
  return li;
}

// ── A card project ──────────────────────────────────────────────────────────

function renderCardProject(r) {
  $('cardProject').hidden = false;
  const p = findCardProject(r.id);
  if (!p) {
    $('cpLabel').textContent = 'Card project';
    $('cpName').textContent = 'Not on the card';
    cpTabs.replaceChildren();
    cpPads.replaceChildren();
    $('cpActions').hidden = $('loadStrip').hidden = true;
    return $('cpName');
  }
  const has = {};
  for (const id of Object.keys(p.pads ?? {})) if (PAD_RE.test(id)) has[id[0]] = true;
  const bank = BANK_LIST.includes(r.bank) ? r.bank : BANK_LIST.find((b) => has[b]) ?? 'A';
  const mark = r.pad && PAD_RE.test(r.pad) && r.pad[0] === bank ? r.pad : null;
  const canonical = cardHash('p', p.id, { b: bank, pad: mark });
  if (location.hash !== canonical) history.replaceState(history.state, '', canonical);
  view.route = parseRoute(location.hash);

  const count = Object.keys(p.pads ?? {}).length;
  $('cpLabel').textContent = [validSlot(p.slot) ? `Card, slot ${pad2(p.slot)}` : 'Card', `folder ${p.folder}`, plural(count, 'sample', 'samples')].join(', ');
  $('cpName').textContent = cardProjectName(p);
  say($('cpNote'), session.files ? '' : 'Read the card folder on this computer to play these.');

  renderTabs(cpTabs, has, bank, 'cpPads', (b) => setCardBank(b));
  renderGrid(cpPads, {
    bank,
    mark,
    pad: (padId) => own(p.pads, padId) ?? null,
    approx: (padId, pad) => Boolean(pad.approx),
    sound: (padId, label) => cardPadSound(p, padId, label),
    open: null,
  });
  if ($('loadStrip').hidden) $('cpActions').hidden = false;
  return $('cpName');
}

function setCardBank(bank, focusTab = false) {
  const r = parseRoute(location.hash);
  if (r.view !== 'project' || !BANK_LIST.includes(bank)) return;
  history.replaceState(history.state, '', cardHash('p', r.id, { b: bank }));
  route();
  if (focusTab) $('tab-cpPads-' + bank).focus();
}

function hideLoad() {
  $('loadStrip').hidden = true;
  $('cpActions').hidden = false;
}

function loadSlotText() {
  const slot = Number($('loadSlot').value);
  const s = slotInfo(slot);
  $('loadText').textContent = slotUsed(slot)
    ? `This replaces memory slot ${pad2(slot)} (${s.name || 'no name'}) and its edits.`
    : `Memory slot ${pad2(slot)} is empty.`;
  $('loadConfirm').textContent = `Load into slot ${pad2(slot)}`;
}

$('loadOpen').onclick = () => {
  const p = findCardProject(view.route?.id);
  if (!p) return;
  const all = slots();
  $('loadSlot').replaceChildren(...all.map((s) => {
    const o = make('option', null, slotLabel(s));
    o.value = String(s.slot);
    return o;
  }));
  const firstEmpty = all.find((s) => !slotUsed(s.slot))?.slot ?? 1;
  $('loadSlot').value = String(validSlot(p.slot) ? p.slot : firstEmpty);
  loadSlotText();
  say($('loadError'), '');
  $('cpActions').hidden = true;
  $('loadStrip').hidden = false;
  $('loadSlot').focus();
};
$('loadSlot').onchange = loadSlotText;
$('loadCancel').onclick = () => {
  hideLoad();
  $('loadOpen').focus();
};
$('loadConfirm').onclick = async () => {
  const p = findCardProject(view.route?.id);
  const slot = Number($('loadSlot').value);
  if (!p || !validSlot(slot)) return;
  $('loadConfirm').disabled = $('loadCancel').disabled = true;
  try {
    await takeCrate(await api('load', { cardProjectId: p.id, slot }));
  } catch (err) {
    say($('loadError'), err.message);
    return;
  } finally {
    $('loadConfirm').disabled = $('loadCancel').disabled = false;
  }
  hideLoad();
  search.value = '';
  go(memoryHash(slot, firstBank(slot)));
};

// ── Load all projects into memory (first time) ──────────────────────────────

function renderLoadAll() {
  const projects = crate.card?.projects ?? [];
  const memoryEmpty = Object.keys(crate.memory).length === 0;
  const offer = projects.length > 0 && memoryEmpty;
  $('loadAllStrip').hidden = !offer && !loadAllReport;
  $('loadAll').hidden = !offer;
  $('loadAllText').textContent = offer
    ? `Memory is empty. Load each card project into the slot its folder names, like P1_ for slot 01.`
    : '';
  $('loadAllText').hidden = !offer;
  const st = $('loadAllStatus');
  st.hidden = !loadAllReport;
  if (loadAllReport) {
    $('loadAllBusy').hidden = !loadAllReport.busy;
    $('loadAllResult').textContent = loadAllReport.text;
    $('loadAllResult').className = loadAllReport.error ? 'error' : '';
    const notes = $('loadAllNotes');
    notes.replaceChildren(...loadAllReport.notes.map((n) => make('li', null, n)));
    notes.hidden = loadAllReport.notes.length === 0;
  }
}

/** One card project per slot; when two folders claim a slot, the newer one wins. */
function loadAllPlan() {
  const bySlot = new Map();
  const notes = [];
  for (const p of cardProjects()) {
    if (!validSlot(p.slot)) {
      notes.push(`Not loaded: ${p.folder} has no slot number. Open it under Project to load it into a slot.`);
      continue;
    }
    const current = bySlot.get(p.slot);
    if (!current) {
      bySlot.set(p.slot, p);
      continue;
    }
    const newer = (p.modified ?? 0) > (current.modified ?? 0) ? p : current;
    const older = newer === p ? current : p;
    bySlot.set(p.slot, newer);
    notes.push(`Skipped ${older.folder}: slot ${pad2(p.slot)} takes the newer ${newer.folder}.`);
  }
  return { picks: [...bySlot.entries()].sort((a, b) => a[0] - b[0]), notes };
}

$('loadAll').onclick = async () => {
  const { picks, notes } = loadAllPlan();
  $('loadAll').disabled = true;
  const done = [];
  loadAllReport = { busy: true, text: `Loading ${plural(picks.length, 'project', 'projects')} into memory.`, notes, error: false };
  renderLoadAll();
  try {
    for (const [slot, p] of picks) {
      await takeCrate(await api('load', { cardProjectId: p.id, slot }));
      done.push(`${pad2(slot)} ${cardProjectName(p)}`);
    }
    loadAllReport = { busy: false, text: `Loaded ${plural(done.length, 'project', 'projects')} into memory: ${done.join(', ')}.`, notes, error: false };
  } catch (err) {
    loadAllReport = {
      busy: false,
      text: `Stopped: ${err.message}${done.length ? ` Loaded so far: ${done.join(', ')}.` : ''}`,
      notes,
      error: true,
    };
  } finally {
    $('loadAll').disabled = false;
  }
  renderCardMenu();
};

// ── Read card folder ────────────────────────────────────────────────────────

function importStatus(text, { busy = false, warnings = [], error = false } = {}) {
  $('importStrip').hidden = false;
  $('importBusy').hidden = !busy;
  const p = $('importText');
  p.textContent = text;
  p.className = error ? 'error' : '';
  const ul = $('importWarnings');
  ul.replaceChildren(...warnings.slice(0, 50).map((w) => make('li', null, String(w))));
  if (warnings.length > 50) ul.append(make('li', null, `And ${plural(warnings.length - 50, 'more warning', 'more warnings')}.`));
  ul.hidden = warnings.length === 0;
}

$('readCard').onclick = () => $('sdInput').click();
$('sdInput').onchange = async (e) => {
  const list = e.target.files;
  if (!list || list.length === 0) return;
  $('readCard').disabled = true;
  importStatus(`Reading ${plural(list.length, 'file', 'files')} from the card.`, { busy: true });
  try {
    const { card, files, warnings = [] } = await readCard(list);
    const samples = card?.samples ?? [], projects = card?.projects ?? [], sx = card?.sx ?? [];
    if (samples.length + projects.length + sx.length === 0) {
      importStatus('No samples or projects in that folder. Choose the SD card itself, or the folder that holds EXPORT and IMPORT.', { warnings, error: true });
      return;
    }
    const body = { card: { samples, projects, sx } };
    const size = JSON.stringify(body).length;
    if (size > MAX_BODY_CHARS) {
      importStatus(`The card list is too big to save (${(size / 1e6).toFixed(1)} MB; the most is 2 MB).`, { warnings, error: true });
      return;
    }
    importStatus(`Saving the card list: ${plural(samples.length, 'sample', 'samples')}, ${plural(projects.length, 'project', 'projects')}.`, { busy: true });
    const data = await api('card', body);
    stopPlayback();
    setFiles(files);
    loadAllReport = null;
    await takeCrate(data);
    importStatus(`Read ${plural(samples.length, 'sample', 'samples')} and ${plural(projects.length, 'project', 'projects')}. The sounds stay on this computer.`, { warnings });
    route();
  } catch (err) {
    importStatus(`The card was not read. ${err.message || err}`, { error: true });
  } finally {
    e.target.value = '';
    $('readCard').disabled = false;
  }
};

$('openCard').onclick = () => go(cardHash());
$('cardBack').onclick = goBack;
$('menuSample').onclick = () => go(cardHash('s'));
$('menuProject').onclick = () => go(cardHash('p'));
$('menuSx').onclick = () => go(cardHash('sx'));

// ── Gate ────────────────────────────────────────────────────────────────────

function showGate(mode) {
  gateMode = mode;
  const setup = mode === 'setup';
  $('gateTitle').textContent = setup ? 'Create the password.' : 'Enter the password.';
  $('gateText').textContent = setup
    ? 'It protects your crate. Only someone who knows it can see or change your memory and card lists. At least 8 characters.'
    : 'This device will remember it for 3 months.';
  $('repeatWrap').hidden = !setup;
  $('password').autocomplete = setup ? 'new-password' : 'current-password';
  $('password2').required = setup;
  $('enter').textContent = setup ? 'Create password' : 'Enter';
  $('password').value = $('password2').value = '';
  say($('gateError'), '');
  editing = null;
  layerEntry = false;
  afterLayerPop = null;
  stopPlayback();
  home.hidden = cardScreen.hidden = true;
  show(gate);
}

$('gateForm').onsubmit = async (e) => {
  e.preventDefault();
  const password = $('password').value;
  if (gateMode === 'setup') {
    if (password.length < 8) return say($('gateError'), 'Use at least 8 characters.');
    if (password !== $('password2').value) return say($('gateError'), 'The two passwords do not match.');
  } else if (!password) {
    return say($('gateError'), 'Write the password.');
  }
  $('enter').disabled = true;
  try {
    await api(gateMode, { password });
    await enter();
  } catch (err) {
    if (!gate.hidden) say($('gateError'), err.message);
  } finally {
    $('enter').disabled = false;
  }
};

async function enter() {
  show(null);
  problemStrip.hidden = true;
  try {
    await load();
  } catch (err) {
    if (gate.hidden) problem(err.message);
    return;
  }
  view.route = null;
  route();
}

function problem(message) {
  home.hidden = cardScreen.hidden = true;
  problemStrip.hidden = false;
  $('problemText').textContent = message;
}

$('logout').onclick = async () => {
  try {
    await api('logout', {});
  } catch (err) {
    return problem(err.message);
  }
  setCrate(null);
  session.files = null;
  search.value = '';
  loadAllReport = null;
  $('importStrip').hidden = true;
  history.replaceState(null, '', location.pathname + location.search);
  showGate('login');
};

// Escape closes an open sheet, or the question under the grid.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!padSheet.hidden) $('padCancel').click();
  else if (!nameSheet.hidden) $('nameCancel').click();
  else if (!$('loadStrip').hidden && !cardScreen.hidden) $('loadCancel').click();
  else if (!$('confirmStrip').hidden && !home.hidden) $('confirmCancel').click();
});

// ── Start ───────────────────────────────────────────────────────────────────

// A leftover sheet entry (after a reload) is just a plain page.
if (history.state && history.state.layer) history.replaceState({ ...history.state, layer: false }, '');
view.slot = readLastSlot();

api('state')
  .then((state) => {
    // `setup` is true once a password exists (see api.php).
    if (state.signedIn) return enter();
    showGate(state.setup ? 'login' : 'setup');
  })
  .catch((err) => problem(err.message));
