/* FACP Cause & Effect Simulator — 3D building view.
   Reads the same state as the 2D diagram (inputs, outputs, rule results) and draws it in a generic 4-level building.
   Built with three.js (bundled into fire3d.js). Educational model only. */
import {
  BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry, DoubleSide,
  EdgesGeometry, GridHelper, Group, HemisphereLight, DirectionalLight, LineBasicMaterial, LineSegments, MathUtils, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Points, PointsMaterial, Raycaster, RepeatWrapping, Scene, ShaderMaterial,
  CircleGeometry, SphereGeometry, Sprite, SpriteMaterial, TorusGeometry, Vector2, Vector3, WebGLRenderer
} from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';

const FH = 4, W = 36, D = 22;                       // floor height, building width (x), depth (z) in metres
const PCOL = [0x2c8a49, 0x1e5fc4, 0xc1121f];
const COL = {fire: 0xff3b30, pre: 0xff9f0a, sup: 0xffc400};
const TAU = Math.PI * 2;
const SX = 23.5, SZ = 9.6, ZW = -3.6, RX = 16.5, YC = 3.5;   // outdoor valve station origin, inside riser x, sprinkler pipe height above each floor

let host, api, renderer, scene, camera, controls, tipEl, canvas;
const rc = new Raycaster(), ndc = new Vector2();
let running = false, raf = 0, lastT = 0, T = 0;
const floors = [], dynG = [], walls = [], IN = [], OUT = [], pickables = [];
let L = {on: new Set(), outState: {}, inState: {}, sil: false, rank: 0, leds: {}, scr: {h: 'SYSTEM NORMAL', c: '', l: []}};
let cfgRef = null, floorCap = 3, showWalls = true, tween = null, dark = false, facp = null, lift = null, gasBox = null, hoverDev = null;
let pinTip = 0;
const M = {};

