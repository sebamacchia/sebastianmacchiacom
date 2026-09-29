// Shared behavior — homepage and project pages

// Booking: paste your Cal.com link (e.g. "sebastianmacchia/30min") to turn [data-book] into a scheduling popup.
const CAL_LINK = '';
if (CAL_LINK) {
  (function (C, A, L) { let p = function (a, ar) { a.q.push(ar); }; let d = C.document; C.Cal = C.Cal || function () { let cal = C.Cal; let ar = arguments; if (!cal.loaded) { cal.ns = {}; cal.q = cal.q || []; d.head.appendChild(d.createElement("script")).src = A; cal.loaded = true; } if (ar[0] === L) { const api = function () { p(api, arguments); }; const namespace = ar[1]; api.q = api.q || []; if (typeof namespace === "string") { cal.ns[namespace] = cal.ns[namespace] || api; p(cal.ns[namespace], ar); p(cal, ["initNamespace", namespace]); } else p(cal, ar); return; } p(cal, ar); }; })(window, "https://app.cal.com/embed/embed.js", "init");
  Cal("init", { origin: "https://cal.com" });
  Cal("ui", { theme: "dark" });
  document.querySelectorAll('[data-book]').forEach(el => {
    el.setAttribute('data-cal-link', CAL_LINK);
    el.setAttribute('data-cal-config', '{"theme":"dark"}');
  });
}

// Fade sections in as they enter the viewport
const revealer = new IntersectionObserver(entries => entries.forEach(e => {
  if (e.isIntersecting) { e.target.classList.add('in'); revealer.unobserve(e.target); }
}), { threshold: .1 });
document.querySelectorAll('.reveal').forEach(el => revealer.observe(el));

// Clips play only while on screen (saves battery and bandwidth)
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const player = new IntersectionObserver(entries => entries.forEach(e => {
  if (e.isIntersecting && !reduceMotion) e.target.play().catch(() => {});
  else e.target.pause();
}), { threshold: .25 });
document.querySelectorAll('video[data-autoplay]').forEach(v => player.observe(v));

// Celluloid artifacts on every page: slight exposure flicker, dust specks, the odd vertical scratch.
// Runs at ~24fps on a fixed, click-through layer above the page (grain itself is CSS, in site.css).
if (!reduceMotion) {
  // On the cinema page the artifacts sit on the screen ([data-film]); elsewhere over the whole window
  const host = document.querySelector('[data-film]');
  const fx = document.createElement('canvas');
  fx.setAttribute('aria-hidden', 'true');
  fx.style.cssText = `position:${host ? 'absolute' : 'fixed'};inset:0;width:100%;height:100%;z-index:${host ? 6 : 99};pointer-events:none;`;
  (host || document.body).appendChild(fx);
  const c = fx.getContext('2d');
  let w, h, scratches = [], last = 0;
  const size = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = host ? host.clientWidth : innerWidth; h = host ? host.clientHeight : innerHeight;
    fx.width = w * dpr; fx.height = h * dpr; c.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const frame = now => {
    requestAnimationFrame(frame);
    if (now - last < 1000 / 24 || document.hidden) return;
    last = now;
    c.clearRect(0, 0, w, h);
    c.fillStyle = `rgba(255,255,255,${Math.random() * .01})`;
    c.fillRect(0, 0, w, h);
    const specks = Math.random() < .55 ? 0 : 1 + (Math.random() * 3 | 0);
    for (let i = 0; i < specks; i++) {
      const x = Math.random() * w, y = Math.random() * h, r = .6 + Math.random() * 2;
      c.fillStyle = Math.random() < .6 ? 'rgba(0,0,0,.8)' : 'rgba(236,235,232,.5)';
      c.beginPath(); c.ellipse(x, y, r, r * (.4 + Math.random()), Math.random() * 3, 0, 7); c.fill();
    }
    if (Math.random() < .015) scratches.push({ x: Math.random() * w, life: 4 + Math.random() * 20 | 0, a: .1 + Math.random() * .2 });
    scratches = scratches.filter(sc => sc.life-- > 0);
    for (const sc of scratches) {
      sc.x += (Math.random() - .5) * 1.2;
      c.fillStyle = `rgba(236,235,232,${sc.a})`;
      c.fillRect(sc.x, 0, .8, h);
    }
  };
  addEventListener('resize', size);
  size();
  requestAnimationFrame(frame);
}

