// app.js — the SP404MK2 crate front end.
// The server (api.php) keeps the crate; this page shows it and sends changes.
// All data goes into the page with textContent, never as HTML.

import { findProjects } from './importer.js';
import { getDisplayPads, listProjects, bankHasSamples } from './store.js';
import { BANKS } from './padconf.js';

const BANK_LIST = BANKS.split('');
const PAD_RE = /^[A-J](?:[1-9]|1[0-6])$/;
const MAX_RESULTS = 200;
const IMPORT_BATCH_CHARS = 1500000; // the server takes at most 2 MB per request

const $ = (id) => document.getElementById(id);
const home = $('home'), project = $('project'), problemStrip = $('problem');
const padSheet = $('padSheet'), nameSheet = $('nameSheet'), gate = $('gate');
const search = $('search'), list = $('list'), tabs = $('tabs'), pads = $('pads');

/** The crate as the server last sent it. */
let crate = { projects: {}, overrides: {}, names: {} };
/** Every pad with a name, for search: { projectId, padId, bank, num, name, key }. */
let index = [];
/** What the project screen shows. `mark` is the pad painted yellow. */
const view = { projectId: null, bank: 'A', mark: null };
/** The pad open in the pad sheet. */
let editing = null;
/** 'new' or 'rename' while the name sheet is open. */
let nameMode = null;
let gateMode = 'login';
let homeScroll = 0;
let returnFocus = null;
// A sheet adds one history entry so the phone's back button closes it.
let layerEntry = false;
let afterLayerPop = null;

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

const own = (obj, key) => (obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);

/** Lower case without accents, so "cafe" finds "Café". */
const plain = (text) => String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const plural = (n, one, many) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/** What store.js calls the state: just the parts it reads. */
const storeState = () => ({ projects: crate.projects, overrides: crate.overrides });

/** The name shown for a project: a rename wins over the name on the card. */
function projectName(id) {
  return own(crate.names, id) ?? own(crate.projects, id)?.name ?? id;
}

function slotOf(id) {
  const p = own(crate.projects, id);
  if (!p) return null;
  if (Number.isInteger(p.slot)) return p.slot;
  const m = /^slot-(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** "Project 06" for a card slot, otherwise the project's name. */
function projectRef(id) {
  const slot = slotOf(id);
  return slot == null ? projectName(id) : `Project ${String(slot).padStart(2, '0')}`;
}

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

// ── Layers and screens ──────────────────────────────────────────────────────

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
  route();
});

function hashFor(projectId, bank, mark) {
  const q = new URLSearchParams({ p: projectId, b: bank });
  if (mark) q.set('pad', mark);
  return '#' + q.toString();
}

/** Show the screen the address asks for: #p=<id>&b=<bank>&pad=<pad>, or home. */
function route() {
  const q = new URLSearchParams(location.hash.slice(1));
  const id = q.get('p');
  if (id && own(crate.projects, id)) {
    const fresh = view.projectId !== id;
    view.projectId = id;
    const b = q.get('b');
    view.bank = BANK_LIST.includes(b) ? b : firstBank(id);
    const pad = q.get('pad');
    view.mark = pad && PAD_RE.test(pad) && pad[0] === view.bank ? pad : null;
    if (fresh) hideConfirm();
    renderProject();
    home.hidden = true;
    project.hidden = false;
    const marked = view.mark && pads.querySelector(`[data-pad="${view.mark}"]`);
    if (marked) {
      marked.scrollIntoView({ block: 'center' });
      marked.focus({ preventScroll: true });
    } else if (fresh) {
      window.scrollTo(0, 0);
      $('projectName').focus({ preventScroll: true });
    }
    return;
  }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const wasProject = !project.hidden;
  view.projectId = null;
  project.hidden = true;
  home.hidden = false;
  renderHome();
  if (wasProject) window.scrollTo(0, homeScroll);
}

function openProject(id, bank, mark) {
  homeScroll = window.scrollY;
  history.pushState({ fromHome: true }, '', hashFor(id, bank ?? firstBank(id), mark));
  route();
}