/* ---------------------------------------------------------------- helpers */
const rad = () => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.4, 'rgba(255,255,255,.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new CanvasTexture(c);
};
let HALO, DOT;
const box = (w, h, d, m) => new Mesh(new BoxGeometry(w, h, d), m);
const cyl = (r, h, m, s = 20) => new Mesh(new CylinderGeometry(r, r, h, s), m);
const sph = (r, m) => new Mesh(new SphereGeometry(r, 14, 10), m);
const std = (color, o = {}) => new MeshStandardMaterial({color, roughness: .55, metalness: .08, ...o});
const ledMat = () => new MeshStandardMaterial({color: 0x6b3030, emissive: 0x000000, roughness: .4});
const floorOf = y => Math.min(3, Math.max(0, Math.floor((y + .05) / FH)));
function put(o, x, y, z, ry = 0, sc = 1) {
  const fi = floorOf(y); o.position.set(x, y - fi * FH, z); o.rotation.y = ry; o.scale.setScalar(sc); dynG[fi].add(o); return o;
}
function outline(mesh, parent) {
  const l = new LineSegments(new EdgesGeometry(mesh.geometry), M.line);
  l.position.copy(mesh.position); (parent || mesh.parent).add(l); return l;
}
function halo(size) {
  const s = new Sprite(new SpriteMaterial({map: HALO, color: 0xff3b30, transparent: true, opacity: .0, depthTest: false, depthWrite: false}));
  s.scale.setScalar(size); s.renderOrder = 20; s.userData.base = size; return s;
}
function label(text, size = 1, parent, x = 0, y = 0, z = 0) {
  const c = document.createElement('canvas'); c.width = 320; c.height = 80;
  const g = c.getContext('2d'); let fs = 38; g.font = `700 ${fs}px Barlow,Arial,sans-serif`; const tw = g.measureText(text).width; if (tw > 290) { fs = Math.floor(fs * 290 / tw); g.font = `700 ${fs}px Barlow,Arial,sans-serif`; } g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 7; g.strokeStyle = 'rgba(10,14,20,.75)'; g.strokeText(text, 160, 42); g.fillStyle = '#fff'; g.fillText(text, 160, 42);
  const s = new Sprite(new SpriteMaterial({map: new CanvasTexture(c), transparent: true, depthTest: false, depthWrite: false, opacity: .9}));
  s.scale.set(size * 4, size, 1); s.position.set(x, y, z); s.renderOrder = 15; if (parent) parent.add(s); return s;
}
function liveLabel(size, parent, x, y, z) {
  const c = document.createElement('canvas'); c.width = 320; c.height = 80; const tex = new CanvasTexture(c);
  const sp = new Sprite(new SpriteMaterial({map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: .95}));
  sp.scale.set(size * 4, size, 1); sp.position.set(x, y, z); sp.renderOrder = 15; parent.add(sp);
  sp.userData.draw = (t, col = '#fff') => { const g = c.getContext('2d'); g.clearRect(0, 0, 320, 80); g.font = '700 38px Barlow,Arial,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 7; g.strokeStyle = 'rgba(10,14,20,.75)'; g.strokeText(t, 160, 42); g.fillStyle = col; g.fillText(t, 160, 42); tex.needsUpdate = true; };
  return sp;
}
const lerp = MathUtils.lerp, clamp = MathUtils.clamp;
const approach = (v, t, r, dt) => v + clamp(t - v, -r * dt, r * dt);

function makeMats() {
  HALO = rad(); DOT = rad();
  M.slab = std(0xb8c2cc, {roughness: .9, transparent: true, opacity: .3, depthWrite: false});
  M.glass = std(0x7aa6d6, {transparent: true, opacity: .07, depthWrite: false, side: DoubleSide});
  M.wall = std(0x9db4cc, {transparent: true, opacity: .2, depthWrite: false, side: DoubleSide});
  M.core = std(0x8fa3b8, {transparent: true, opacity: .26, depthWrite: false, side: DoubleSide});
  M.line = new LineBasicMaterial({color: 0x6b7a89, transparent: true, opacity: .6});
  M.red = std(0xd32f2f); M.white = std(0xf1f3f5); M.grey = std(0x8a949e); M.dgrey = std(0x4b5560); M.gold = std(0xd9a21b, {metalness: .5});
  M.pipe = std(0xaab3bb, {metalness: .45, roughness: .45}); M.pipeD = std(0x7a1717, {metalness: .3, roughness: .5}); M.pipeW = std(0xe5392f, {metalness: .2, roughness: .5});
  M.conc = std(0xaeb6bd, {roughness: .95}); M.black = std(0x1d2126, {roughness: .6}); M.red2 = std(0xa82020); M.blue2 = std(0x1f5fb0);
  M.pipeP = std(0xaab3bb, {metalness: .45, roughness: .45}); M.tankShell = std(0x9fc3e6, {transparent: true, opacity: .2, depthWrite: false, side: DoubleSide}); M.water = std(0x2f8fd8, {transparent: true, opacity: .75, depthWrite: false, roughness: .2});
  M.crf = std(0x3f6a94, {transparent: true, opacity: .32, depthWrite: false}); M.wood = std(0x8a6b45, {roughness: .7});
  M.orange = std(0xf08a24); M.yellow = std(0xf6c026); M.blue = std(0x2b6cc4); M.green = std(0x2e9d4f);
}
function applyTheme() {
  const cs = getComputedStyle(host), g = n => cs.getPropertyValue(n).trim();
  const bg = new Color(g('--surface-2') || '#f4f6f8'), hsl = {}; bg.getHSL(hsl);
  dark = hsl.l < .4;
  M.slab.color.set(dark ? 0x3a434d : 0xb8c2cc); M.conc.color.set(dark ? 0x3d464f : 0xaeb6bd);
  M.line.color.set(dark ? 0x9fb3c8 : 0x5f6f80); M.line.opacity = dark ? .55 : .6;
  M.glass.color.set(dark ? 0x5c8cc0 : 0x7aa6d6); M.wall.color.set(dark ? 0x6d88a6 : 0x9db4cc); M.core.color.set(dark ? 0x5f7690 : 0x8fa3b8);
  scene.userData.hemi.intensity = dark ? 1.05 : 1.25; scene.userData.grid.material.color.set(dark ? 0x37424d : 0xc3ccd5);
}


/* ---------------------------------------------------------------- control room (FACP, BMS wall screen, SPKA / BMS / alarm signal cabinets, operator desk) */
const dn = n => /iboss/i.test(n) ? 'SPKA' : n;
let crm = null;
function buildControlRoom() {
  const g0 = floors[0], X0 = -17.9, X1 = -9.4, Z0 = -10.9, Z1 = -4.4, cx = (X0 + X1) / 2, cz = (Z0 + Z1) / 2;
  const wl = (w, d, x, z) => { const p = box(w, FH - .1, d, M.wall); p.position.set(x, FH / 2, z); g0.add(p); walls.push(p); };
  wl(.15, 4.1, X1, -8.85); wl(.15, 1.2, X1, -5.0); wl(X1 - X0, .15, cx, Z1);
  const fl = box(X1 - X0, .05, Z1 - Z0, M.crf); fl.position.set(cx, .03, cz); g0.add(fl);
  label('CONTROL ROOM', 1.4, g0, cx + .6, .35, -5.2);
  // BMS video wall on the north wall
  const cv = document.createElement('canvas'); cv.width = 640; cv.height = 256; const tex = new CanvasTexture(cv);
  const fr = box(4.8, 1.75, .06, M.black); fr.position.set(cx + .6, 2.25, Z0 + .06); g0.add(fr);
  const sc = new Mesh(new BoxGeometry(4.64, 1.6, .02), new MeshBasicMaterial({map: tex})); sc.position.set(cx + .6, 2.25, Z0 + .1); g0.add(sc);
  // operator desk, 3 monitors, chair
  const dk = box(3.4, .07, 1.0, M.wood); dk.position.set(cx + .6, .74, -8.5); g0.add(dk);
  [[-1.6, -.4], [1.6, -.4], [-1.6, .4], [1.6, .4]].forEach(([dx, dz]) => { const l = box(.06, .72, .06, M.dgrey); l.position.set(cx + .6 + dx, .36, -8.5 + dz); g0.add(l); });
  const mons = [];
  [-1.05, 0, 1.05].forEach(dx => {
    const b = box(.62, .4, .04, M.black); b.position.set(cx + .6 + dx, 1.2, -8.72); g0.add(b);
    const m = new MeshBasicMaterial({color: 0x2e9d4f}); const s2 = new Mesh(new BoxGeometry(.56, .34, .01), m); s2.position.set(cx + .6 + dx, 1.2, -8.695); g0.add(s2); mons.push(m);
    const st = box(.05, .3, .05, M.dgrey); st.position.set(cx + .6 + dx, .93, -8.72); g0.add(st);
    const kb = box(.42, .02, .15, M.dgrey); kb.position.set(cx + .6 + dx, .79, -8.2); g0.add(kb);
  });
  const sd = cyl(.3, .07, M.dgrey, 16); sd.position.set(cx + .6, .5, -7.2); g0.add(sd); const bk = box(.5, .55, .06, M.dgrey); bk.position.set(cx + .6, .85, -6.95); g0.add(bk);
  const ps = cyl(.04, .45, M.grey, 8); ps.position.set(cx + .6, .25, -7.2); g0.add(ps); const bs = cyl(.28, .04, M.dgrey, 5); bs.position.set(cx + .6, .03, -7.2); g0.add(bs);
  // small status lamp over the door
  crm = {mons, cv, tex, key: ''};
}
function drawCtrl() {
  const q = crm, x = q.cv.getContext('2d'), rk = L.rank, fl = new Set(); IN.forEach(d => { if (d.on && d.wpos) fl.add(floorOf(d.wpos.y)); });
  const bg = rk >= 3 ? '#2a0c0c' : rk === 2 ? '#2a1d08' : rk === 1 ? '#262208' : '#08161d', fg = rk >= 3 ? '#ff7a70' : rk === 2 ? '#ffc266' : rk === 1 ? '#ffe066' : '#6be39a';
  x.fillStyle = bg; x.fillRect(0, 0, 640, 256); x.textBaseline = 'middle';
  x.fillStyle = '#8fa3b5'; x.font = '600 20px Arial'; x.fillText('BMS · BUILDING STATUS', 18, 22);
  x.fillStyle = fg; x.font = '700 44px Arial'; x.fillText(rk >= 3 ? 'FIRE ALARM' : rk === 2 ? 'PRE-ALARM' : rk === 1 ? 'SUPERVISORY' : 'ALL NORMAL', 18, 66);
  [['L2', 2], ['L1', 1], ['G', 0]].forEach(([n, f], i) => {
    const y = 108 + i * 42, al = fl.has(f); x.fillStyle = al ? '#a8261d' : '#16402a'; x.fillRect(18, y, 260, 34);
    x.fillStyle = '#fff'; x.font = '700 22px Arial'; x.fillText(n, 30, y + 18); x.font = '600 18px Arial'; x.fillText(al ? 'ALARM' : 'OK', 180, y + 18);
  });
  const sg = (cfgRef ? cfgRef.outputs : []).filter(o => o.kind === 'signal').slice(0, 4);
  x.fillStyle = '#8fa3b5'; x.font = '600 16px Arial'; x.fillText('SIGNALS SENT', 330, 108);
  sg.forEach((o, i) => { const on = !!L.outState[o.key], y = 140 + i * 30; x.fillStyle = on ? '#ff7a70' : '#3d5266'; x.beginPath(); x.arc(344, y, 8, 0, TAU); x.fill(); x.fillStyle = on ? '#fff' : '#9fb0bf'; x.font = '600 19px Arial'; x.fillText(dn(o.name).replace(/\s*\(.*\)/, '').slice(0, 24), 362, y); });
  const pm = L.pump; if (pm) { x.fillStyle = '#8fa3b5'; x.font = '600 16px Arial'; x.fillText('PUMPS ' + (pm.pumps.some(p => p.run) ? 'RUNNING' : 'STANDBY') + ' · ' + pm.P.toFixed(1) + ' bar · TANK ' + Math.round(pm.tank.pct * 100) + '%', 330, 246); }
  q.tex.needsUpdate = true;
}
function ctrlFrame() {
  if (!crm) return; const rk = L.rank;
  const col = rk >= 3 ? (Math.sin(T * 8) > 0 ? 0xff3b30 : 0x7a1717) : rk === 2 ? 0xff9f0a : rk === 1 ? 0xffc400 : 0x2e9d4f; crm.mons.forEach(m => m.color.setHex(col));
  const pm = L.pump, key = rk + '|' + IN.map(d => d.on ? 1 : 0).join('') + '|' + Object.keys(L.outState).join(',') + '|' + (pm ? pm.pumps.some(p => p.run) + ':' + Math.round(pm.P * 10) + ':' + Math.round(pm.tank.pct * 100) : '') + '|' + (cfgRef ? cfgRef.outputs.length : 0);
  if (key !== crm.key) { crm.key = key; drawCtrl(); }
}
export function focusControl() {
  const t1 = new Vector3(-13.6, 1.4, -8), off = new Vector3(.35, .45, .85).normalize().multiplyScalar(camera.aspect < .9 ? 24 : 13);
  floorCap = Math.max(floorCap, 0); tween = {u: 0, t0: controls.target.clone(), t1, p0: camera.position.clone(), p1: t1.clone().add(off)};
}

/* ---------------------------------------------------------------- building */
const CORE = [[-4, -8, .15, 6], [1, -8, .15, 6], [6, -8, .15, 6], [1, -5, 10, .15]];
const PART = [
  [...CORE, [8, -7, .15, 8], [9.5, -3, 3, .15], [14.5, -3, 3, .15], [16, -7, .15, 8], [10, 7.5, .15, 7], [14, 4, 8, .15]],
  [...CORE, [-12, 1, 12, .15], [-6, 6, .15, 10], [10, 1, 12, .15], [12, 6, .15, 10]],
  [...CORE, [-10, 0, 16, .15], [8, 0, 16, .15], [0, 6, .15, 12]]
];
function buildBuilding() {
  for (let i = 0; i < 4; i++) { const g = new Group(); g.position.y = i * FH; scene.add(g); floors.push(g); const d = new Group(); g.add(d); dynG.push(d); }
  floors.forEach((g, i) => {
    const s = box(W + .6, .3, D + .6, M.slab); s.position.y = -.15; g.add(s); outline(s, g);
    if (i < 3) {
      const sh = box(W, FH, D, M.glass); sh.position.y = FH / 2; g.add(sh); walls.push(sh); outline(sh, g).userData.keep = 1;
      PART[i].forEach(([x, z, w, d]) => { const p = box(w, FH - .1, d, i === 0 && z < -3 && x < 7 ? M.core : M.wall); p.position.set(x, FH / 2, z); g.add(p); walls.push(p); });
      for (let k = 0; k < 12; k++) { const st = box(2.4, .18, .42, M.grey); st.position.set(-2, k * FH / 12 + .09, -10.4 + k * .4); g.add(st); }
    }
  });
  // lift shaft + riser
  const sh = box(4.6, 3 * FH, 5, M.core); sh.position.set(3.5, 1.5 * FH, -8); scene.add(sh); outline(sh, scene); walls.push(sh);
  
  // roof parapet
  const par = box(W + .6, .5, D + .6, M.slab); par.position.y = .25; par.scale.set(1, 1, 1); floors[3].add(par); par.visible = false;
  const gr = new GridHelper(70, 35, 0x8a949e, 0xc3ccd5); gr.position.y = -.32; gr.material.transparent = true; gr.material.opacity = .5; scene.add(gr); scene.userData.grid = gr;
  // room / floor labels
  label('FM200 ROOM', 1.5, floors[0], 12, .35, -7);
  label('LOBBY', 1.5, floors[0], -11, .35, 5); buildControlRoom(); label('STAIR', 1.3, floors[0], -2, .35, -8.6); label('LIFT', 1.3, floors[0], 3.5, .35, -8);
  [['G', 0], ['L1', 1], ['L2', 2], ['ROOF', 3]].forEach(([t, i]) => label(t, 2.2, floors[i], -21, 1, 11.4));
}

/* ---------------------------------------------------------------- FACP + signal lamps */
function buildPanel() {
  const g = new Group(); g.position.set(-17.5, 0, -6.5); floors[0].add(g);
  const cab = box(.55, 1.8, 1.5, M.dgrey); cab.position.y = .9; g.add(cab); outline(cab, g);
  const cv = document.createElement('canvas'); cv.width = 320; cv.height = 190;
  const tex = new CanvasTexture(cv);
  const scr = new Mesh(new BoxGeometry(.02, .62, 1.05), new MeshBasicMaterial({map: tex})); scr.position.set(.29, 1.28, 0); g.add(scr);
  const leds = {}; [['pwr', 0x34c759], ['pre', 0xff9f0a], ['fire', 0xff3b30], ['sup', 0xffc400], ['sil', 0x4da3ff]].forEach(([k, c], i) => {
    const m = sph(.045, new MeshStandardMaterial({color: 0x333a42, emissive: 0, roughness: .4})); m.position.set(.3, .78, -.5 + i * .25); g.add(m); leds[k] = {m, c};
  });
  facp = {g, cv, tex, leds, key: ''}; drawPanel(true);
  g.rotation.y = 0;
}
function drawPanel(force) {
  const f = facp, s = L.scr, key = s.h + '|' + s.c + '|' + s.l.join(',') + L.rank;
  if (!force && key === f.key) return; f.key = key;
  const x = f.cv.getContext('2d'), alarm = L.rank >= 3, pre = L.rank === 2, sup = L.rank === 1;
  x.fillStyle = alarm ? '#3a0f0f' : pre ? '#33240a' : sup ? '#2f2a0a' : '#0b1d12'; x.fillRect(0, 0, 320, 190);
  x.fillStyle = alarm ? '#ff7a70' : pre ? '#ffc266' : sup ? '#ffe066' : '#6be39a'; x.font = '700 30px monospace'; x.textBaseline = 'top';
  x.fillText((s.h || '').slice(0, 20), 12, 12); x.font = '16px monospace'; x.fillStyle = '#cfd6dd';
  x.fillText((s.c || '').slice(0, 34), 12, 56); s.l.slice(0, 5).forEach((t, i) => x.fillText(t.slice(0, 30), 12, 86 + i * 20));
  f.tex.needsUpdate = true;
}
function setLed(l, on, k = 2) { l.m.material.emissive.setHex(on ? l.c : 0x000000); l.m.material.emissiveIntensity = on ? k : 0; }

/* ---------------------------------------------------------------- inputs */
const SL = {
  smoke: [[-12, 3.75, 3], [-9, 7.75, -3], [6, 7.75, 7], [-6, 11.75, 4], [13, 11.75, 3], [-14, 3.75, -3], [0, 7.75, 3], [10, 7.75, -5]],
  heat: [[14, 11.75, -6], [-14, 7.75, 7], [0, 3.75, 8], [-12, 11.75, -4]],
  mcp: [[-17.8, 1.4, 4, Math.PI / 2], [-4.2, 5.4, -3.5, Math.PI / 2], [-4.2, 9.4, -3.5, Math.PI / 2], [17.8, 1.4, 6, -Math.PI / 2]],
  valve: [[SX + 1.15, 2.95, SZ + .95, 0]], flow: [[SX - 2.6, YC + .34, SZ + ZW, 0]],
  button: [[7.75, 1.4, -4.5, Math.PI / 2], [7.75, 1.4, -6, Math.PI / 2]],
  pump: [[SX + 8.4, 2.5, SZ + -1.6, Math.PI / 2], [SX + 8.4, 2.5, SZ - .6, Math.PI / 2], [SX + 8.4, 2.5, SZ + .4, Math.PI / 2], [SX + 8.4, 2.5, SZ + 1.4, Math.PI / 2]],
  fmSmoke: [[12, 3.75, -6.5], [10, 3.75, -9]], fmHeat: [[14, 3.75, -8.5], [14, 3.75, -5]]
};
const used = {};
function slot(name) { const a = SL[name], i = used[name] = (used[name] || 0) + 1; return a[(i - 1) % a.length]; }
function styleOf(g, p) {
  const t = (p.label || '') + ' ' + p.id;
  if (g.key === 'mcp' || /call point|mcp|break ?glass/i.test(g.name)) return 'mcp';
  if (g.key === 'pa' || /pre-?action/i.test(g.name)) return 'valve';
  if (g.key === 'pump' || /fire pump/i.test(g.name)) return 'pump';
  if (g.key === 'flow' || /flow/i.test(g.name)) return 'flow';
  if (/MDB|button|discharge|manual/i.test(t)) return 'button';
  if (/heat|FHD/i.test(t) || g.key === 'heat') return 'heat';
  return 'smoke';
}
function inShape(style) {
  const g = new Group(), led = sph(.075, ledMat());
  if (style === 'smoke' || style === 'heat') {
    const b = cyl(.3, .07, M.white, 22); b.position.y = -.035; g.add(b);
    const d = new Mesh(new SphereGeometry(.2, 16, 8, 0, TAU, 0, Math.PI / 2), style === 'heat' ? M.orange : M.white); d.rotation.x = Math.PI; d.position.y = -.07; g.add(d);
    led.position.set(.2, -.09, 0);
  } else if (style === 'mcp') {
    const b = box(.36, .36, .12, M.red); g.add(b); const gl = box(.2, .2, .03, M.white); gl.position.z = .075; g.add(gl); led.position.set(.12, .22, .07);
  } else if (style === 'button') {
    const b = box(.3, .3, .1, M.yellow); g.add(b); const c = cyl(.08, .06, M.red, 16); c.rotation.x = Math.PI / 2; c.position.z = .07; g.add(c); led.position.set(.1, .2, .06);
  } else if (style === 'valve') {
    const b = cyl(.15, .5, M.dgrey, 16); g.add(b); const cp = cyl(.17, .06, M.grey, 16); cp.position.y = .28; g.add(cp);
    const bs = box(.34, .14, .3, M.dgrey); bs.position.y = -.3; g.add(bs); led.position.set(0, .38, 0);
  } else if (style === 'pump') {
    const b = box(.5, .36, .12, M.dgrey); g.add(b); const pl = box(.36, .12, .02, M.white); pl.position.set(0, -.08, .07); g.add(pl); led.position.set(.14, .1, .07);
  } else if (style === 'flow') {
    const sd = cyl(.13, .08, M.grey, 14); sd.position.y = -.14; g.add(sd); const b = box(.36, .26, .3, M.red); g.add(b);
    const dm = new Mesh(new SphereGeometry(.15, 14, 8, 0, TAU, 0, Math.PI / 2), M.red); dm.position.y = .13; g.add(dm); led.position.set(.2, .02, .16);
  } else { g.add(box(.3, .3, .3, M.grey)); led.position.y = .2; }
  g.add(led); return {g, led};
}
const extraPk = [];
function buildInputs(C) {
  Object.keys(used).forEach(k => used[k] = 0);
  C.inputs.forEach(grp => grp.points.forEach(p => {
    const style = styleOf(grp, p), fm = /fm ?200/i.test(grp.key + grp.name);
    const sl = fm && style === 'smoke' ? slot('fmSmoke') : fm && style === 'heat' ? slot('fmHeat') : slot(style);
    const {g, led} = inShape(style), h = halo(style === 'valve' ? 2.4 : 2.2); g.add(h);
    put(g, sl[0], sl[1], sl[2], sl[3] || 0, style === 'valve' ? 1.3 : style === 'flow' ? 1.5 : style === 'pump' ? 1.5 : 1.9);
    const pm = new MeshBasicMaterial({transparent: true, opacity: 0, depthWrite: false});
    const pk = style === 'valve' ? new Mesh(new SphereGeometry(1.3, 10, 8), pm) : new Mesh(new SphereGeometry(.55, 8, 6), pm);
    if (style === 'valve') pk.position.set(-.58, -1.12, -.77);
    g.add(pk);
    if (style === 'flow') { const pk2 = new Mesh(new SphereGeometry(1.15, 10, 8), pm); pk2.position.set(1.73, -1.79, 0); g.add(pk2); pk2.userData.dev = null; extraPk.push(pk2); }
    const dev = {kind: 'in', id: p.id, key: grp.key, style, led, h, g, acc: 0, wpos: new Vector3(), on: false};
    pk.userData.dev = dev; pickables.push(pk); IN.push(dev);
    while (extraPk.length) { const e = extraPk.pop(); e.userData.dev = dev; pickables.push(e); }
  }));
}

/* ---------------------------------------------------------------- outputs */
const SLOT_BELL = [[-17.7, 3.1, -1, Math.PI / 2], [-4.2, 7.1, 4, Math.PI / 2], [17.7, 11.1, 2, -Math.PI / 2], [5, 7.1, 10.8, Math.PI]];
const SLOT_SPK = [[-17.7, 3.0, 2.5, Math.PI / 2], [12.5, 3.0, 10.8, Math.PI], [-4.2, 7.0, 7, Math.PI / 2], [17.7, 7.0, -4, -Math.PI / 2], [-17.7, 11.0, 5, Math.PI / 2], [17.7, 11.0, -4, -Math.PI / 2]];
const SLOT_STR = [[-17.7, 2.7, 5.5, Math.PI / 2], [-4.2, 6.7, -1, Math.PI / 2], [-4.2, 10.7, -1, Math.PI / 2], [17.7, 2.7, 8, -Math.PI / 2], [8.3, 6.7, 10.8, Math.PI]];
const SLOT_GEN = [[0, 12.35, 4], [4, 12.35, 6], [-6, 12.35, 0], [10, 12.35, 0], [14, 12.35, 6]];
const cnt = {};
const nth = (k, a, n = 1) => { const i = cnt[k] = (cnt[k] || 0); cnt[k] += n; return a.slice(i % a.length).concat(a).slice(0, n); };

function fanShape(r, m) {
  const g = new Group(), h = cyl(r, .45, M.dgrey, 24); h.material = std(0x56616c, {side: DoubleSide}); g.add(h);
  const bl = new Group(); for (let i = 0; i < 5; i++) { const b = box(r * .9, .04, .16, m || M.white); b.position.x = r * .45; const w = new Group(); w.rotation.y = i * TAU / 5; w.add(b); b.rotation.x = .35; bl.add(w); }
  bl.position.y = .05; g.add(bl); return {g, bl};
}
function mkOut(o, C) {
  const k = o.key, kind = o.kind;
  const type = {bell: 'bell', speaker: 'speaker', strobe: 'strobe', shutter: 'shutter', lift: 'lift', door: 'door', ahu: 'ahu', spill: 'spill', press: 'press', release: 'release', lamp: 'lamp'}[k]
    || ({audible: 'bell', voice: 'speaker', av: 'strobe', visual: 'lamp', signal: 'signal'}[kind]) || 'generic';
  const devs = [], mk = (u, extra = {}) => { const d = {kind: 'out', key: k, upd: u, ...extra}; devs.push(d); OUT.push(d); return d; };
  const sig = s => ({st: L.outState[k] || '', on: !!L.outState[k], sil: L.sil, col: COL[L.outState[k]] || COL.fire, ...s});
  const addPick = (obj, d, r = .9) => { const pk = new Mesh(new SphereGeometry(r, 8, 6), new MeshBasicMaterial({transparent: true, opacity: 0, depthWrite: false})); pk.userData.dev = d; obj.add(pk); pickables.push(pk); if (!d.g) d.g = obj; };
  if (type === 'bell') {
    nth('bell', SLOT_BELL, 3).forEach(sl => {
      const g = new Group(), dome = new Mesh(new SphereGeometry(.3, 16, 10, 0, TAU, 0, Math.PI / 2), M.gold); dome.rotation.x = Math.PI / 2; g.add(dome);
      const base = cyl(.33, .05, M.dgrey, 18); base.rotation.x = Math.PI / 2; base.position.z = -.02; g.add(base); const cl = sph(.06, M.dgrey); cl.position.z = .22; dome.add(cl);
      put(g, sl[0], sl[1], sl[2], sl[3], 1.8); const h = halo(1.8); g.add(h);
      const d = mk((dt, t) => { const s = sig(), ring = s.on && !s.sil; dome.rotation.z = ring ? Math.sin(t * 38) * .22 : 0; h.material.opacity = ring ? .35 + .2 * Math.sin(t * 19) : 0; h.material.color.setHex(s.col); });
      addPick(g, d);
    });
  } else if (type === 'speaker') {
    nth('spk', SLOT_SPK, 4).forEach(sl => {
      const g = new Group(), b = box(.4, .34, .2, M.grey); g.add(b); const c = new Mesh(new ConeGeometry(.2, .3, 18, 1, true), std(0xdfe3e7, {side: DoubleSide})); c.rotation.x = Math.PI / 2; c.position.z = .22; g.add(c);
      const rings = [0, 1, 2].map(i => { const r = new Mesh(new TorusGeometry(.4, .018, 6, 28), new MeshBasicMaterial({color: 0x4da3ff, transparent: true, opacity: 0})); g.add(r); return r; });
      put(g, sl[0], sl[1], sl[2], sl[3], 1.8);
      const d = mk((dt, t) => { const s = sig(), on = s.on && !s.sil; rings.forEach((r, i) => { const u = ((t * .9 + i / 3) % 1); r.position.z = .4 + u * 1.4; r.scale.setScalar(.7 + u * 1.5); r.material.opacity = on ? (1 - u) * .8 : 0; r.material.color.setHex(s.col === COL.fire ? 0x4da3ff : s.col); }); });
      addPick(g, d);
    });
  } else if (type === 'strobe') {
    nth('str', SLOT_STR, 4).forEach(sl => {
      const g = new Group(), b = box(.34, .24, .14, M.white); g.add(b); const lens = box(.22, .13, .05, new MeshStandardMaterial({color: 0xd33, emissive: 0, roughness: .3})); lens.position.z = .09; g.add(lens);
      const hn = cyl(.07, .1, M.dgrey, 12); hn.rotation.x = Math.PI / 2; hn.position.set(.12, -.17, .06); g.add(hn); put(g, sl[0], sl[1], sl[2], sl[3], 1.8); const h = halo(3.2); g.add(h);
      const d = mk((dt, t) => { const s = sig(), f = s.on && Math.sin(t * 12) > 0; lens.material.emissive.setHex(f ? 0xffffff : 0); lens.material.emissiveIntensity = f ? 2 : 0; h.material.opacity = f ? .75 : 0; h.material.color.setHex(0xffffff); });
      addPick(g, d);
    });
  } else if (type === 'shutter') {
    const g = new Group(), hs = box(.45, .5, 6, M.dgrey); hs.position.y = 3.55; g.add(hs);
    const c = document.createElement('canvas'); c.width = 8; c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#b9c1c9'; x.fillRect(0, 0, 8, 64); x.fillStyle = '#8c969f'; for (let i = 0; i < 64; i += 8) x.fillRect(0, i, 8, 2);
    const tx = new CanvasTexture(c); tx.wrapS = tx.wrapT = RepeatWrapping; tx.repeat.set(1, 14);
    const cur = new Mesh(new BoxGeometry(.1, 3.3, 5.6), new MeshStandardMaterial({map: tx, roughness: .6})); g.add(cur); cur.scale.y = .05; cur.position.y = 3.3 - 1.65 * .05;
    const h = halo(3); h.position.y = 2; g.add(h); put(g, 17.7, 0, .5);
    const d = mk(dt => { const s = sig(); cur.scale.y = approach(cur.scale.y, s.on ? 1 : .05, .45, dt); cur.position.y = 3.3 - 1.65 * cur.scale.y; h.material.opacity = s.on ? .35 : 0; h.material.color.setHex(s.col); });
    addPick(hs, d, 2.2);
  } else if (type === 'lift') {
    lift = lift || (() => {
      const car = new Group(), b = box(2.2, 2.8, 2.2, std(0x35c2b0, {transparent: true, opacity: .35, depthWrite: false})); b.position.y = 1.45; car.add(b); outline(b, car);
      const lamp = sph(.12, new MeshStandardMaterial({color: 0x335544, emissive: 0, roughness: .4})); lamp.position.set(0, 2.95, 1.1); car.add(lamp);
      car.position.set(3.5, 8, -8); scene.add(car); return {car, lamp, tgt: 8, wait: 2, i: 2};
    })();
    const h = halo(3); lift.car.add(h); h.position.y = 1.5;
    const d = mk((dt, t) => {
      const s = sig(), P = [0, 4, 8];
      if (s.on) lift.tgt = 0; else { lift.wait -= dt; if (lift.wait <= 0 && Math.abs(lift.car.position.y - lift.tgt) < .05) { lift.i = (lift.i + 1) % 3; lift.tgt = P[lift.i]; lift.wait = 3; } }
      lift.car.position.y = approach(lift.car.position.y, lift.tgt, 3.2, dt);
      lift.lamp.material.emissive.setHex(s.on ? 0x34c759 : 0); lift.lamp.material.emissiveIntensity = s.on ? 2.5 : 0; h.material.opacity = s.on ? .4 : 0; h.material.color.setHex(0x34c759);
    });
    addPick(lift.car, d, 2.2);
  } else if (type === 'door') {
    const g = new Group(), fr = box(.12, 2.5, 1.5, M.dgrey); fr.position.set(0, 1.25, .75); g.add(fr);
    const piv = new Group(); piv.position.set(.07, 0, 0); g.add(piv); const leaf = box(.08, 2.3, 1.32, std(0x6f8a5a)); leaf.position.set(0, 1.2, .68); piv.add(leaf);
    const sign = box(.06, .26, .7, new MeshStandardMaterial({color: 0x1d6b3a, emissive: 0x1d6b3a, emissiveIntensity: .6})); sign.position.set(.05, 2.75, .75); g.add(sign);
    const lock = sph(.07, new MeshStandardMaterial({color: 0xff3b30, emissive: 0xff3b30, emissiveIntensity: 1.2})); lock.position.set(.12, 1.1, 1.38); g.add(lock);
    const h = halo(3); h.position.set(.2, 1.5, .8); g.add(h); put(g, -17.95, 0, 7.2);
    const d = mk(dt => { const s = sig(); piv.rotation.y = approach(piv.rotation.y, s.on ? -1.75 : 0, 2.2, dt); lock.material.color.setHex(s.on ? 0x34c759 : 0xff3b30); lock.material.emissive.setHex(s.on ? 0x34c759 : 0xff3b30); sign.material.emissiveIntensity = s.on ? 2.2 : .6; h.material.opacity = s.on ? .4 : 0; h.material.color.setHex(0x34c759); });
    addPick(g, d, 1.8);
  } else if (type === 'ahu') {
    const g = new Group(), b = box(2.6, 1.3, 1.8, M.grey); b.position.y = .65; g.add(b); outline(b, g);
    const f = fanShape(.55); f.g.position.set(0, 1.5, 0); g.add(f.g); const lamp = sph(.1, new MeshStandardMaterial({color: 0x335544, emissive: 0x34c759, emissiveIntensity: 1.6})); lamp.position.set(1.05, 1.1, .92); g.add(lamp); label('AHU', .55, g, 0, 2.6, 0);
    const h = halo(3.4); h.position.y = 1.4; g.add(h); put(g, -12, 12, 6); let w = 5;
    const d = mk((dt, t) => { const s = sig(); w = approach(w, s.on ? 0 : 5, 3, dt); f.bl.rotation.y += w * dt; lamp.material.emissive.setHex(s.on ? 0xff3b30 : 0x34c759); h.material.opacity = s.on ? .4 : 0; h.material.color.setHex(0xff3b30); });
    addPick(g, d, 1.8);
  } else if (type === 'spill' || type === 'press') {
    const sp = type === 'spill', g = new Group(), f = fanShape(.85, M.orange); g.add(f.g); const h = halo(3.2); h.position.y = .5; g.add(h);
    label(sp ? 'SMOKE SPILL FAN' : 'PRESSURISE FAN', .5, g, 0, 1.6, 0).scale.set(2.8, .7, 1);
    put(g, sp ? 8 : -2, 12.25, sp ? -6 : -8); let w = 0, acc = 0;
    const d = mk((dt, t) => { const s = sig(); w = approach(w, s.on ? 13 : 0, 6, dt); f.bl.rotation.y += w * dt; h.material.opacity = s.on ? .3 : 0; h.material.color.setHex(0x4da3ff); if (s.on) { acc += dt * 14; while (acc >= 1) { acc--; const p = g.getWorldPosition(new Vector3()); emit(sp ? 'airUp' : 'airDn', p.x + (Math.random() - .5) * 1, p.y, p.z + (Math.random() - .5) * 1); } } });
    addPick(g, d, 1.6);
  } else if (type === 'release') {
    const g = new Group();
    [0, 1].forEach(i => { const c = cyl(.34, 1.7, M.red, 18); c.position.set(i * .9, .85, 0); g.add(c); const v = cyl(.1, .22, M.gold, 10); v.position.set(i * .9, 1.8, 0); g.add(v); });
    const mf = cyl(.06, .9, M.gold, 8); mf.rotation.z = Math.PI / 2; mf.position.set(.45, 2, 0); g.add(mf);
    const h = halo(3); h.position.set(.45, 1, 0); g.add(h); put(g, 10, 0, -9.7); label('FM200', .5, g, .45, 2.6, 0);
    if (!gasBox) { gasBox = box(7.7, 3.7, 7.7, new MeshBasicMaterial({color: 0x9fe8ff, transparent: true, opacity: 0, depthWrite: false})); gasBox.position.set(12, 1.85, -7); floors[0].add(gasBox); }
    let acc = 0;
    const d = mk((dt) => { const s = sig(); h.material.opacity = s.on ? .45 : 0; h.material.color.setHex(0x9fe8ff); gasBox.material.opacity = approach(gasBox.material.opacity, s.on ? .13 : 0, .05, dt);
      if (s.on) { acc += dt * 45; while (acc >= 1) { acc--; emit('gas', 8.6 + Math.random() * 6.8, .3 + Math.random() * 3.2, -10.4 + Math.random() * 6.8); } } });
    addPick(g, d, 1.5);
  } else if (type === 'lamp') {
    const c = document.createElement('canvas'); c.width = 256; c.height = 96; const g2 = c.getContext('2d');
    const draw = on => { g2.fillStyle = on ? '#ffb020' : '#3b2a10'; g2.fillRect(0, 0, 256, 96); g2.fillStyle = on ? '#2a1600' : '#7a5a25'; g2.font = '700 30px Arial'; g2.textAlign = 'center'; g2.fillText('GAS', 128, 40); g2.font = '700 26px Arial'; g2.fillText('DISCHARGED', 128, 74); tx.needsUpdate = true; };
    const tx = new CanvasTexture(c); draw(false);
    const g = new Group(), sg = box(1.1, .42, .1, new MeshStandardMaterial({map: tx, roughness: .5})); g.add(sg); const h = halo(3.2); g.add(h); put(g, 12, 3, -2.8);
    let was = false;
    const d = mk(() => { const s = sig(); if (s.on !== was) { was = s.on; draw(s.on); } h.material.opacity = s.on ? .55 : 0; h.material.color.setHex(0xffb020); });
    addPick(g, d, 1.2);
  } else if (type === 'signal') {
    const i = nth('sig', [0, 1, 2, 3])[0], g = new Group(), b = box(.7, 1.7, .5, M.dgrey); b.position.y = .85; g.add(b); outline(b, g);
    const l = sph(.09, ledMat()); l.position.set(0, 1.42, .27); g.add(l);
    [0, 1, 2].forEach(r => [-.2, 0, .2].forEach(c => { const d2 = sph(.025, M.grey); d2.position.set(c, 1.0 - r * .13, .26); g.add(d2); }));
    const pl = box(.5, .2, .02, M.white); pl.position.set(0, .45, .26); g.add(pl);
    label(/iboss/i.test(k + o.name) ? 'SPKA' : k.toUpperCase().slice(0, 8), .42, g, 0, 2.15, 0); g.position.set(-17.45, 0, -10.3 + i * .85); g.rotation.y = Math.PI / 2; dynG[0].add(g);
    const d = mk(() => { const s = sig(); l.material.emissive.setHex(s.on ? s.col : 0); l.material.emissiveIntensity = s.on ? 2.2 : 0; });
    addPick(g, d, 1.0);
  } else {
    const sl = nth('gen', SLOT_GEN)[0], g = new Group(), b = box(.7, .5, .7, M.grey); g.add(b); const l = sph(.1, ledMat()); l.position.set(0, .35, 0); g.add(l);
    label(o.name.split(/[ (]/)[0].slice(0, 12), .5, g, 0, 1, 0); put(g, sl[0], sl[1], sl[2]); const h = halo(2.4); g.add(h);
    const d = mk(() => { const s = sig(); l.material.emissive.setHex(s.on ? s.col : 0); l.material.emissiveIntensity = s.on ? 2.2 : 0; h.material.opacity = s.on ? .4 : 0; h.material.color.setHex(s.col); });
    addPick(g, d, 1);
  }
  devs.forEach(d => { d.name = o.name; });
}

/* ---------------------------------------------------------------- particles */
const N = 1300; let PI = 0, pts, PA;
function buildParticles() {
  const g = new BufferGeometry();
  PA = {pos: new Float32Array(N * 3), col: new Float32Array(N * 3), a: new Float32Array(N), s: new Float32Array(N), vel: new Float32Array(N * 3), age: new Float32Array(N), max: new Float32Array(N).fill(1), s0: new Float32Array(N), s1: new Float32Array(N), a0: new Float32Array(N), ty: new Uint8Array(N), top: new Float32Array(N), bot: new Float32Array(N)};
  PA.age.fill(9);
  g.setAttribute('position', new BufferAttribute(PA.pos, 3)); g.setAttribute('col', new BufferAttribute(PA.col, 3)); g.setAttribute('alpha', new BufferAttribute(PA.a, 1)); g.setAttribute('size', new BufferAttribute(PA.s, 1));
  const m = new ShaderMaterial({transparent: true, depthWrite: false, uniforms: {map: {value: DOT}, scale: {value: 600}},
    vertexShader: 'attribute float size;attribute float alpha;attribute vec3 col;varying float vA;varying vec3 vC;uniform float scale;void main(){vA=alpha;vC=col;vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=size*scale/-mv.z;gl_Position=projectionMatrix*mv;}',
    fragmentShader: 'uniform sampler2D map;varying float vA;varying vec3 vC;void main(){float a=texture2D(map,gl_PointCoord).a*vA;if(a<.01)discard;gl_FragColor=vec4(vC,a);}'});
  pts = new Points(g, m); pts.frustumCulled = false; pts.renderOrder = 8; scene.add(pts);
}
const PT = {
  smoke: {c: [.52, .52, .55], life: [5, 8], s: [.35, 1.7], a: .34, v: [.35, .6]},
  heat: {c: [1, .55, .15], life: [1.6, 2.6], s: [.25, .9], a: .5, v: [.6, 1]},
  water: {c: [.45, .72, 1], life: [.8, 1.3], s: [.12, .2], a: .8, v: [0, 0]},
  gas: {c: [.7, .93, 1], life: [4, 6], s: [.9, 1.6], a: .22, v: [0, .1]},
  airUp: {c: [.6, .78, .95], life: [1.4, 2], s: [.2, .4], a: .35, v: [2, 3]},
  airDn: {c: [.6, .78, .95], life: [1.4, 2], s: [.2, .4], a: .35, v: [-3, -4]},
  spray: {c: [.55, .78, 1], life: [.7, 1.1], s: [.2, .34], a: .9, v: [0, 0]}
};
function emit(type, x, y, z) {
  const T0 = PT[type], i = PI = (PI + 1) % N, r = Math.random, v = lerp(T0.v[0], T0.v[1], r());
  PA.pos.set([x, y, z], i * 3); PA.col.set(T0.c, i * 3); PA.age[i] = 0; PA.max[i] = lerp(T0.life[0], T0.life[1], r());
  PA.s0[i] = T0.s[0]; PA.s1[i] = T0.s[1]; PA.a0[i] = T0.a; PA.ty[i] = type === 'smoke' ? 1 : (type === 'water' || type === 'spray') ? 2 : type === 'gas' ? 3 : 0;
  let vx = 0, vy = v, vz = 0;
  if (type === 'smoke') { vx = (r() - .5) * .3; vz = (r() - .5) * .3; }
  if (type === 'water') { vx = (r() - .5) * 1.4; vz = (r() - .5) * 1.4; vy = -.3 - r() * .8; }
  if (type === 'spray') { const an = r() * TAU, sp = 1.4 + r() * 1.8; vx = Math.cos(an) * sp; vz = Math.sin(an) * sp; vy = -.2 - r() * 1.1; }
  if (type === 'gas') { vx = (r() - .5) * .5; vy = (r() - .5) * .2; vz = (r() - .5) * .5; }
  if (type === 'heat') { vx = (r() - .5) * .4; vz = (r() - .5) * .4; }
  PA.vel.set([vx, vy, vz], i * 3);
  const fi = floorOf(y); PA.top[i] = (fi + 1) * FH - .25; PA.bot[i] = fi * FH + .05;
}
function tickParticles(dt) {
  for (let i = 0; i < N; i++) {
    if (PA.age[i] >= PA.max[i]) { PA.a[i] = 0; PA.s[i] = 0; continue; }
    PA.age[i] += dt; const u = PA.age[i] / PA.max[i], k = i * 3, ty = PA.ty[i];
    if (ty === 2) PA.vel[k + 1] -= 9 * dt;
    PA.pos[k] += PA.vel[k] * dt; PA.pos[k + 1] += PA.vel[k + 1] * dt; PA.pos[k + 2] += PA.vel[k + 2] * dt;
    if (ty === 1 && PA.pos[k + 1] > PA.top[i]) { PA.pos[k + 1] = PA.top[i]; PA.vel[k + 1] = 0; PA.vel[k] += (Math.random() - .5) * .5 * dt * 6; PA.vel[k + 2] += (Math.random() - .5) * .5 * dt * 6; }
    if (ty === 2 && PA.pos[k + 1] < PA.bot[i]) PA.age[i] = PA.max[i];
    PA.a[i] = PA.a0[i] * Math.sin(Math.PI * clamp(u, 0, 1)); PA.s[i] = lerp(PA.s0[i], PA.s1[i], u);
  }
  const g = pts.geometry; g.attributes.position.needsUpdate = g.attributes.alpha.needsUpdate = g.attributes.size.needsUpdate = g.attributes.col.needsUpdate = true;
}

/* ---------------------------------------------------------------- build / rebuild from config */
/* ---------------------------------------------------------------- outdoor pre-action valve station + sprinkler network */
const HEADS = [], DRY = new Color(0x7a1717), WET = new Color(0x4fa0ff), UPV = new Vector3(0, 1, 0);
let stn = null, wet = 0, airF = .6;
function pipe(par, a, b, r, m) {
  const A = new Vector3(a[0], a[1], a[2]), B = new Vector3(b[0], b[1], b[2]), len = A.distanceTo(B); if (len < 1e-4) return;
  const c = new Mesh(new CylinderGeometry(r, r, len, 10), m);
  c.position.copy(A).add(B).multiplyScalar(.5); c.quaternion.setFromUnitVectors(UPV, B.clone().sub(A).normalize()); par.add(c);
}
function run(par, p, r, m) {
  for (let i = 0; i < p.length - 1; i++) pipe(par, p[i], p[i + 1], r, m);
  for (let i = 1; i < p.length - 1; i++) { const j = new Mesh(new SphereGeometry(r * 1.15, 10, 8), m); j.position.set(p[i][0], p[i][1], p[i][2]); par.add(j); }
}
const runF = (fi, p, r, m) => run(dynG[fi], p.map(q => [q[0], q[1] - fi * FH, q[2]]), r, m);
function ball(par, x, y, z) {
  const b = sph(.085, M.gold); b.position.set(x, y, z); par.add(b);
  const h = box(.3, .035, .045, M.yellow); h.position.set(x, y + .12, z); par.add(h);
}
function gaugeTex(txt) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  x.fillStyle = '#f4f5f6'; x.beginPath(); x.arc(64, 64, 62, 0, TAU); x.fill();
  x.strokeStyle = '#222'; x.lineWidth = 3; x.beginPath(); x.arc(64, 64, 60, 0, TAU); x.stroke();
  for (let i = 0; i <= 10; i++) {
    const a = (135 + i * 27) * Math.PI / 180, r1 = i % 5 ? 50 : 44; x.lineWidth = i % 5 ? 2 : 3;
    x.beginPath(); x.moveTo(64 + Math.cos(a) * r1, 64 + Math.sin(a) * r1); x.lineTo(64 + Math.cos(a) * 56, 64 + Math.sin(a) * 56); x.stroke();
  }
  x.fillStyle = '#222'; x.font = 'bold 20px Arial'; x.textAlign = 'center'; x.fillText(txt, 64, 98);
  return new CanvasTexture(c);
}
function mkGauge(txt) {
  const g = new Group(), rim = cyl(.18, .07, M.dgrey, 20); rim.rotation.z = Math.PI / 2; g.add(rim);
  const face = new Mesh(new CircleGeometry(.155, 28), new MeshBasicMaterial({map: gaugeTex(txt)})); face.rotation.y = Math.PI / 2; face.position.x = .037; g.add(face);
  const piv = new Group(); piv.position.x = .045; const nd = box(.008, .13, .008, new MeshBasicMaterial({color: 0xd32f2f})); nd.position.y = .055; piv.add(nd); g.add(piv);
  return {g, piv};
}
const PR_ = [.22, .38, .38], PNAME = ['Jockey pump', 'Electric pump (duty)', 'Diesel pump (standby)'];
function pumpTip(i) {
  const q = L.pump; if (!q) return '<b>' + PNAME[i] + '</b>'; const p = q.pumps[i];
  const t = !p.power ? 'NO POWER' : p.fault ? 'START CALL NOT ANSWERED' : p.run ? 'RUNNING' : p.mode === 'OFF' ? 'SELECTOR OFF' : 'Standby';
  return '<b>' + PNAME[i] + '</b> · ' + t + '<br>Selector ' + p.mode + ' · system ' + q.P.toFixed(1) + ' bar<br>Open the Fire pump page to operate it';
}
function tankTip() { const q = L.pump; return '<b>Fire water tank</b><br>' + (q ? Math.round(q.tank.pct * 100) + '% · ' + Math.round(q.tank.litres).toLocaleString('en-US') + ' L' + (q.tank.empty ? ' · EMPTY' : q.tank.low ? ' · LOW' : '') : 'full'); }
function pumpFrame(dt) {
  const q = L.pump, k = stn.pk, gr = f => (135 - f * 270) * Math.PI / 180, P_ = q ? q.P : 8.6, fr = clamp(P_ * 14.5038 / 250, 0, 1);
  stn.watN.rotation.x = stn.supN.rotation.x = stn.sysN.rotation.x = stn.dgN.rotation.x = gr(fr);
  let sum = 0;
  k.pumps.forEach((p, i) => {
    const pi = q ? q.pumps[i] : {speed: 0, run: false, power: true, fault: false, mode: 'AUTO'}, sp = pi.speed; sum += sp;
    p.spin.rotation.x += sp * 22 * dt; p.g.position.y = sp > .05 ? Math.sin(T * 70) * .004 * sp : 0;
    p.mat.emissive.setHex(PCOL[i]); p.mat.emissiveIntensity = .35 * sp;
    const c = k.cab[i], on = [pi.power, pi.power && pi.run, pi.power && pi.fault && Math.sin(T * 9) > 0];
    c.lamps.forEach((l, j) => { l.m.emissive.setHex(on[j] ? l.c : 0); l.m.emissiveIntensity = on[j] ? 2.2 : 0; });
    c.kn.rotation.z = -(({OFF: -62, AUTO: 0, MANUAL: 62})[pi.mode] || 0) * Math.PI / 180;
  });
  M.pipeP.emissive.setHex(0x1565ff); M.pipeP.emissiveIntensity = (P_ > 1 ? .1 : 0) + .4 * clamp(sum, 0, 1);
  const pct = q ? q.tank.pct : 1; k.water.scale.y = Math.max(.003, pct); k.lvl.scale.y = Math.max(.003, pct);
  M.water.color.setHex(pct < .2 ? 0xd9822b : 0x2f8fd8);
  const rp = Math.round(pct * 100); if (rp !== k.lastPct) { k.lastPct = rp; k.tl.userData.draw(rp + '%'); }
}
function buildStation() {
  HEADS.length = 0; wet = 0; airF = .6;
  for (let i = walls.length - 1; i >= 0; i--) if (walls[i].userData.pump) walls.splice(i, 1);
  const st = new Group(); st.position.set(SX, 0, SZ); dynG[0].add(st);
  const R = M.red, P = M.pipe, D = M.pipeD;
  const add = (o, x, y, z) => { o.position.set(x, y, z); st.add(o); return o; };
  const ax = o => { o.rotation.z = Math.PI / 2; return o; };
  outline(add(box(9.4, .3, 10.8, M.conc), 1.2, -.15, .1), st);
  // water supply from outside, gate valve, strainer
  run(st, [[9.6, .95, 0], [8.2, .95, 0], [8.2, .4, 0], [7.4, .4, 0], [0, .4, 0], [0, 2.0, 0]], .2, M.pipeP);
  label('FROM FIRE PUMPS', .55, st, 6.1, 1.2, 0);
  add(ax(cyl(.27, .5, M.dgrey, 16)), 2.6, .4, 0); add(cyl(.16, .35, M.dgrey, 12), 2.6, .72, 0); add(cyl(.03, .55, M.grey, 8), 2.6, 1.1, 0);
  const wh = add(new Mesh(new TorusGeometry(.25, .035, 8, 24), M.black), 2.6, 1.38, 0); wh.rotation.x = Math.PI / 2;
  add(box(.5, .02, .035, M.black), 2.6, 1.38, 0); add(box(.035, .02, .5, M.black), 2.6, 1.38, 0);
  add(cyl(.2, .7, M.black, 16), 4.7, .85, 0); add(cyl(.22, .06, M.dgrey, 16), 4.7, 1.22, 0);
  // pre-action valve: body, flanges, diaphragm dome, system-side body
  add(cyl(.34, 1.1, R, 24), 0, 1.25, 0); [.72, 1.78].forEach(y => add(cyl(.43, .1, R, 24), 0, y, 0));
  add(ax(cyl(.62, .55, R, 28)), .5, 1.0, 0); add(ax(cyl(.4, .1, M.red2, 24)), .85, 1.0, 0); add(ax(cyl(.08, .12, M.dgrey, 10)), .95, 1.0, 0);
  add(cyl(.3, .7, R, 24), 0, 2.2, 0); [1.88, 2.55].forEach(y => add(cyl(.38, .08, R, 24), 0, y, 0));
  pipe(st, [0, 2.0, 0], [0, YC, 0], .2, D); add(new Mesh(new SphereGeometry(.23, 12, 10), D), 0, YC, 0);
  // trim: water side, drain funnel, release box
  run(st, [[0, .95, -.34], [0, .95, -.9], [.9, .95, -.9], [.9, 1.9, -.9]], .045, P); ball(st, 0, .95, -.62); ball(st, .6, .95, -.9);
  pipe(st, [.3, .95, -.9], [.3, .65, -.9], .045, P);
  const fn = add(new Mesh(new ConeGeometry(.22, .3, 16, 1, true), std(0xd32f2f, {side: DoubleSide})), .3, .5, -.9); fn.rotation.x = Math.PI;
  const rb = new Group(); add(rb, .9, 2.2, -.9); rb.add(box(.34, .5, .26, R)); const lb = box(.01, .3, .18, M.white); lb.position.x = .175; rb.add(lb);
  const rh = halo(2.6); rb.add(rh);
  // gauges
  const wg = mkGauge('WATER'), ag = mkGauge('AIR');
  run(st, [[.25, .95, .3], [.25, .95, .8], [.95, .95, .8]], .04, P); ball(st, .6, .95, .8); add(wg.g, 1.0, .95, .8);
  run(st, [[.2, 2.3, .25], [.9, 2.3, .25]], .04, D); ball(st, .55, 2.3, .25); add(ag.g, .95, 2.3, .25);
  run(st, [[.55, 2.3, .25], [.55, 2.3, .95], [1.15, 2.3, .95], [1.15, 2.65, .95]], .04, D);
  // air compressor feeding the system-side trim
  const tank = add(ax(cyl(.42, 1.7, std(0x2f7fe0), 24)), .5, .8, 3.2);
  [-.35, 1.35].forEach(x => { const c = sph(.42, tank.material); c.scale.set(.45, 1, 1); add(c, x, .8, 3.2); });
  [[-.15, 2.9], [-.15, 3.5], [1.15, 2.9], [1.15, 3.5]].forEach(([x, z]) => add(box(.09, .4, .09, M.blue2), x, .2, z));
  add(box(.5, .18, .4, M.dgrey), .1, 1.3, 3.2); add(box(.62, .36, .5, tank.material), .1, 1.58, 3.2);
  add(box(.7, .16, .4, M.dgrey), 1.05, 1.3, 3.2); add(ax(cyl(.22, .55, M.dgrey, 16)), 1.05, 1.6, 3.2);
  const fw = new Group(); fw.add(ax(cyl(.25, .05, M.black, 20))); fw.add(box(.05, .42, .05, M.grey)); add(fw, .62, 1.6, 3.2);
  run(st, [[.1, 1.1, 2.9], [.1, 2.3, 2.9], [.1, 2.3, .25]], .04, P); ball(st, .1, 1.8, 2.9);
  label('AIR COMPRESSOR', .5, st, .5, 2.3, 3.2);
  // connection into the building: through the wall, then risers, mains, branches and heads on each floor
  add(ax(cyl(.28, .3, M.dgrey, 20)), -5.5, YC, 0);
  run(st, [[0, YC, 0], [-7, YC, 0]], .14, D);
  label('TO PRE-ACTION SPRINKLERS', .65, st, -3.2, YC + 1.0, 0);
  label('PRE-ACTION VALVE', .95, st, 1.3, 4.6, 0); label('OUTSIDE BUILDING', .6, st, 1.3, 4.05, 0);
  // wet-pipe system (ground floor): its own alarm check valve outside, red pipework, flow switch FS-01
  const W = M.pipeW;
  run(st, [[4.0, .4, 0], [4.0, .4, ZW], [0, .4, ZW], [0, 1.65, ZW]], .2, M.pipeP);
  add(ax(cyl(.27, .5, M.dgrey, 16)), 2.0, .4, ZW); add(cyl(.16, .35, M.dgrey, 12), 2.0, .72, ZW); add(cyl(.03, .55, M.grey, 8), 2.0, 1.1, ZW);
  const wh2 = add(new Mesh(new TorusGeometry(.25, .035, 8, 24), M.black), 2.0, 1.38, ZW); wh2.rotation.x = Math.PI / 2;
  add(box(.5, .02, .035, M.black), 2.0, 1.38, ZW); add(box(.035, .02, .5, M.black), 2.0, 1.38, ZW);
  add(cyl(.3, 1.0, R, 24), 0, 1.15, ZW); [.68, 1.62].forEach(y => add(cyl(.4, .1, M.grey, 24), 0, y, ZW));
  add(ax(cyl(.3, .5, R, 24)), .45, 1.0, ZW); add(ax(cyl(.2, .08, M.grey, 20)), .76, 1.0, ZW);
  pipe(st, [0, 1.65, ZW], [0, YC, ZW], .2, W); add(new Mesh(new SphereGeometry(.23, 12, 10), W), 0, YC, ZW);
  run(st, [[.2, 1.4, ZW], [.2, 1.4, ZW - .55], [.95, 1.4, ZW - .55], [.95, 1.6, ZW - .55]], .04, P); ball(st, .55, 1.4, ZW - .55);
  add(cyl(.2, .7, M.grey, 18), .95, 1.95, ZW - .55);
  run(st, [[.95, 2.3, ZW - .55], [.95, 2.6, ZW - .55], [1.5, 2.6, ZW - .55]], .04, P); add(sph(.2, M.gold), 1.7, 2.6, ZW - .55);
  const sg = mkGauge('SUPPLY'), yg = mkGauge('SYSTEM');
  run(st, [[.2, .95, ZW + .3], [.2, .95, ZW + .8], [.9, .95, ZW + .8]], .04, P); add(sg.g, .95, .95, ZW + .8);
  run(st, [[.2, 2.0, ZW], [.2, 2.0, ZW + .5], [.9, 2.0, ZW + .5]], .04, W); add(yg.g, .95, 2.0, ZW + .5);
  sg.piv.rotation.x = yg.piv.rotation.x = (135 - .72 * 270) * Math.PI / 180;
  add(ax(cyl(.28, .3, M.dgrey, 20)), -5.5, YC, ZW); run(st, [[0, YC, ZW], [-7, YC, ZW]], .14, W);
  label('TO WET SPRINKLERS', .55, st, -3.2, YC + 1.0, ZW); label('WET ALARM VALVE', .8, st, 1.0, 4.0, ZW);
  for (let fi = 0; fi < 3; fi++) {
    const y = fi * FH + YC, wetSys = fi === 0, MM = wetSys ? W : D, zm = wetSys ? SZ + ZW : SZ;
    const eP = sph(.16, D); eP.position.set(RX, YC, SZ); dynG[fi].add(eP);
    if (fi > 0) runF(fi, [[RX, y - FH, SZ], [RX, y, SZ]], .12, D);
    if (wetSys) { const eW = sph(.16, W); eW.position.set(RX, YC, zm); dynG[fi].add(eW); }
    runF(fi, [[RX, y, zm], [-11.5, y, zm]], .1, MM);
    const zs = wetSys ? 9.5 : SZ, hz = wetSys ? [9, 3.5, -.5, -4.5] : [7, 2, -3];
    [11, 0, -11].forEach(x => {
      const zEnd = wetSys ? (x > 8 ? -2 : -4.5) : -3;
      runF(fi, [[x, y, zs], [x, y, zEnd]], .07, MM);
      hz.forEach(z => {
        if (z < zEnd - .01) return;
        const hd = new Group(); hd.position.set(x, YC, z); dynG[fi].add(hd);
        const dp = cyl(.025, .12, M.gold, 8); dp.position.y = -.06; hd.add(dp);
        const bulb = sph(.032, M.red); bulb.position.y = -.14; hd.add(bulb);
        const df = cyl(.09, .012, M.gold, 12); df.position.y = -.2; hd.add(df);
        HEADS.push({fi, sys: wetSys ? 'wet' : 'pre', p: new Vector3(x, fi * FH + YC - .2, z), bulb, acc: 0});
      });
    });
  }

  // ---- fire pump room + water tank (east of the valve pad): tank -> suction header -> 3 pumps -> discharge header -> sprinkler supply
  const PC = [0x2c8a49, 0x1e5fc4, 0xc1121f], PZ = [-3.4, 0, 3.4], PN = ['JOCKEY PUMP', 'ELECTRIC PUMP (DUTY)', 'DIESEL PUMP (STANDBY)'];
  const WX0 = 8.2, WX1 = 19.4, WZ0 = -5.3, WZ1 = 5.3, HH = 3.4, PXC = (WX0 + WX1) / 2;
  outline(add(box(13.7, .3, 10.8, M.conc), 12.75, -.15, .1), st);
  const hb = add(box(WX1 - WX0, HH, WZ1 - WZ0, M.glass), PXC, HH / 2, 0); hb.userData.pump = 1; walls.push(hb);
  const hl = outline(hb, st); hl.userData.pump = 1; walls.push(hl);
  [[WX1 - WX0, .08, PXC, WZ0], [WX1 - WX0, .08, PXC, WZ1], [.08, WZ1 - WZ0, WX0, 0], [.08, WZ1 - WZ0, WX1, 0]].forEach(([w, d, x, z]) => { const m = add(box(w, HH, d, M.wall), x, HH / 2, z); m.userData.pump = 1; walls.push(m); });
  label('FIRE PUMP ROOM', .8, st, PXC, HH + .75, WZ1 + .2);
  const cap = (x, y, z, r) => add(sph(r, M.pipeP), x, y, z);
  run(st, [[9.6, .95, -3.9], [9.6, .95, 3.9]], .2, M.pipeP); cap(9.6, .95, -3.9, .2); cap(9.6, .95, 3.9, .2);
  run(st, [[17.4, .25, -7.35], [17.4, .25, 3.9]], .22, M.pipeP); cap(17.4, .25, 3.9, .22);
  const fl = add(cyl(.34, .08, M.dgrey, 20), 17.4, .25, -7.4); fl.rotation.x = Math.PI / 2;
  label('SUCTION (FROM TANK)', .42, st, 17.4, 1.0, -6.2); label('DISCHARGE HEADER', .42, st, 9.6, 2.5, -2.4);
  const dgg = mkGauge('BAR'); dgg.g.scale.setScalar(1.7); const dgs = dgg.g; add(dgs, 9.85, 1.9, 1.1);
  run(st, [[9.6, .95, 1.1], [9.6, 1.7, 1.1]], .05, M.pipeP);
  const pk = {pumps: [], cab: [], lastPct: -1};
  const pm0 = new MeshBasicMaterial({transparent: true, opacity: 0, depthWrite: false});
  const addPk = (r, x, y, z, dev) => { const q = new Mesh(new SphereGeometry(r, 10, 8), pm0); q.position.set(x, y, z); q.userData.dev = dev; st.add(q); pickables.push(q); };
  PZ.forEach((z, i) => {
    const ya = i ? .95 : .75, r = PR_[i], cm = std(PC[i], {metalness: .3, roughness: .45}), xc = 12.0, g = new Group(); g.position.set(0, 0, z); st.add(g);
    const cs = ax(cyl(r, 1.1, cm, 24)); cs.position.set(xc, ya, 0); g.add(cs);
    [-.55, .55].forEach(dx => { const f = ax(cyl(r * 1.28, .08, M.dgrey, 24)); f.position.set(xc + dx, ya, 0); g.add(f); });
    const gd = box(.4, r * 1.5, r * 1.5, M.yellow); gd.position.set(xc + .75, ya, 0); g.add(gd);
    let endX, mr;
    if (i < 2) {
      const len = i ? 1.7 : 1.0; mr = i ? .46 : .27; const mo = ax(cyl(mr, len, cm, 28)); mo.position.set(xc + .95 + len / 2, ya, 0); g.add(mo);
      for (let k = 0; k < 4; k++) { const fn = ax(cyl(mr * 1.05, .035, M.dgrey, 28)); fn.position.set(xc + 1.2 + k * len / 4.5, ya, 0); g.add(fn); }
      const tb = box(.4, .2, .4, M.dgrey); tb.position.set(xc + 1.5, ya + mr + .1, 0); g.add(tb); endX = xc + .95 + len;
    } else {
      mr = .45; const en = box(1.9, .9, .95, cm); en.position.set(xc + 1.9, ya, 0); g.add(en);
      const hd = box(1.2, .22, .8, M.dgrey); hd.position.set(xc + 1.7, ya + .55, 0); g.add(hd);
      const st2 = cyl(.09, 2.7, M.dgrey, 12); st2.position.set(xc + 2.4, ya + 1.8, .28); g.add(st2); const sc = cyl(.13, .08, M.black, 12); sc.position.set(xc + 2.4, ya + 3.17, .28); g.add(sc);
      const rd = box(.3, 1.0, 1.0, M.dgrey); rd.position.set(xc + 3.0, ya, 0); g.add(rd);
      const dt2 = box(.7, .5, .8, M.orange); dt2.position.set(xc + 2.3, .25, -.9); g.add(dt2); endX = xc + 3.15;
    }
    const skid = box(endX - (xc - .9) + .3, .2, 1.0, M.dgrey); skid.position.set((endX + xc - .9) / 2, .1, 0); g.add(skid);
    [xc, endX - .5].forEach(px => { const h = ya - mr - .2; const pd = box(.5, h, .6, M.dgrey); pd.position.set(px, .2 + h / 2, 0); g.add(pd); });
    const spin = new Group(); spin.position.set(endX + .04, ya, 0); const dsc = ax(cyl(.24, .03, M.black, 16)); spin.add(dsc); const bar = box(.03, .42, .07, M.white); spin.add(bar); g.add(spin);
    const dr = i ? .14 : .09, sr = i ? .15 : .1;
    run(st, i ? [[xc - .55, ya, z], [9.6, ya, z]] : [[xc - .55, ya, z], [10.6, ya, z], [10.6, .95, z], [9.6, .95, z]], dr, M.pipeP);
    run(st, [[xc, ya - r, z], [xc, .25, z], [17.4, .25, z]], sr, M.pipeP);
    add(ax(cyl(.17, .4, M.dgrey, 16)), 10.0 + (i ? .7 : 0), i ? ya : .95, z);
    const wheel = add(new Mesh(new TorusGeometry(.17, .03, 8, 18), M.black), 10.0 + (i ? .7 : 0), (i ? ya : .95) + .42, z); wheel.rotation.x = Math.PI / 2;
    add(cyl(.025, .35, M.grey, 8), 10.0 + (i ? .7 : 0), (i ? ya : .95) + .22, z);
    label(PN[i], .4, st, xc + 1.6, i === 2 ? 4.0 : 2.7, z);
    const dev = {kind: 'pump', i, html: () => pumpTip(i)};
    addPk(1.4, xc + 1.2, ya, z, dev);
    pk.pumps.push({g, mat: cm, spin});
  });
  [0, 1, 2].forEach(i => {
    const cx = 10.4 + i * 1.5, cz = WZ0 + .42, body = box(1.0, 1.8, .5, std(0x4b5560)); body.position.set(cx, .9, cz); st.add(body);
    const door = box(.88, 1.0, .03, std(0x20262b)); door.position.set(cx, 1.0, cz + .26); st.add(door);
    const strip = box(1.0, .2, .52, std(PC[i])); strip.position.set(cx, 1.72, cz); st.add(strip);
    const lamps = [0x3be06f, 0x3be06f, 0xff3b30].map((c, k) => { const m = new MeshStandardMaterial({color: 0x2b3238, emissive: 0, roughness: .4}); const l = sph(.055, m); l.position.set(cx - .25 + k * .25, 1.52, cz + .27); st.add(l); return {m, c}; });
    const kn = new Group(); kn.position.set(cx, 1.15, cz + .29); const kc = cyl(.11, .06, M.black, 16); kc.rotation.x = Math.PI / 2; kn.add(kc); const kb = box(.03, .13, .02, M.white); kb.position.set(0, .055, .04); kn.add(kb); st.add(kn);
    [[-.22, 0x1fa04f], [.22, 0xb3262a]].forEach(([dx, c]) => { const b = cyl(.06, .05, std(c), 14); b.rotation.x = Math.PI / 2; b.position.set(cx + dx, .72, cz + .29); st.add(b); });
    label(['JOCKEY', 'ELECTRIC', 'DIESEL'][i], .3, st, cx, 2.2, cz + .1);
    addPk(.85, cx, 1.0, cz + .2, {kind: 'pump', i, html: () => pumpTip(i)});
    pk.cab.push({lamps, kn});
  });
  // water tank
  const tx = 16.0, tz = -9.6, tr = 2.6, th = 4.6;
  outline(add(box(tr * 2 + .8, .3, tr * 2 + .8, M.conc), tx, -.15, tz), st);
  add(new Mesh(new CylinderGeometry(tr, tr, th, 40, 1, true), M.tankShell), tx, th / 2, tz);
  [.04, th].forEach(y => { const rg = add(new Mesh(new TorusGeometry(tr, .05, 6, 48), M.dgrey), tx, y, tz); rg.rotation.x = Math.PI / 2; });
  const rf = add(new Mesh(new CircleGeometry(tr, 40), M.tankShell), tx, th, tz); rf.rotation.x = -Math.PI / 2;
  const wg2 = new CylinderGeometry(tr - .06, tr - .06, th - .3, 40); wg2.translate(0, (th - .3) / 2, 0);
  const water = add(new Mesh(wg2, M.water), tx, .15, tz);
  add(cyl(.14, .7, M.dgrey, 12), tx - 1.0, th + .35, tz); add(cyl(.4, .1, M.grey, 20), tx + .6, th + .05, tz - .6);
  const lx = tx + 1.99 + .15, lz = tz + 1.67 + .12;
  add(cyl(.09, th - .4, M.glass, 12), lx, th / 2, lz);
  const lg = new CylinderGeometry(.05, .05, th - .5, 10); lg.translate(0, (th - .5) / 2, 0); const lvl = add(new Mesh(lg, M.water), lx, .25, lz);
  for (let k = 0; k <= 4; k++) add(box(.22, .03, .03, M.black), lx + .12, .25 + k * (th - .5) / 4, lz);
  [-.2, .2].forEach(dx => add(cyl(.025, th, M.grey, 6), tx + dx - .9, th / 2, tz + Math.sqrt(tr * tr - (dx - .9) * (dx - .9)) + .04));
  for (let k = 0; k < 12; k++) add(box(.4, .03, .03, M.grey), tx - .9, .3 + k * .36, tz + Math.sqrt(tr * tr - .81) + .04);
  label('FIRE WATER TANK', .75, st, tx, th + 1.5, tz);
  const tl = liveLabel(.6, st, tx, th + .85, tz); tl.userData.draw('100%'); pk.tl = tl; pk.water = water; pk.lvl = lvl;
  addPk(2.9, tx, th / 2, tz, {kind: 'tank', html: () => tankTip()});
  stn = {airN: ag.piv, watN: wg.piv, supN: sg.piv, sysN: yg.piv, dgN: dgg.piv, fw, rh, pk};
}
function stationFrame(dt) {
  if (!stn) return;
  const rel = !!L.release, pa = IN.some(d => d.style === 'valve' && d.on), flow = IN.some(d => d.style === 'flow' && d.on);
  wet = approach(wet, rel ? 1 : 0, .4, dt);
  M.pipeD.color.copy(DRY).lerp(WET, wet); M.pipeD.emissive.setHex(0x1565ff); M.pipeD.emissiveIntensity = .5 * wet;
  airF = approach(airF, rel ? .72 : pa ? .04 : .6, .35, dt);
  stn.airN.rotation.x = (135 - airF * 270) * Math.PI / 180;
  pumpFrame(dt);
  const pf = L.pump ? clamp(Math.sqrt(Math.max(0, L.pump.P) / 8.6), 0, 1.15) : 1;
  stn.fw.rotation.x += (pa && !rel ? 14 : 0) * dt;
  stn.rh.material.opacity = rel ? .55 + .2 * Math.sin(T * 8) : 0;
  const al = IN.filter(d => d.on && (d.style === 'smoke' || d.style === 'heat' || d.style === 'mcp'));
  const near = (sys, on, cap) => {
    if (!on) return [];
    const c = [], pass = any => { for (const h of HEADS) if (h.sys === sys) { let m = 99; for (const a of al) if (any || floorOf(a.wpos.y) === h.fi) m = Math.min(m, Math.hypot(a.wpos.x - h.p.x, a.wpos.z - h.p.z)); if (m < (any ? 99 : 9)) c.push([m, h]); } };
    pass(false); if (!c.length) pass(true);
    if (!c.length) for (const h of HEADS) if (h.sys === sys) c.push([Math.hypot(h.p.x, h.p.z), h]);
    c.sort((a, b) => a[0] - b[0]); return c.slice(0, cap).map(x => x[1]);
  };
  const open = new Set([...near('pre', rel, 8), ...near('wet', flow, 4)]);
  for (const h of HEADS) {
    const o = open.has(h); h.bulb.visible = !o;
    if (o && (h.sys === 'wet' || wet > .6)) { h.acc += dt * 30 * pf; while (h.acc >= 1) { h.acc--; emit('spray', h.p.x, h.p.y, h.p.z); } }
  }
}

function rebuild(C) {
  dynG.forEach(g => { while (g.children.length) g.remove(g.children[0]); });
  IN.length = OUT.length = pickables.length = 0; lift = null; if (gasBox) { gasBox.parent && gasBox.parent.remove(gasBox); gasBox = null; }
  Object.keys(cnt).forEach(k => cnt[k] = 0);
  // remove lift car from previous build
  scene.children.filter(o => o.userData.lift).forEach(o => scene.remove(o));
  buildPanel_attach(); buildInputs(C); C.outputs.forEach(o => mkOut(o, C)); buildStation();
  if (lift) lift.car.userData.lift = 1;
  scene.updateMatrixWorld(true); IN.forEach(d => d.g.getWorldPosition(d.wpos)); OUT.forEach(d => { if (d.g) { d.wpos = new Vector3(); d.g.getWorldPosition(d.wpos); } }); cfgRef = C; applyFloors(); fxReset();
}
function buildPanel_attach() { buildPanel(); dynG[0].add(facp.g); }

/* ---------------------------------------------------------------- per-frame */
/* ---------------------------------------------------------------- active-device tags + cause->effect lines */
let fxG = null, tags = new Map(), linkLine = null, linkPts = null, linkSeg = [], needLinks = true, showLinks = true;
const _v = new Vector3(), _w = new Vector3();
function fxReset() {
  if (fxG) { fxG.parent && fxG.parent.remove(fxG); } fxG = new Group(); scene.add(fxG); tags = new Map(); linkLine = linkPts = null; linkSeg = []; needLinks = true;
}
const outName = k => { const o = cfgRef && cfgRef.outputs.find(x => x.key === k); return o ? dn(o.name).replace(/\s*\(.*\)/, '') : k; };
const arcP = (a, b, u, out) => { out.lerpVectors(a, b, u); out.y += Math.sin(u * Math.PI) * (1.2 + a.distanceTo(b) * .16); return out; };
function buildLinks() {
  needLinks = false;
  if (linkLine) { fxG.remove(linkLine); linkLine.geometry.dispose(); linkLine = null; } if (linkPts) { fxG.remove(linkPts); linkPts.geometry.dispose(); linkPts = null; }
  linkSeg = []; const seen = new Set();
  (L.links || []).forEach(l => l.ins.forEach(i => l.outs.forEach(o => {
    const a = IN.find(x => x.id === i), b = OUT.find(x => x.key === o && x.wpos), key = i + '>' + o;
    if (!a || !b || seen.has(key) || linkSeg.length >= 80) return; seen.add(key); linkSeg.push({a, b, col: new Color(COL[l.t] || COL.fire)});
  })));
  if (!linkSeg.length) return;
  const N = 16, pos = new Float32Array(linkSeg.length * (N - 1) * 6), col = new Float32Array(pos.length);
  linkSeg.forEach((l, j) => { for (let k = 0; k < N - 1; k++) { const o = (j * (N - 1) + k) * 6; for (let e = 0; e < 2; e++) { col[o + e * 3] = l.col.r; col[o + e * 3 + 1] = l.col.g; col[o + e * 3 + 2] = l.col.b; } } });
  const g = new BufferGeometry(); g.setAttribute('position', new BufferAttribute(pos, 3)); g.setAttribute('color', new BufferAttribute(col, 3));
  linkLine = new LineSegments(g, new LineBasicMaterial({vertexColors: true, transparent: true, opacity: .55, depthTest: false})); linkLine.renderOrder = 12; linkLine.frustumCulled = false; fxG.add(linkLine);
  const pg = new BufferGeometry(); pg.setAttribute('position', new BufferAttribute(new Float32Array(linkSeg.length * 2 * 3), 3));
  linkPts = new Points(pg, new PointsMaterial({size: .45, map: DOT, color: 0xffffff, transparent: true, depthTest: false, depthWrite: false, opacity: .95})); linkPts.renderOrder = 13; linkPts.frustumCulled = false; fxG.add(linkPts);
}
function fxFrame(dt) {
  if (!fxG) fxReset();
  OUT.forEach(d => { if (d.g && d.wpos) d.g.getWorldPosition(d.wpos); });
  // tags: one per active input, one per active output type
  const want = new Map();
  for (const d of IN) if (d.on) want.set('i:' + d.id, {p: d.wpos, t: d.id, c: '#ffb4ae', dy: .95});
  for (const d of OUT) { const k = d.key; if (L.outState[k] && d.wpos && !want.has('o:' + k)) want.set('o:' + k, {p: d.wpos, t: outName(k), c: '#bfe3ff', dy: .8}); }
  tags.forEach((tg, k) => { if (!want.has(k)) tg.sp.visible = false; });
  want.forEach((w, k) => {
    let tg = tags.get(k); if (!tg) { tg = {sp: liveLabel(.5, fxG, 0, 0, 0), txt: ''}; tags.set(k, tg); }
    if (tg.txt !== w.t) { tg.txt = w.t; tg.sp.userData.draw(w.t.slice(0, 22), w.c); }
    const vis = floorOf(w.p.y) <= floorCap; tg.sp.visible = vis; if (!vis) return;
    tg.sp.position.set(w.p.x, w.p.y + w.dy, w.p.z); const sz = clamp(camera.position.distanceTo(tg.sp.position) * .019, .4, 1.2); tg.sp.scale.set(sz * 4, sz, 1);
  });
  // cause -> effect lines
  if (needLinks) buildLinks();
  const on = showLinks && linkLine; if (linkLine) linkLine.visible = linkPts.visible = !!showLinks;
  if (on) {
    const N = 16, pa = linkLine.geometry.attributes.position.array, pp = linkPts.geometry.attributes.position.array;
    linkSeg.forEach((l, j) => {
      _w.copy(l.a.wpos); let prev = _w.clone();
      for (let k = 0; k < N - 1; k++) { const o = (j * (N - 1) + k) * 6, u1 = (k + 1) / (N - 1); arcP(l.a.wpos, l.b.wpos, k / (N - 1), _v); pa[o] = _v.x; pa[o + 1] = _v.y; pa[o + 2] = _v.z; arcP(l.a.wpos, l.b.wpos, u1, _v); pa[o + 3] = _v.x; pa[o + 4] = _v.y; pa[o + 5] = _v.z; }
      for (let e = 0; e < 2; e++) { arcP(l.a.wpos, l.b.wpos, (T * .45 + e * .5 + j * .13) % 1, _v); const o = (j * 2 + e) * 3; pp[o] = _v.x; pp[o + 1] = _v.y; pp[o + 2] = _v.z; }
    });
    linkLine.geometry.attributes.position.needsUpdate = true; linkPts.geometry.attributes.position.needsUpdate = true;
  }
}
function frame(dt) {
  const s = L;
  for (const d of IN) {
    const on = s.on.has(d.id), col = COL[s.inState[d.key] || 'fire'];
    d.on = on; d.led.material.emissive.setHex(on ? col : 0); d.led.material.emissiveIntensity = on ? 2.4 : 0;
    d.h.material.opacity = on ? .5 + .25 * Math.sin(T * 7) : 0; d.h.material.color.setHex(col); d.h.scale.setScalar(d.h.userData.base * (1 + (on ? .12 * Math.sin(T * 7) : 0)));
    if (on) {
      const rate = d.style === 'smoke' ? 12 : d.style === 'heat' ? 14 : 0;
      if (rate) { d.acc += dt * rate; while (d.acc >= 1) { d.acc--; const t = d.style === 'smoke' ? 'smoke' : d.style === 'heat' ? 'heat' : 'water'; emit(t, d.wpos.x + (Math.random() - .5) * .3, d.wpos.y + (t === 'water' ? .3 : -.1), d.wpos.z + (Math.random() - .5) * .3); } }
    }
  }
  for (const d of OUT) d.upd(dt, T);
  const ll = s.leds || {}; if (facp) { setLed(facp.leds.pwr, true, 1.4); setLed(facp.leds.pre, ll.pre); setLed(facp.leds.fire, ll.fire); setLed(facp.leds.sup, ll.sup); setLed(facp.leds.sil, ll.sil); drawPanel(); }
  stationFrame(dt);
  fxFrame(dt); ctrlFrame();
  tickParticles(dt);
}
function applyFloors() {
  floors.forEach((g, i) => g.visible = i <= floorCap);
  walls.forEach(w => w.visible = showWalls);
}
function loop(t) {
  raf = requestAnimationFrame(loop); const dt = Math.min(.05, (t - lastT) / 1000 || 0); lastT = t; T += dt;
  if (tween) { tween.u = Math.min(1, tween.u + dt / .9); const e = tween.u * tween.u * (3 - 2 * tween.u); controls.target.lerpVectors(tween.t0, tween.t1, e); camera.position.lerpVectors(tween.p0, tween.p1, e); if (tween.u >= 1) tween = null; }
  frame(dt); controls.update(); renderer.render(scene, camera);
  if (pinTip && T > pinTip) { pinTip = 0; tipEl.style.opacity = 0; }
}
function resize() {
  const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  pts.material.uniforms.scale.value = h * renderer.getPixelRatio() / (2 * Math.tan(camera.fov * Math.PI / 360));
}

/* ---------------------------------------------------------------- interaction */
function pickAt(ev) {
  const r = canvas.getBoundingClientRect(); ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  rc.setFromCamera(ndc, camera);
  const shown = o => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
  const hit = rc.intersectObjects(pickables, false).find(h => shown(h.object)); return hit ? hit.object.userData.dev : null;
}
function showTip(ev, d, pin) {
  if (!d) { if (!pin) tipEl.style.opacity = 0; return; }
  const r = canvas.getBoundingClientRect(); tipEl.innerHTML = d.html ? d.html() : api.describe(d); tipEl.style.opacity = 1;
  const x = clamp(ev.clientX - r.left + 14, 6, r.width - tipEl.offsetWidth - 6), y = clamp(ev.clientY - r.top + 14, 6, r.height - tipEl.offsetHeight - 6);
  tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px'; if (pin) pinTip = T + 3.5;
}
function bindEvents() {
  let down = null;
  canvas.addEventListener('pointerdown', e => { down = {x: e.clientX, y: e.clientY, t: performance.now()}; });
  canvas.addEventListener('pointerup', e => {
    if (!down) return; const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dur = performance.now() - down.t; down = null;
    if (moved > 6 || dur > 600) return;
    const d = pickAt(e); if (!d) { tipEl.style.opacity = 0; return; }
    if (d.kind === 'in') { api.toggle(d.id); showTip(e, d, true); setTimeout(() => { if (tipEl.style.opacity === '1') tipEl.innerHTML = d.html ? d.html() : api.describe(d); }, 60); } else showTip(e, d, true);
  });
  canvas.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch' || e.buttons) return; const d = pickAt(e); canvas.style.cursor = d ? 'pointer' : 'grab'; if (!pinTip) showTip(e, d, false);
  });
  canvas.addEventListener('pointerleave', () => { if (!pinTip) tipEl.style.opacity = 0; });
  new ResizeObserver(resize).observe(host);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (running) start(); });
  new MutationObserver(() => applyTheme()).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
}
function start() { if (raf) return; lastT = performance.now(); raf = requestAnimationFrame(loop); }
function stop() { cancelAnimationFrame(raf); raf = 0; }