// ── Documentary grammar ────────────────────────────────────────────────
// A handwritten note and an arrow drawn onto a photo, pointing at something in it:
//   <img data-point="0.53,0.17" data-note="this is sebastian.">   (point = fraction of the photo)
// The note is laid out from the photo's object-fit crop, so it lands on the same spot at any screen shape,
// and it copies the photo's transform every frame so it rides along with the slow push-in.
const SVG = 'http://www.w3.org/2000/svg';
window.clearNotes = root => root.querySelectorAll('.note').forEach(n => { n.stop(); n.remove(); });
window.annotate = (img, delay = 0) => {
  window.clearNotes(img.parentElement);
  if (!img.dataset.point) return;
  const note = document.createElement('div');
  note.className = 'note'; note.setAttribute('aria-hidden', 'true');
  note.style.setProperty('--d', `${reduceMotion ? 0 : delay}s`);
  img.after(note);
  let raf, alive = true;
  const follow = () => { if (!alive) return; note.style.transform = getComputedStyle(img).transform; raf = requestAnimationFrame(follow); };
  const onResize = () => { note.classList.add('instant'); build(); };
  note.stop = () => { alive = false; cancelAnimationFrame(raf); removeEventListener('resize', onResize); };
  function build() {
    const W = img.clientWidth, H = img.clientHeight, nw = img.naturalWidth, nh = img.naturalHeight;
    if (!W || !nw) return;
    const s = Math.max(W / nw, H / nh);
    const [ox, oy] = getComputedStyle(img).objectPosition.split(' ').map(v => parseFloat(v) / 100);
    const [px, py] = img.dataset.point.split(',').map(Number);
    const tx = (W - nw * s) * ox + px * nw * s, ty = (H - nh * s) * oy + py * nh * s;
    note.innerHTML = '';
    const fs = Math.max(22, Math.min(W * .034, 48));
    const label = document.createElement('span');
    label.className = 'label'; label.textContent = img.dataset.note; label.style.fontSize = `${fs}px`;
    note.appendChild(label);
    const lw = label.offsetWidth, dx = Math.max(W * .15, fs * 2.6), dy = Math.max(H * .16, fs * 2.2);
    // Write the note to the left of the target, or to the right when there's no room
    const left = tx - dx - lw > W * .04;
    const ax = left ? tx - dx : tx + dx, ly = Math.min(ty + dy, H * .8);
    label.style.left = `${left ? ax - lw : ax}px`; label.style.top = `${ly - fs * .62}px`;
    // Arrow from the end of the note, curving up into the target, stopping just short of it
    const S = [ax + (left ? 6 : -6), ly - fs * .55];
    const C = [S[0] + (tx - S[0]) * .1, ty + (S[1] - ty) * .05];
    let ux = tx - C[0], uy = ty - C[1]; const ul = Math.hypot(ux, uy); ux /= ul; uy /= ul;
    const E = [tx - ux * fs * .3, ty - uy * fs * .3], h = fs * .42, a = .5;
    const head = sgn => [E[0] - h * (ux * Math.cos(a) - sgn * uy * Math.sin(a)), E[1] - h * (uy * Math.cos(a) + sgn * ux * Math.sin(a))];
    const [h1, h2] = [head(1), head(-1)];
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.innerHTML = `<path class="shaft" pathLength="1" d="M${S} Q${C} ${E}"/><path class="head" d="M${h1} L${E} L${h2}"/>`;
    svg.style.strokeWidth = Math.max(2, fs * .075);
    note.appendChild(svg);
  }
  const start = () => { if (!alive) return; build(); follow(); addEventListener('resize', onResize); };
  if (img.complete && img.naturalWidth) start(); else img.addEventListener('load', start, { once: true });
};

// Documentary subtitle: one line at the bottom of the frame, fades in after `delay` seconds
window.subtitle = (el, text, delay = 0) => {
  if (!el) return;
  el.innerHTML = '';
  if (!text) return;
  const line = document.createElement('span');
  line.textContent = text; line.style.animationDelay = `${reduceMotion ? 0 : delay}s`;
  el.appendChild(line);
};

// Typewriter: types the element's text one character at a time, starting after `delay` seconds
window.typeOn = (el, delay = 0, rate = .065) => {
  if (!el) return 0;
  const text = el.dataset.text || (el.dataset.text = el.textContent);
  el.setAttribute('aria-label', text);
  const esc = ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch] || ch);
  el.innerHTML = [...text].map((ch, i) => `<i aria-hidden="true" style="animation-delay:${reduceMotion ? 0 : (delay + i * rate).toFixed(3)}s">${esc(ch)}</i>`).join('');
  return delay + text.length * rate;
};
