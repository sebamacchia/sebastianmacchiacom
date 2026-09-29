// Intro: a single camera move from the street, through the doors of a movie palace, down the aisle to the screen.
// Everything is built procedurally with Three.js and graded to black and white; it ends aligned with the site's screen.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

const overlay = document.getElementById('intro');
if (overlay && document.documentElement.classList.contains('intro')) start();

async function start() {
  window.__introStarted = true;
  try { await Promise.all([document.fonts.load('500 120px "Oswald"'), document.fonts.load('400 120px "Alfa Slab One"')]); } catch (e) {}

  const canvas = overlay.querySelector('canvas');
  const mobile = innerWidth < 760;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.75;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020202);
  scene.fog = new THREE.FogExp2(0x050505, 0.028);
  // The 3D screen takes the exact shape of the site's screen: wide on a computer, tall on a phone held upright
  const siteScreen = document.querySelector('.screen').getBoundingClientRect();
  const screenAspect = siteScreen.width / siteScreen.height;
  const portrait = screenAspect < 1;
  // a wider lens on portrait phones so the street and marquee still fit the narrow frame
  const camera = new THREE.PerspectiveCamera(portrait ? 62 : 42, innerWidth / innerHeight, 0.05, 200);

  // ---------- materials ----------
  const std = (color, rough = 0.8, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  const glow = (color, intensity = 1) => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: intensity });
  // procedural cut-stone texture: blocks, mortar lines and grain
  const stoneTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 512; const g = c.getContext('2d');
    g.fillStyle = '#8a857e'; g.fillRect(0, 0, 512, 512);
    const img = g.getImageData(0, 0, 512, 512), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 38; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    g.putImageData(img, 0, 0);
    g.strokeStyle = 'rgba(30,28,26,.55)'; g.lineWidth = 3;
    for (let y = 0; y <= 512; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke();
      for (let x = (y / 64) % 2 ? 0 : 64; x <= 512; x += 128) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 64); g.stroke(); } }
    for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`; g.beginPath(); g.ellipse(Math.random() * 512, Math.random() * 512, 4 + Math.random() * 40, 3 + Math.random() * 18, Math.random() * 3, 0, 7); g.fill(); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
  })();
  const stone = new THREE.MeshStandardMaterial({ color: 0xbdb6ac, map: stoneTex, roughness: 0.85 });
  const stoneDark = std(0x3d3a37, 0.9);
  const asphalt = std(0x1a1a1a, 0.35, 0.1);
  const velvet = std(0x6a6262, 0.9);
  const wood = std(0x2a2522, 0.6);
  const brass = std(0x9a8a6a, 0.35, 0.8);
  const bulbMat = glow(0xfff1d6, 2.2);

  const box = (w, h, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); scene.add(m); return m; };

  // ---------- street ----------
  if (!mobile) {
    const mirror = new Reflector(new THREE.PlaneGeometry(90, 60), { color: 0x6a6a6a, textureWidth: innerWidth * 0.5, textureHeight: innerHeight * 0.5 });
    mirror.rotation.x = -Math.PI / 2; mirror.position.set(0, 0.0, 30); scene.add(mirror);
  }
  const wet = new THREE.Mesh(new THREE.PlaneGeometry(90, 60), new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.45, metalness: 0.2, transparent: true, opacity: mobile ? 1 : 0.7 }));
  wet.rotation.x = -Math.PI / 2; wet.position.set(0, 0.01, 30); scene.add(wet);
  // puddle-ish streaks: lighter patches break up the mirror
  for (let i = 0; i < 18; i++) {
    const p = new THREE.Mesh(new THREE.CircleGeometry(0.6 + Math.random() * 2.2, 24), new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9, transparent: true, opacity: 0.55 }));
    p.rotation.x = -Math.PI / 2; p.scale.x = 1.6 + Math.random() * 2; p.position.set((Math.random() - 0.5) * 30, 0.02, 6 + Math.random() * 22); scene.add(p);
  }
  box(60, 0.18, 4, stoneDark, 0, 0.09, 2);                 // sidewalk
  box(60, 0.2, 0.25, stone, 0, 0.1, 4.05);                 // curb

  // ---------- facade (front face at z = 0), with a doorway 6 wide x 3.4 high ----------
  box(12, 24, 1.5, stone, -9, 12, -0.75);
  box(12, 24, 1.5, stone, 9, 12, -0.75);
  box(6, 20.6, 1.5, stone, 0, 3.4 + 10.3, -0.75);
  box(30.6, 0.9, 2.2, stoneDark, 0, 23.6, -0.6);           // cornice
  box(30.4, 0.5, 1.9, stoneDark, 0, 7.6, -0.5);            // belt course
  for (const x of [-14.6, -8.6, -3.4, 3.4, 8.6, 14.6]) box(0.8, 24, 1.8, stoneDark, x, 12, -0.4); // pilasters
  // windows (a few lit)
  for (let row = 0; row < 4; row++) for (const x of [-11.6, -6, 6, 11.6]) {
    const lit = Math.random() < 0.3;
    const w = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 3.2), lit ? glow(0xffe6c0, 0.4) : std(0x0a0a0a, 0.2, 0.6));
    w.position.set(x, 10 + row * 3.8, 0.02); scene.add(w);
    box(2.6, 0.2, 0.3, stoneDark, x, 10 + row * 3.8 - 1.7, 0.1);
  }
  // tall vertical window over the entrance
  const tall = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 9), glow(0xfff0d8, 0.3)); tall.position.set(0, 14.5, 0.02); scene.add(tall);
  for (let i = -1; i <= 1; i++) box(0.12, 9, 0.2, stoneDark, i * 0.8, 14.5, 0.08);

  // doors: two glass leaves hinged at the jambs, glowing from the lobby
  const doorGlass = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xfff2e0, emissiveIntensity: 0.45, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.9 });
  const leaf = (side) => {
    const pivot = new THREE.Group(); pivot.position.set(side * 3, 0.18, 0.05); scene.add(pivot);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(3, 3.2, 0.1), brass); frame.position.set(-side * 1.5, 1.6, 0); pivot.add(frame);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.8), doorGlass); glass.position.set(-side * 1.5, 1.6, 0.06); pivot.add(glass);
    return pivot;
  };
  const doorL = leaf(-1), doorR = leaf(1);

  // ---------- marquee ----------
  const marqueeTex = (() => {
    // NOW SHOWING / the name in poster slab letters / the title of the picture
    const W = 2048, H = 236;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    g.fillStyle = '#f4efe6'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#c9c2b6'; g.lineWidth = 2; for (let x = 0; x < W; x += 128) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    g.fillStyle = '#141414'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const spaced = (text, y, font, gap) => {                         // letter-spaced line, centred
      g.font = font; const chars = [...text], w = chars.reduce((a, ch) => a + g.measureText(ch).width + gap, -gap);
      let x = W / 2 - w / 2; g.textAlign = 'left';
      chars.forEach(ch => { g.fillText(ch, x, y); x += g.measureText(ch).width + gap; });
      g.textAlign = 'center';
    };
    spaced('★  NOW SHOWING  ★', 33, '500 50px "Oswald", "Arial Narrow", sans-serif', 14);
    g.fillRect(540, 64, 968, 3);
    g.font = '400 112px "Alfa Slab One", "Rockwell", Georgia, serif';
    g.fillText('SEBASTIAN MACCHIA', W / 2, 123);
    g.fillRect(540, 180, 968, 3);
    spaced('THE MOVIE-WEBSITE', 211, '500 48px "Oswald", "Arial Narrow", sans-serif', 16);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
  })();
  const marquee = new THREE.Group(); marquee.position.set(0, 4.9, 1.2); scene.add(marquee);
  const mBody = new THREE.Mesh(new THREE.BoxGeometry(17, 2.6, 2.4), std(0x1c1c1c, 0.5, 0.6)); marquee.add(mBody);
  const mFace = new THREE.Mesh(new THREE.PlaneGeometry(15.6, 1.8), new THREE.MeshStandardMaterial({ map: marqueeTex, emissiveMap: marqueeTex, emissive: 0xffffff, emissiveIntensity: 0.55 }));
  mFace.position.z = 1.21; marquee.add(mFace);
  // bulbs around the face and under the canopy
  const bulbs = []; const bulbGeo = new THREE.SphereGeometry(0.07, 10, 8);
  const addBulb = (x, y, z) => bulbs.push([x, y, z]);
  for (let x = -8.2; x <= 8.2; x += 0.42) { addBulb(x, 1.12, 1.25); addBulb(x, -1.12, 1.25); }
  for (let y = -0.9; y <= 0.9; y += 0.42) { addBulb(-8.2, y, 1.25); addBulb(8.2, y, 1.25); }
  for (let x = -7.8; x <= 7.8; x += 0.8) for (let z = -0.8; z <= 0.9; z += 0.85) addBulb(x, -1.32, z);
  const bulbMesh = new THREE.InstancedMesh(bulbGeo, bulbMat, bulbs.length);
  const tmp = new THREE.Object3D();
  bulbs.forEach(([x, y, z], i) => { tmp.position.set(x, y, z); tmp.updateMatrix(); bulbMesh.setMatrixAt(i, tmp.matrix); });
  marquee.add(bulbMesh);
  const underLight = new THREE.PointLight(0xfff0d8, 140, 16, 2); underLight.position.set(0, 3.2, 2.2); scene.add(underLight);

  // poster cases beside the doors
  for (const x of [-5.2, 5.2]) {
    box(1.9, 2.8, 0.2, brass, x, 1.9, 0.1);
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.5), glow(0xd8d2c8, 0.18)); p.position.set(x, 1.9, 0.21); scene.add(p);
  }

  // street lamps
  for (const x of [-10.5, 10.5]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 5, 12), std(0x111111, 0.4, 0.8)); pole.position.set(x, 2.5, 4.6); scene.add(pole);
    const globe = new THREE.Mesh(new THREE.SphereGeometry(0.36, 20, 14), glow(0xfff4e0, 1.6)); globe.position.set(x, 5.2, 4.6); scene.add(globe);
    const l = new THREE.PointLight(0xfff4e0, 160, 22, 2); l.position.set(x, 5.1, 4.6); scene.add(l);
  }
  scene.add(new THREE.HemisphereLight(0x9a9a9a, 0x080808, 0.9));
  for (const x of [-14.6, -8.6, 8.6, 14.6]) {
    const up = new THREE.SpotLight(0xfff0dc, 900, 34, 0.34, 0.6, 2);
    up.position.set(x, 0.3, 1.6); up.target.position.set(x, 18, -0.5);
    scene.add(up, up.target);
  }

  // ---------- lobby (z 0 .. -9) ----------
  box(0.3, 3.6, 9, std(0x4a4440, 0.7), -3.1, 1.8, -4.5);
  box(0.3, 3.6, 9, std(0x4a4440, 0.7), 3.1, 1.8, -4.5);
  box(6.4, 0.2, 9, std(0x2b2724, 0.5), 0, 3.6, -4.5);
  const lobbyFloor = new THREE.Mesh(new THREE.PlaneGeometry(6, 9), std(0x242220, 0.25, 0.2)); lobbyFloor.rotation.x = -Math.PI / 2; lobbyFloor.position.set(0, 0.19, -4.5); scene.add(lobbyFloor);
  for (const z of [-2.5, -6.5]) {
    const ch = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), glow(0xfff0d8, 0.9)); ch.position.set(0, 3.1, z); scene.add(ch);
    const l = new THREE.PointLight(0xfff0d8, 16, 9, 2); l.position.set(0, 2.9, z); scene.add(l);
  }
  for (const z of [-1.5, -4.5, -7.5]) for (const x of [-2.9, 2.9]) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), glow(0xfff0d8, 2.5)); s.position.set(x, 2.3, z); scene.add(s);
  }
  // auditorium entry wall with an opening
  box(9, 3.6, 0.3, std(0x3a3532, 0.8), -7.5, 1.8, -9);
  box(9, 3.6, 0.3, std(0x3a3532, 0.8), 7.5, 1.8, -9);

  // ---------- auditorium (z -9 .. -44) ----------
  const AUD_W = 26, AUD_H = 13, SCREEN_Z = -44;
  const SCREEN_H = portrait ? 10 : 9, SCREEN_W = SCREEN_H * screenAspect, SCREEN_Y = SCREEN_H / 2 + 1.4;
  box(0.4, AUD_H, 35, std(0x4a4542, 0.9), -AUD_W / 2, AUD_H / 2, -26.5);
  box(0.4, AUD_H, 35, std(0x4a4542, 0.9), AUD_W / 2, AUD_H / 2, -26.5);
  box(AUD_W, 0.4, 35, std(0x151312, 0.9), 0, AUD_H, -26.5);
  box(AUD_W, AUD_H, 0.4, std(0x0d0c0b, 0.9), 0, AUD_H / 2, SCREEN_Z - 0.6);
  const audFloor = new THREE.Mesh(new THREE.PlaneGeometry(AUD_W, 35), std(0x141211, 0.9)); audFloor.rotation.x = -Math.PI / 2; audFloor.position.set(0, 0.01, -26.5); scene.add(audFloor);
  // aisle runner
  const runner = new THREE.Mesh(new THREE.PlaneGeometry(2, 30), std(0x2a2626, 0.95)); runner.rotation.x = -Math.PI / 2; runner.position.set(0, 0.02, -24); scene.add(runner);
  // stage
  box(20, 1, 3, wood, 0, 0.5, SCREEN_Z + 1.2);

  // the screen: a glowing 16:9 rectangle inside a black masking frame
  const screenMat = glow(0xf6f3ee, 1.6);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H), screenMat); screen.position.set(0, SCREEN_Y, SCREEN_Z); scene.add(screen);
  box(SCREEN_W + 1.6, 0.8, 0.2, std(0x050505, 1), 0, SCREEN_Y + SCREEN_H / 2 + 0.4, SCREEN_Z + 0.05);
  box(SCREEN_W + 1.6, 0.8, 0.2, std(0x050505, 1), 0, SCREEN_Y - SCREEN_H / 2 - 0.4, SCREEN_Z + 0.05);
  box(0.8, SCREEN_H + 1.6, 0.2, std(0x050505, 1), -SCREEN_W / 2 - 0.4, SCREEN_Y, SCREEN_Z + 0.05);
  box(0.8, SCREEN_H + 1.6, 0.2, std(0x050505, 1), SCREEN_W / 2 + 0.4, SCREEN_Y, SCREEN_Z + 0.05);
  RectAreaLightUniformsLib.init();
  const wash = new THREE.RectAreaLight(0xf6f3ee, 9, SCREEN_W, SCREEN_H);
  wash.position.set(0, SCREEN_Y, SCREEN_Z + 0.2); wash.lookAt(0, SCREEN_Y, 0); scene.add(wash);

  // curtains: folded planes on each side and a pelmet above
  const curtain = (x, w) => {
    const g = new THREE.PlaneGeometry(w, AUD_H - 1, 80, 1);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 4.2) * 0.22);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, std(0x4a4242, 0.9)); m.position.set(x, (AUD_H - 1) / 2, SCREEN_Z + 0.6); scene.add(m);
  };
  curtain(-10.8, 4.6); curtain(10.8, 4.6);
  const pel = new THREE.PlaneGeometry(AUD_W, 1.8, 120, 1);
  { const p = pel.attributes.position; for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin(p.getX(i) * 5) * 0.15); pel.computeVertexNormals(); }
  const pelmet = new THREE.Mesh(pel, std(0x4a4242, 0.9)); pelmet.position.set(0, AUD_H - 1.4, SCREEN_Z + 0.9); scene.add(pelmet);

  // wall sconces
  for (let z = -14; z >= -38; z -= 6) for (const x of [-AUD_W / 2 + 0.3, AUD_W / 2 - 0.3]) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), glow(0xffe8c8, 1.8)); s.position.set(x, 5, z); scene.add(s);
    const l = new THREE.PointLight(0xffe8c8, 30, 8, 2); l.position.set(x * 0.95, 5, z); scene.add(l);
  }

  // seats: instanced backs + cushions, rows split by the centre aisle
  const seatBack = new THREE.BoxGeometry(0.62, 0.9, 0.12), seatBase = new THREE.BoxGeometry(0.62, 0.14, 0.55);
  const seatsPos = [];
  for (let r = 0; r < 18; r++) {
    const z = -13 - r * 1.35, y = 0.02 + r * 0.06;           // gentle rake
    for (let s = 0; s < 16; s++) {
      const x = 1.35 + s * 0.7;
      seatsPos.push([x, y, z], [-x, y, z]);
    }
  }
  const backs = new THREE.InstancedMesh(seatBack, velvet, seatsPos.length);
  const bases = new THREE.InstancedMesh(seatBase, velvet, seatsPos.length);
  seatsPos.forEach(([x, y, z], i) => {
    tmp.position.set(x, y + 0.85, z + 0.25); tmp.rotation.set(-0.12, 0, 0); tmp.updateMatrix(); backs.setMatrixAt(i, tmp.matrix);
    tmp.position.set(x, y + 0.45, z - 0.05); tmp.rotation.set(0, 0, 0); tmp.updateMatrix(); bases.setMatrixAt(i, tmp.matrix);
  });
  scene.add(backs, bases);

  // projector beam with floating dust
  const beamGeo = new THREE.CylinderGeometry(SCREEN_W * 0.42, 0.25, Math.abs(SCREEN_Z) - 8, 32, 1, true);
  beamGeo.rotateX(Math.PI / 2);
  const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xfff8ec, transparent: true, opacity: 0.045, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  beam.position.set(0, 8.2, (SCREEN_Z - 9) / 2 - 1); beam.lookAt(0, SCREEN_Y, SCREEN_Z); scene.add(beam);
  const dustN = mobile ? 220 : 520, dustPos = new Float32Array(dustN * 3);
  for (let i = 0; i < dustN; i++) {
    const k = Math.random();                                           // 0 at projector … 1 at screen
    const z = -9.5 + k * (SCREEN_Z + 9.5), r = (0.2 + k * SCREEN_W * 0.4) * Math.sqrt(Math.random()), a = Math.random() * 6.283;
    dustPos[i * 3] = Math.cos(a) * r; dustPos[i * 3 + 1] = 8.2 + (SCREEN_Y - 8.2) * k + Math.sin(a) * r * 0.6; dustPos[i * 3 + 2] = z;
  }
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.02, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(dust);

  // ---------- camera move ----------
  // End distance chosen so the 3D screen covers exactly the site's .screen rectangle.
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const endDist = Math.max(6, (SCREEN_H * innerHeight) / (2 * siteScreen.height * Math.tan(fovRad / 2)));
  const endY = SCREEN_Y + ((siteScreen.top + siteScreen.height / 2) - innerHeight / 2) / siteScreen.height * SCREEN_H;
  const path = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 1.6, 30),
    new THREE.Vector3(0, 1.75, 14),
    new THREE.Vector3(0, 1.7, 3.5),
    new THREE.Vector3(0, 1.7, -3),
    new THREE.Vector3(0, 1.8, -9.5),
    new THREE.Vector3(0, 3.2, -16),
    new THREE.Vector3(0, endY, SCREEN_Z + endDist),
  ], false, 'centripetal');
  const look = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 4.2, 0),
    new THREE.Vector3(0, 3.4, 0),
    new THREE.Vector3(0, 1.9, -6),
    new THREE.Vector3(0, 2.4, -20),
    new THREE.Vector3(0, SCREEN_Y, SCREEN_Z),
    new THREE.Vector3(0, endY, SCREEN_Z),
  ], false, 'centripetal');

  // ---------- post: bloom, then black-and-white film grade ----------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.45, 0.88));
  composer.addPass(new OutputPass());
  const film = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, time: { value: 0 }, flicker: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float time; uniform float flicker; varying vec2 vUv;
      float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453); }
      void main(){
        vec3 c = texture2D(tDiffuse, vUv).rgb;
        float l = dot(c, vec3(0.299, 0.587, 0.114));
        l = smoothstep(0.02, 0.98, l);                       // film contrast curve
        l *= flicker;
        float d = distance(vUv, vec2(0.5));
        l *= smoothstep(0.85, 0.3, d);                       // vignette
        l += (rand(vUv * 900.0 + time) - 0.5) * 0.09;        // grain
        gl_FragColor = vec4(vec3(l), 1.0);
      }`
  });
  composer.addPass(film);

  // ---------- run: the camera is scrubbed by scroll / arrows, both ways ----------
  // u = where the camera is along the move (0 street … 1 screen); target = where the visitor is scrolling to.
  const fixedU = window.__introU ?? null;
  const startAt = fixedU ?? (window.__introStartAt || 0);
  let u = startAt, target = startAt, inFilm = startAt >= 1, dirty = true;
  // Auto-walk: after the countdown the camera drifts toward the screen on its own (~6.5s street → screen).
  // Scrolling down keeps it going; scrolling up (rewinding) pauses it until the visitor scrolls forward again.
  const AUTO_SECONDS = 6.5;
  let auto = false, autoSince = 0, lastUser = 0, lastNow = performance.now();
  const hint = overlay.querySelector('.hint');
  const clamp01 = v => Math.min(1, Math.max(0, v));
  const tStart = performance.now();

  // Public handle used by the film controller in index.html
  window.__intro = {
    get inFilm() { return inFilm; },
    scrub(delta) {
      target = clamp01(target + delta); if (target < 1) inFilm = false; dirty = true;
      lastUser = performance.now();
      if (delta < 0) auto = false; else if (delta > 0 && !auto && !inFilm) { auto = true; autoSince = lastUser; }
    },
    play() { if (!inFilm) { auto = true; autoSince = performance.now(); } },
    enterFromFilm() { inFilm = false; auto = false; target = 0.97; u = Math.max(u, 0.995); dirty = true; },
    skip() { target = 1; dirty = true; },
  };
  overlay.querySelector('.skip').addEventListener('click', () => window.__intro.skip());

  const render = now => {
    const p = path.getPointAt(u), q = look.getPointAt(u);
    camera.position.copy(p); camera.lookAt(q);
    const open = 1 - THREE.MathUtils.smoothstep(p.z, 3.5, 9);          // doors swing open as the camera approaches
    doorL.rotation.y = open * -1.45; doorR.rotation.y = open * 1.45;
    const t = (now - tStart) / 1000;
    dust.rotation.y = t * 0.02;
    film.uniforms.time.value = t;
    film.uniforms.flicker.value = 0.96 + Math.random() * 0.06;
    composer.render();
  };

  const tick = now => {
    requestAnimationFrame(tick);
    try {
      const dt = Math.min(0.05, (now - lastNow) / 1000); lastNow = now;
      if (auto && !inFilm && fixedU === null && now - lastUser > 900) {
        const ramp = Math.min(1, (now - autoSince) / 1500);             // ease into the walk
        target = clamp01(target + dt / AUTO_SECONDS * ramp);
      }
      if (fixedU === null) u += (target - u) * 0.075;                    // eased follow: smooth, cinematic
      if (Math.abs(target - u) < 0.0004) u = target;
      // dissolve into the site's screen over the last few percent — reversible
      const fade = 1 - THREE.MathUtils.smoothstep(u, 0.955, 1);
      overlay.style.opacity = fade;
      overlay.style.pointerEvents = fade < 0.05 ? 'none' : '';
      if (hint) hint.style.opacity = u < 0.03 ? 1 : 0;
      if (fade > 0.001) render(now);                                      // grain/flicker keep it alive while visible
      if (!inFilm && u >= 0.999 && target >= 1) {                          // arrived at the screen: hand over to the film
        inFilm = true; auto = false;
        window.dispatchEvent(new Event('intro:done'));
      }
    } catch (err) { console.error(err); target = u = 1; overlay.style.opacity = 0; overlay.style.pointerEvents = 'none'; inFilm = true; window.dispatchEvent(new Event('intro:done')); }
  };
  if (inFilm) { overlay.style.opacity = 0; overlay.style.pointerEvents = 'none'; }
  requestAnimationFrame(tick);
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); });
}
