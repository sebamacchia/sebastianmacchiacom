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
  // notes: data-notes='[{"at":[x,y],"text":"…"}, {"to":".selector","text":"…"}]' (at = fraction of the photo, to = an element to point at)
  // or the single-note shorthand data-point="x,y" data-note="…"; notes appear one after another, `gap` seconds apart
  const notes = img.dataset.notes ? JSON.parse(img.dataset.notes) : img.dataset.point ? [{ at: img.dataset.point.split(',').map(Number), text: img.dataset.note }] : [];
  if (!notes.length) return;
  const gap = parseFloat(img.dataset.gap) || 2.1;
  const note = document.createElement('div');
  note.className = 'note'; note.setAttribute('aria-hidden', 'true');
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
    const box = img.getBoundingClientRect(), k = box.width / W || 1;       // undo the push-in scale when measuring page elements
    note.innerHTML = '';
    notes.forEach((n, i) => {
      if (n.portrait && W < H) n = { ...n, ...n.portrait };             // a different placement on tall (phone) screens
      let tx, ty;
      if (n.to) {                                                          // point at an element (e.g. a link): its left edge, or its top with edge:'top'
        const el = img.closest('.frame, .scene, body').querySelector(n.to); if (!el) return;
        const r = el.getBoundingClientRect();
        if (n.edge === 'top') { tx = (r.left + r.width / 2 - box.left) / k; ty = (r.top - box.top) / k - 8; }
        else { tx = (r.left - box.left) / k - 8; ty = (r.top + r.height / 2 - box.top) / k; }
      } else { tx = (W - nw * s) * ox + n.at[0] * nw * s; ty = (H - nh * s) * oy + n.at[1] * nh * s; }
      const one = document.createElement('div');
      one.className = 'one'; one.style.setProperty('--d', `${reduceMotion ? 0 : delay + i * gap}s`);
      const fs = Math.max(20, Math.min(W * .034, 48)) * (n.size || 1);
      const label = document.createElement('span');
      label.className = 'label'; label.textContent = n.text; label.style.fontSize = `${fs}px`;
      one.appendChild(label); note.appendChild(one);
      const dx = Math.max(W * (n.dx ?? .15), fs * 2.6), dy = H * (n.dy ?? .16);
      // Write the note to the left of the target, or to the right when there's no room; wrap long notes
      const room = side => side ? tx - dx - W * .04 : W * .96 - (tx + dx);
      label.style.maxWidth = `${Math.max(fs * 5, Math.min(fs * (n.wrap || 30), Math.max(room(true), room(false))))}px`;
      let lw = label.offsetWidth;
      const left = n.side ? n.side === 'left' : room(true) >= lw;
      label.style.maxWidth = `${Math.max(fs * 5, Math.min(fs * (n.wrap || 30), room(left)))}px`; lw = label.offsetWidth;
      const lh = label.offsetHeight, ax = left ? tx - dx : tx + dx;
      const top = Math.max(H * .04, Math.min(ty + dy - fs * .62, H * .94 - lh));
      label.style.left = `${left ? ax - lw : ax}px`; label.style.top = `${top}px`;
      // Arrow from the end of the note's first line, curving into the target, stopping just short of it
      const S = [ax + (left ? 6 : -6), top + (dy < 0 ? lh - fs * .35 : fs * .1)];
      const C = [S[0] + (tx - S[0]) * .1, ty + (S[1] - ty) * .05];
      let ux = tx - C[0], uy = ty - C[1]; const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
      const E = [tx - ux * fs * .3, ty - uy * fs * .3], h = fs * .42, a = .5;
      const head = sgn => [E[0] - h * (ux * Math.cos(a) - sgn * uy * Math.sin(a)), E[1] - h * (uy * Math.cos(a) + sgn * ux * Math.sin(a))];
      const svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
      svg.innerHTML = `<path class="shaft" d="M${S} Q${C} ${E}"/><path class="head" d="M${head(1)} L${E} L${head(-1)}"/>`;
      svg.style.strokeWidth = Math.max(2, fs * .075);
      one.appendChild(svg);
      const shaft = svg.querySelector('.shaft'); shaft.style.setProperty('--len', `${Math.ceil(shaft.getTotalLength()) + 2}px`);
    });
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

// Film burn at the cut: a few frames of light flaring through the gate (assets/film-burn.*), screened over the screen
window.filmBurn = (() => {
  let v = null;
  return (host, delay = 0) => {
    if (reduceMotion || !host) return;
    if (!v) {
      v = document.createElement('video');
      v.className = 'burn'; v.muted = true; v.playsInline = true; v.preload = 'auto'; v.setAttribute('aria-hidden', 'true');
      const base = document.querySelector('script[src*="site.js"]').src.replace(/site\.js.*$/, '');
      v.innerHTML = `<source src="${base}assets/film-burn.webm" type="video/webm"><source src="${base}assets/film-burn.mp4" type="video/mp4">`;
      host.appendChild(v);
    }
    clearTimeout(v.t);
    v.t = setTimeout(() => { v.currentTime = 0; v.playbackRate = .55; v.classList.add('on'); v.play().catch(() => {}); }, delay * 1000);
    v.onended = () => v.classList.remove('on');
  };
})();