function goHome() {
  if (history.state && history.state.fromHome) {
    history.back();
  } else {
    history.replaceState(null, '', location.pathname + location.search);
    route();
  }
}

/** The first bank with something in it, or A. */
function firstBank(id) {
  const has = bankHasSamples(storeState(), id);
  return BANK_LIST.find((b) => has[b]) ?? 'A';
}

// ── Crate ───────────────────────────────────────────────────────────────────

function setCrate(next) {
  crate = {
    projects: next?.projects && typeof next.projects === 'object' ? next.projects : {},
    overrides: next?.overrides && typeof next.overrides === 'object' ? next.overrides : {},
    names: next?.names && typeof next.names === 'object' ? next.names : {},
  };
  index = [];
  for (const p of listProjects(storeState())) {
    for (const bank of BANK_LIST) {
      const shown = getDisplayPads(storeState(), p.id, bank);
      for (let num = 1; num <= 16; num++) {
        const pad = shown[bank + num];
        if (pad && pad.name) index.push({ projectId: p.id, padId: bank + num, bank, num, name: pad.name, key: plain(pad.name) });
      }
    }
  }
}

/** Projects in list order (slot, then name) with the names people see. */
function projects() {
  const rows = listProjects(storeState()).map((p) => ({ ...p, name: projectName(p.id) }));
  rows.sort((a, b) => {
    if (a.slot !== b.slot) {
      if (a.slot == null) return 1;
      if (b.slot == null) return -1;
      return a.slot - b.slot;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  });
  return rows;
}

async function load() {
  const data = await api('list');
  setCrate(data.crate);
}

// ── Home ────────────────────────────────────────────────────────────────────

function projectRow(p) {
  const button = make('button', 'row');
  button.type = 'button';
  button.append(
    make('span', 'num', p.slot == null ? '' : String(p.slot).padStart(2, '0')),
  );
  const text = make('span');
  text.append(make('span', 'title', p.name), make('span', 'sub', plural(p.padCount, 'sample', 'samples')));
  button.append(text);
  button.onclick = () => openProject(p.id);
  const li = make('li');
  li.append(button);
  return li;
}

function resultRow(hit) {
  const button = make('button', 'row result');
  button.type = 'button';
  const text = make('span');
  text.append(
    make('span', 'title', hit.name),
    make('span', 'sub', `${projectRef(hit.projectId)}, bank ${hit.bank}, pad ${hit.num}`),
  );
  button.append(text);
  button.onclick = () => openProject(hit.projectId, hit.bank, hit.padId);
  const li = make('li');
  li.append(button);
  return li;
}

function renderHome() {
  const all = projects();
  const samples = all.reduce((sum, p) => sum + p.padCount, 0);
  $('count').textContent = all.length ? plural(samples, 'sample', 'samples') : '';
  $('searchStrip').hidden = all.length === 0;

  const q = plain(search.value.trim());
  let rows;
  let more = '';
  if (!q) {
    rows = all.map(projectRow);
  } else {
    const order = new Map(all.map((p, i) => [p.id, i]));
    const projectHits = all.filter((p) => plain(p.name).includes(q));
    const padHits = index.filter((hit) => hit.key.includes(q));
    padHits.sort((a, b) => order.get(a.projectId) - order.get(b.projectId) || a.bank.localeCompare(b.bank) || a.num - b.num);
    rows = [...projectHits.map(projectRow), ...padHits.slice(0, MAX_RESULTS).map(resultRow)];
    if (padHits.length > MAX_RESULTS) {
      more = `Showing the first ${MAX_RESULTS} of ${plural(padHits.length, 'sample', 'samples')}. Type more of the name to narrow it down.`;
    }
  }
  list.replaceChildren(...rows);
  say($('more'), more);

  $('empty').hidden = rows.length > 0;
  $('emptyTitle').textContent = all.length ? 'Nothing matches.' : 'No projects yet.';
  $('emptyText').textContent = all.length
    ? 'Try another sample or project name.'
    : 'Read the SP-404MKII folder from your SD card on a laptop, or add a project by hand.';
}

// ── Project ─────────────────────────────────────────────────────────────────

function renderProject() {
  const id = view.projectId;
  const p = own(crate.projects, id);
  if (!p) return;
  const state = storeState();
  const shownCount = listProjects(state).find((row) => row.id === id)?.padCount ?? 0;
  const where = slotOf(id) != null ? projectRef(id) : p.source === 'manual' ? 'Added by hand' : `Folder ${p.folder || id}`;
  $('projectLabel').textContent = `${where}, ${plural(shownCount, 'sample', 'samples')}`;
  $('projectName').textContent = projectName(id);
  $('projectHint').hidden = shownCount > 0;

  const has = bankHasSamples(state, id);
  tabs.replaceChildren(...BANK_LIST.map((b) => {
    const tab = make('button', has[b] ? '' : 'none', b);
    tab.type = 'button';
    tab.id = 'tab-' + b;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(b === view.bank));
    tab.setAttribute('aria-controls', 'pads');
    tab.setAttribute('aria-label', `Bank ${b}${has[b] ? '' : ', empty'}`);
    tab.tabIndex = b === view.bank ? 0 : -1;
    tab.onclick = () => setBank(b);
    return tab;
  }));
  pads.setAttribute('aria-labelledby', 'tab-' + view.bank);

  const shown = getDisplayPads(state, id, view.bank);
  const rows = [];
  for (let num = 1; num <= 16; num++) {
    const padId = view.bank + num;
    const pad = shown[padId];
    const button = make('button', 'row pad');
    button.type = 'button';
    button.dataset.pad = padId;
    if (padId === view.mark) button.classList.add('marked');
    const text = make('span');
    if (pad && pad.name) text.append(make('span', 'title', pad.name));
    else if (pad) text.append(make('span', 'title', 'No name'));
    else text.append(make('span', 'title', '—'));
    if (!pad) button.classList.add('blank');
    if (pad && pad.edited) text.append(make('span', 'edited', 'edited'));
    const len = make('span', 'len', pad && hasLength(pad.playSec) ? (pad.approx && !own(own(crate.overrides, id), padId)?.playSec ? '≈' : '') + formatLength(pad.playSec) : '');
    if (!pad) button.setAttribute('aria-label', `Pad ${num}, empty`);
    button.append(make('span', 'num', String(num)), text, len);
    button.onclick = () => openPad(padId);
    const li = make('li');
    li.append(button);
    rows.push(li);
  }
  pads.replaceChildren(...rows);
  say($('projectError'), '');
}