/* ---------------------------------------------------------------- public API */
export function init(el, a) {
  host = el; api = a;
  renderer = new WebGLRenderer({antialias: true, alpha: true, powerPreference: 'high-performance'}); renderer.setClearColor(0, 0); canvas = renderer.domElement; host.appendChild(canvas);
  tipEl = document.createElement('div'); tipEl.className = 'v3-tip'; host.appendChild(tipEl);
  scene = new Scene(); camera = new PerspectiveCamera(40, 1, .5, 400);
  const hemi = new HemisphereLight(0xffffff, 0x8899aa, 1.2); scene.add(hemi); scene.userData.hemi = hemi;
  const sun = new DirectionalLight(0xffffff, 1.3); sun.position.set(20, 40, 25); scene.add(sun);
  controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.dampingFactor = .09; controls.maxPolarAngle = Math.PI * .495; controls.minDistance = 5; controls.maxDistance = 160; controls.autoRotateSpeed = .8;
  makeMats(); buildBuilding(); buildParticles(); applyTheme(); bindEvents(); resize(); resetView(true);
}
export function update(s) {
  L = Object.assign(L, s); if (s.links) { const sg = JSON.stringify(s.links); if (sg !== L._ls) { L._ls = sg; needLinks = true; } }
  if (s.C && s.C !== cfgRef) rebuild(s.C);
}
export function setActive(b) { running = b; if (b) { resize(); applyTheme(); start(); } else stop(); }
export function resetView(instant) {
  const far = camera.aspect < .9 ? Math.min(2.7, 1.55 / camera.aspect) : 1, p1 = new Vector3(47 * far, 28 * far, 48 * far), t1 = new Vector3(13, 2, 2);
  if (instant) { camera.position.copy(p1); controls.target.copy(t1); controls.update(); } else tween = {u: 0, t0: controls.target.clone(), t1, p0: camera.position.clone(), p1};
}
export function setPump(q) { L.pump = q; }
export function focusPump() {
  const t1 = new Vector3(SX + 14.5, 1.6, SZ - 2), off = new Vector3(.55, .5, .75).normalize().multiplyScalar(camera.aspect < .9 ? 40 : 24);
  tween = {u: 0, t0: controls.target.clone(), t1, p0: camera.position.clone(), p1: t1.clone().add(off)};
}
export function showLinkLines(b) { showLinks = b; }
export function where(kind, id) {
  const d = kind === 'in' ? IN.find(x => x.id === id) : OUT.find(x => x.key === id && x.wpos); if (!d || !d.wpos) return '';
  const p = d.wpos; if (p.x > 18.6 || p.z > 11.4 || p.z < -11.4) return 'Outside'; return ['G', 'L1', 'L2', 'Roof'][floorOf(p.y)] || '';
}
export function focusDev(kind, id, n = 0) {
  const arr = kind === 'in' ? IN.filter(x => x.id === id) : OUT.filter(x => x.key === id && x.wpos); if (!arr.length) return false;
  const d = arr[n % arr.length], fi = floorOf(d.wpos.y); if (fi > floorCap) { floorCap = fi; applyFloors(); }
  const t1 = d.wpos.clone(), off = camera.position.clone().sub(controls.target).normalize().multiplyScalar(camera.aspect < .9 ? 30 : 15);
  tween = {u: 0, t0: controls.target.clone(), t1, p0: camera.position.clone(), p1: t1.clone().add(off)}; return arr.length;
}
export function focusFloor(fi) {
  fi = clamp(fi | 0, 0, 2); if (floorCap < fi) { floorCap = fi; applyFloors(); }
  const t1 = new Vector3(0, fi * FH + 1.5, 0), off = new Vector3(.45, .8, .9).normalize().multiplyScalar(camera.aspect < .9 ? 62 : 36);
  tween = {u: 0, t0: controls.target.clone(), t1, p0: camera.position.clone(), p1: t1.clone().add(off)};
}
export function snapshot() { renderer.render(scene, camera); return canvas.toDataURL('image/png'); }
export function setFloor(n) { floorCap = n; applyFloors(); }
export function setWalls(b) { showWalls = b; applyFloors(); }
export function setAuto(b) { controls.autoRotate = b; }
export function focusAlarm() {
  const d = IN.find(x => x.on); if (!d) return false;
  const fi = floorOf(d.wpos.y); if (fi > floorCap) { floorCap = Math.max(floorCap, fi); applyFloors(); }
  const t1 = d.wpos.clone(), off = camera.position.clone().sub(controls.target).normalize().multiplyScalar(camera.aspect < .9 ? 30 : 16);
  tween = {u: 0, t0: controls.target.clone(), t1, p0: camera.position.clone(), p1: t1.clone().add(off)}; return true;
}
export function focusValve() {
  const t1 = new Vector3(SX + .4, 1.9, SZ + .6), off = new Vector3(.55, .32, .8).normalize().multiplyScalar(camera.aspect < .9 ? 15 : 10.5);
  tween = {u: 0, t0: controls.target.clone(), t1, p0: camera.position.clone(), p1: t1.clone().add(off)};
}