function setBank(bank, focusTab = false) {
  if (!BANK_LIST.includes(bank)) return;
  view.bank = bank;
  view.mark = null;
  history.replaceState(history.state, '', hashFor(view.projectId, bank));
  renderProject();
  if (focusTab) $('tab-' + bank).focus();
}

// Arrow keys move between banks, as in any tab row.
tabs.addEventListener('keydown', (e) => {
  const at = BANK_LIST.indexOf(view.bank);
  let next = null;
  if (e.key === 'ArrowRight') next = BANK_LIST[(at + 1) % BANK_LIST.length];
  else if (e.key === 'ArrowLeft') next = BANK_LIST[(at - 1 + BANK_LIST.length) % BANK_LIST.length];
  else if (e.key === 'Home') next = BANK_LIST[0];
  else if (e.key === 'End') next = BANK_LIST[BANK_LIST.length - 1];
  if (!next) return;
  e.preventDefault();
  setBank(next, true);
});

function hideConfirm() {
  $('confirmStrip').hidden = true;
  $('projectActions').hidden = false;
}

// ── Pad sheet ───────────────────────────────────────────────────────────────

function openPad(padId) {
  const id = view.projectId;
  const card = own(own(crate.projects, id)?.pads, padId) ?? null;
  const edit = own(own(crate.overrides, id), padId) ?? null;
  const shown = getDisplayPads(storeState(), id, padId[0])[padId] ?? null;
  editing = { projectId: id, padId, card, edit };

  $('padWhere').textContent = `${projectRef(id)}, bank ${padId[0]}, pad ${padId.slice(1)}`;
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
    const data = await api('pad', { projectId: target.projectId, padId: target.padId, ...body });
    setCrate(data.crate);
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
    if (view.projectId !== target.projectId) return;
    view.mark = target.padId;
    view.bank = target.padId[0];
    history.replaceState(history.state, '', hashFor(view.projectId, view.bank, view.mark));
    renderProject();
    const row = pads.querySelector(`[data-pad="${target.padId}"]`);
    if (row) row.focus({ preventScroll: true });
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
  // A value that is the same as on the card is not an edit, so it is not kept as one.
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

// ── New project and rename ──────────────────────────────────────────────────

function openName(mode) {
  nameMode = mode;
  const renaming = mode === 'rename';
  $('nameTitle').textContent = renaming ? 'Rename project' : 'New project';
  const fromCard = renaming && own(crate.projects, view.projectId)?.source !== 'manual';
  $('nameText').textContent = !renaming
    ? 'For a project you write in by hand, pad by pad.'
    : fromCard
      ? 'The new name stays when you read the SD card again. Leave it empty to use the name from the card.'
      : 'Write the new name.';
  $('nameInput').value = renaming ? projectName(view.projectId) : '';
  $('nameSave').textContent = renaming ? 'Save' : 'Create project';
  say($('nameError'), '');
  nameBusy(false);
  openLayer(nameSheet, $('nameInput'));
}

function nameBusy(on) {
  for (const button of nameSheet.querySelectorAll('button')) button.disabled = on;
}

$('nameForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('nameInput').value.trim();
  const fromCard = nameMode === 'rename' && own(crate.projects, view.projectId)?.source !== 'manual';
  if (!name && !fromCard) {
    say($('nameError'), 'Write a name for the project.');
    $('nameInput').focus();
    return;
  }
  const mode = nameMode;
  const projectId = view.projectId;
  nameBusy(true);
  let data;
  try {
    data = mode === 'rename' ? await api('rename', { projectId, name }) : await api('project', { name });
    setCrate(data.crate);
  } catch (err) {
    if (!nameSheet.hidden) {
      nameBusy(false);
      say($('nameError'), err.message);
    }
    return;
  }
  nameMode = null;
  if (mode === 'rename') {
    closeLayer(() => {
      renderProject();
      $('projectName').focus({ preventScroll: true });
    });
  } else {
    closeLayer(() => {
      if (data.projectId && own(crate.projects, data.projectId)) openProject(data.projectId, 'A');
      else renderHome();
    });
  }
};
$('nameCancel').onclick = () => {
  nameMode = null;
  closeLayer();
};

// ── Delete project (asked in the page, never with confirm()) ────────────────

$('delete').onclick = () => {
  const id = view.projectId;
  const fromCard = own(crate.projects, id)?.source !== 'manual';
  $('confirmTitle').textContent = `Delete ${projectName(id)}?`;
  $('confirmText').textContent = fromCard
    ? 'Its pads and your edits are removed from the crate. The SD card is not touched, and reading it again brings the project back without your edits.'
    : 'Its pads are removed from the crate and cannot be recovered.';
  say($('confirmError'), '');
  $('projectActions').hidden = true;
  $('confirmStrip').hidden = false;
  $('confirmCancel').focus();
};
$('confirmCancel').onclick = () => {
  hideConfirm();
  $('delete').focus();
};
$('confirmDelete').onclick = async () => {
  const id = view.projectId;
  $('confirmDelete').disabled = $('confirmCancel').disabled = true;
  try {
    const data = await api('delete', { projectId: id });
    setCrate(data.crate);
  } catch (err) {
    say($('confirmError'), err.message);
    return;
  } finally {
    $('confirmDelete').disabled = $('confirmCancel').disabled = false;
  }
  hideConfirm();
  goHome();
};

$('rename').onclick = () => openName('rename');
$('newProject').onclick = () => openName('new');
$('back').onclick = goHome;

// ── Read SD card ────────────────────────────────────────────────────────────

function importStatus(text, { busy = false, warnings = [], error = false } = {}) {
  $('importStrip').hidden = false;
  $('importBusy').hidden = !busy;
  const p = $('importText');
  p.textContent = text;
  p.className = error ? 'error' : '';
  const ul = $('importWarnings');
  ul.replaceChildren(...warnings.map((w) => make('li', null, w)));
  ul.hidden = warnings.length === 0;
}

/** Split the projects so no request is bigger than the server accepts. */
function batches(found) {
  const out = [];
  let current = [];
  let size = 0;
  for (const p of found) {
    const n = JSON.stringify(p).length;
    if (current.length && size + n > IMPORT_BATCH_CHARS) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += n;
  }
  if (current.length) out.push(current);
  return out;
}

$('readCard').onclick = () => $('sdInput').click();
$('sdInput').onchange = async (e) => {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  $('readCard').disabled = true;
  importStatus(`Reading ${plural(files.length, 'file', 'files')} from the card.`, { busy: true });
  try {
    const { projects: found = [], warnings = [] } = await findProjects(files);
    if (found.length === 0) {
      importStatus('No projects found in that folder. Choose the SP-404MKII folder on the card, the one that holds the PROJECT folders.', { warnings, error: true });
      return;
    }
    importStatus(`Saving ${plural(found.length, 'project', 'projects')} to the crate.`, { busy: true });
    for (const group of batches(found)) {
      const data = await api('import', { projects: group });
      setCrate(data.crate);
    }
    const samples = found.reduce((sum, p) => sum + Object.keys(p.pads || {}).length, 0);
    const names = found.map((p) => `${projectName(p.id)} (${Object.keys(p.pads || {}).length})`).join(', ');
    importStatus(`Read ${plural(found.length, 'project', 'projects')} and ${plural(samples, 'sample', 'samples')} from the card: ${names}.`, { warnings });
    renderHome();
  } catch (err) {
    importStatus(`The card was not read. ${err.message || err}`, { error: true });
  } finally {
    e.target.value = '';
    $('readCard').disabled = false;
  }
};

search.addEventListener('input', renderHome);

// ── Gate ────────────────────────────────────────────────────────────────────

function showGate(mode) {
  gateMode = mode;
  const setup = mode === 'setup';
  $('gateTitle').textContent = setup ? 'Create the password.' : 'Enter the password.';
  $('gateText').textContent = setup
    ? 'It protects your crate. Only someone who knows it can see or change your projects. At least 8 characters.'
    : 'This device will remember it for 3 months.';
  $('repeatWrap').hidden = !setup;
  $('password').autocomplete = setup ? 'new-password' : 'current-password';
  $('password2').required = setup;
  $('enter').textContent = setup ? 'Create password' : 'Enter';
  $('password').value = $('password2').value = '';
  say($('gateError'), '');
  editing = null;
  nameMode = null;
  layerEntry = false;
  afterLayerPop = null;
  home.hidden = project.hidden = true;
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
  $('homeActions').hidden = $('logoutStrip').hidden = false;
  try {
    await load();
  } catch (err) {
    if (gate.hidden) problem(err.message);
    return;
  }
  route();
}

function problem(message) {
  home.hidden = project.hidden = true;
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
  search.value = '';
  $('importStrip').hidden = true;
  history.replaceState(null, '', location.pathname + location.search);
  showGate('login');
};

// Escape closes an open sheet.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!padSheet.hidden) $('padCancel').click();
  else if (!nameSheet.hidden) $('nameCancel').click();
});

// ── Start ───────────────────────────────────────────────────────────────────

// A leftover sheet entry (after a reload) is just a plain page.
if (history.state && history.state.layer) history.replaceState({ ...history.state, layer: false }, '');

api('state')
  .then((state) => {
    // `setup` is true once a password exists (see api.php).
    if (state.signedIn) return enter();
    showGate(state.setup ? 'login' : 'setup');
  })
  .catch((err) => problem(err.message));
