import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FEATURES, defaults, docs } from './schema.js';
import './style.css';

// ---------- tiny DOM helper ----------
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k in e && k !== 'list') e[k] = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids.flat(9).filter((x) => x != null));
  return e;
};
const $ = (id) => document.getElementById(id);
const fill = (id, ...kids) => $(id).replaceChildren(...kids.flat(9).filter((x) => x != null));
const status = (s) => ($('status').textContent = s);
const fmt = (x) => (Math.abs(x) >= 1e5 ? x.toExponential(3) : +x.toFixed(3));

// ---------- kernel worker ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let rid = 0;
const pending = new Map();
worker.onmessage = ({ data }) => { const p = pending.get(data.id); pending.delete(data.id); data.error ? p.rej(Error(data.error)) : p.res(data.result); };
const call = (cmd, ...args) => new Promise((res, rej) => { pending.set(++rid, { res, rej }); worker.postMessage({ id: rid, cmd, args }); });

// ---------- state ----------
const S = { doc: { name: 'untitled', params: [], features: [] }, res: null, sel: null, upTo: null, undo: [], redo: [], pick: null, sketch: null, tool: null, hidden: new Set(), server: false, lastSaved: '' };
const feat = (id) => S.doc.features.find((f) => f.id === id);
const idx = (id) => S.doc.features.findIndex((f) => f.id === id);

function change(fn) { S.undo.push(JSON.stringify(S.doc)); if (S.undo.length > 200) S.undo.shift(); S.redo = []; fn && fn(); dirty(); }
function dirty() { save(); panels(); return rebuild(); }
let saveT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const body = JSON.stringify(S.doc, null, 1);
    S.lastSaved = body;
    try { localStorage.setItem('forge-doc', body); } catch {}
    if (S.server) fetch('/api/doc', { method: 'PUT', body }).catch(() => {});
  }, 250);
}
function restore(from, to) { if (!from.length) return; to.push(JSON.stringify(S.doc)); S.doc = JSON.parse(from.pop()); if (!feat(S.sel)) S.sel = null; if (!feat(S.sketch)) S.sketch = null; dirty(); }

let building = false, again = false, buildP = null;
function rebuild() { if (building) { again = true; return buildP; } return (buildP = build()); }
async function build() {
  building = true;
  do {
    again = false; status('Rebuilding…');
    const upTo = S.pick ? idx(S.pick.fid) : S.sketch ? idx(S.sketch) + 1 : S.upTo ?? undefined;
    try {
      S.res = await call('evaluate', S.doc, { upTo });
      drawScene(); panels();
      const n = Object.keys(S.res.errors).length;
      status(`${S.res.bodies.length} bodies · ${S.doc.features.length} features · ${S.res.ms} ms` + (n ? ` · ${n} error${n > 1 ? 's' : ''}` : ''));
    } catch (e) { status('Kernel error: ' + e.message); }
  } while (again);
  building = false;
}

// ---------- three.js viewport ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setClearColor(0x16181d);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 1e5);
camera.up.set(0, 0, 1); camera.position.set(160, -200, 140);
const controls = new OrbitControls(camera, canvas);
controls.addEventListener('change', render);
scene.add(new THREE.HemisphereLight(0xffffff, 0x555566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8); camera.add(sun); sun.position.set(1, 2, 3); scene.add(camera);
const grid = new THREE.GridHelper(400, 40, 0x3a4150, 0x262a33); grid.rotation.x = Math.PI / 2; scene.add(grid);
scene.add(new THREE.AxesHelper(30));
const bodyG = new THREE.Group(), sketchG = new THREE.Group(), hlG = new THREE.Group(), markG = new THREE.Group(), draftG = new THREE.Group();
scene.add(bodyG, sketchG, hlG, markG, draftG);
const clip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
function render() { renderer.render(scene, camera); }
function resize() { const r = canvas.parentElement.getBoundingClientRect(); renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); render(); }
new ResizeObserver(resize).observe(canvas.parentElement);

const PALETTE = ['#8fa3b8', '#c9a26b', '#7fb58a', '#b58fb8', '#b8a08f', '#8fb8b5', '#b88f8f', '#a3a86e'];
const clear = (g) => { for (const c of [...g.children]) { c.geometry?.dispose(); g.remove(c); } };
function drawScene() {
  clear(bodyG); clear(sketchG); clear(markG);
  (S.res?.bodies || []).forEach((b, i) => {
    if (!b.mesh || b.hidden || S.hidden.has(b.name)) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(b.mesh.vertices, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(b.mesh.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(b.mesh.triangles, 1));
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: b.color || PALETTE[i % PALETTE.length], metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide, transparent: b.opacity < 1 || !!S.sketch, opacity: S.sketch ? Math.min(b.opacity, 0.45) : b.opacity, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    mesh.userData = { body: b, kind: 'face' };
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(b.mesh.lines, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x0c0d10 }));
    lines.userData = { body: b, kind: 'edge' };
    bodyG.add(mesh, lines);
  });
  const used = new Set(S.doc.features.flatMap((f) => [f.sketch, f.profile, f.path, ...(f.sketches || [])]));
  for (const [id, sk] of Object.entries(S.res?.sketches || {})) {
    const active = id === S.sketch;
    if (!active && id !== S.sel && used.has(id)) continue;
    for (const e of sk.entities) addPoly(sketchG, sk.frame, entPts(e), active ? (e.mode === 'cut' ? 0xff8f6b : 0x6bd0ff) : 0x5a7fa8);
  }
  const f = feat(S.sel);
  if (f) {
    const pts = [...(f.edges?.points || []), ...(f.faces?.points || []), ...(f.points || [])].filter((p) => p.every((c) => typeof c === 'number'));
    if (pts.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3)); markG.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffb84f, size: 9, sizeAttenuation: false, depthTest: false }))); }
  }
  render();
}
const to3 = (fr, [u, v]) => [0, 1, 2].map((i) => fr.o[i] + fr.x[i] * u + fr.y[i] * v);
function addPoly(group, fr, pts, color) {
  if (pts.length < 2) return;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap((p) => to3(fr, p)), 3));
  group.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false })));
}
// 2D polyline approximation of a (numerically resolved) sketch entity, for display only.
const D = Math.PI / 180;
function arc3(p0, pm, p1, n = 24) {
  const [ax, ay] = p0, [bx, by] = pm, [cx, cy] = p1, d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return [p1];
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy), a0 = Math.atan2(ay - uy, ax - ux), a1 = Math.atan2(cy - uy, cx - ux), T = 2 * Math.PI, nm = (a) => ((a % T) + T) % T;
  const sweep = d > 0 ? nm(a1 - a0) : -nm(a0 - a1);
  return Array.from({ length: n }, (_, i) => { const a = a0 + (sweep * (i + 1)) / n; return [ux + r * Math.cos(a), uy + r * Math.sin(a)]; });
}
function entPts(e) {
  const cx = e.cx || 0, cy = e.cy || 0;
  const ell = (rx, ry, rot = 0, n = 64, a0 = 0) => { const c = Math.cos(rot * D), s = Math.sin(rot * D); return Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (i / n) * 2 * Math.PI, x = rx * Math.cos(a), y = ry * Math.sin(a); return [cx + x * c - y * s, cy + x * s + y * c]; }); };
  if (e.t === 'circle') return ell(e.r, e.r);
  if (e.t === 'ellipse') return ell(e.rx, e.ry, e.rot);
  if (e.t === 'polygon') return ell(e.r, e.r, e.rot, Math.round(e.n || 6), Math.PI / 2);
  if (e.t === 'rect') { const c = Math.cos((e.rot || 0) * D), s = Math.sin((e.rot || 0) * D), w = e.w / 2, hh = e.h / 2; return [[-w, -hh], [w, -hh], [w, hh], [-w, hh], [-w, -hh]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]); }
  if (e.t === 'slot') { const a = Math.atan2(e.y2 - e.y1, e.x2 - e.x1), r = e.w / 2, P = []; for (let i = 0; i <= 16; i++) { const t = a - Math.PI / 2 + (i / 16) * Math.PI; P.push([e.x2 + r * Math.cos(t), e.y2 + r * Math.sin(t)]); } for (let i = 0; i <= 16; i++) { const t = a + Math.PI / 2 + (i / 16) * Math.PI; P.push([e.x1 + r * Math.cos(t), e.y1 + r * Math.sin(t)]); } P.push(P[0]); return P; }
  if (e.t === 'path') {
    const P = [e.start];
    for (const s of e.segs || []) {
      const a = P[P.length - 1], b = s.to;
      if (s.via) P.push(...arc3(a, s.via, b));
      else if (s.bulge) { const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, k = s.bulge / 2; P.push(...arc3(a, [mx - (b[1] - a[1]) * k, my + (b[0] - a[0]) * k], b)); }
      else if (s.c1) { const c2 = s.c2 || s.c1; for (let i = 1; i <= 20; i++) { const t = i / 20, m = 1 - t; P.push([0, 1].map((j) => m * m * m * a[j] + 3 * m * m * t * s.c1[j] + 3 * m * t * t * c2[j] + t * t * t * b[j])); } }
      else P.push(b);
    }
    if (e.closed !== false) P.push(e.start);
    return P;
  }
  return [];
}

// ---------- camera ----------
function fit() {
  const box = new THREE.Box3().setFromObject(bodyG);
  if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 50));
  const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2 || 50;
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(c); camera.position.copy(c).add(dir.multiplyScalar(r / Math.sin((camera.fov * D) / 2)));
  camera.near = r / 100; camera.far = r * 100; camera.updateProjectionMatrix(); controls.update(); render();
}
function view(dir, up = [0, 0, 1]) { const d = camera.position.distanceTo(controls.target); camera.up.set(...up); camera.position.copy(controls.target).add(new THREE.Vector3(...dir).normalize().multiplyScalar(d)); controls.update(); fit(); }
function lookAtSketch(id) { const fr = S.res?.sketches[id]?.frame; if (!fr) return; const d = Math.min(Math.max(camera.position.distanceTo(controls.target), 80), 400); controls.target.set(...fr.o); camera.up.set(...fr.y); camera.position.set(...fr.o.map((c, i) => c + fr.z[i] * d)); controls.update(); render(); }

// ---------- picking ----------
const ray = new THREE.Raycaster();
function setRay(ev) { const r = canvas.getBoundingClientRect(); ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera); }
function pickAt(ev) {
  setRay(ev);
  const thr = camera.position.distanceTo(controls.target) * 0.006; ray.params.Line.threshold = thr;
  const hits = ray.intersectObjects(bodyG.children, false).filter((x) => !renderer.clippingPlanes.length || clip.distanceToPoint(x.point) >= 0);
  const fh = hits.find((x) => x.object.userData.kind === 'face'), eh = hits.find((x) => x.object.userData.kind === 'edge');
  const want = S.pick?.kind;
  const useEdge = eh && want !== 'faces' && want !== 'points' && want !== 'plane' && (!fh || want === 'edges' || eh.distance < fh.distance + thr * 2);
  const hit = useEdge ? eh : fh; if (!hit) return null;
  const b = hit.object.userData.body, kind = hit.object.userData.kind, i = kind === 'face' ? hit.faceIndex * 3 : hit.index;
  const group = (kind === 'face' ? b.faceGroups : b.edgeGroups).find((g) => i >= g.start && i < g.start + g.count);
  return group && { kind, body: b, group, point: hit.point.toArray(), obj: hit.object };
}
function highlight(hit) {
  clear(hlG);
  if (hit) {
    const g = hit.group, geo = new THREE.BufferGeometry(), src = hit.obj.geometry;
    if (hit.kind === 'face') { geo.setAttribute('position', src.attributes.position); geo.setIndex(new THREE.BufferAttribute(src.index.array.subarray(g.start, g.start + g.count), 1)); hlG.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffb84f, transparent: true, opacity: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }))); }
    else { geo.setAttribute('position', new THREE.BufferAttribute(src.attributes.position.array.subarray(g.start * 3, (g.start + g.count) * 3), 3)); hlG.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffb84f, depthTest: false }))); }
  }
  render();
}
let lastPt = null;
function showInfo(hit) {
  const g = hit.group, d = lastPt ? `  ·  distance from last pick ${fmt(Math.hypot(...hit.point.map((c, i) => c - lastPt[i])))} mm` : '';
  $('info').textContent = (hit.kind === 'face' ? `${hit.body.name} · ${g.type || 'face'} · area ${fmt(g.area || 0)} mm²` : `${hit.body.name} · ${g.type || 'edge'} · length ${fmt(g.length || 0)} mm`) + `  ·  (${hit.point.map(fmt).join(', ')})` + d;
  lastPt = hit.point;
}
function applyPick(hit) {
  const { fid, key, kind } = S.pick, f = feat(fid); if (!f) return;
  const r = (p) => p.map((c) => +c.toFixed(4));
  if (kind === 'plane') { change(() => { f.plane = { face: { body: hit.body.name, point: r(hit.group.key) } }; S.pick = null; }); return; }
  if (kind === 'points') { change(() => { f[key] = [...(f[key] || []), r(hit.point)]; if ('body' in f && !f.body) f.body = hit.body.name; }); return; }
  if ((kind === 'edges') !== (hit.kind === 'edge') || !hit.group.key) return;
  change(() => {
    const cur = f[key] && typeof f[key] === 'object' ? f[key].points || [] : [], k = r(hit.group.key);
    const j = cur.findIndex((p) => Math.hypot(...p.map((c, i) => c - k[i])) < 1e-3);
    f[key] = { points: j >= 0 ? cur.filter((_, i) => i !== j) : [...cur, k] };
    f.body = hit.body.name;
  });
}
let down = null;
canvas.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.button !== 0) return;
  if (S.sketch && S.tool) return sketchClick(sketchPt(e), e);
  const hit = pickAt(e); if (!hit) return;
  S.pick ? applyPick(hit) : showInfo(hit);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  if (S.sketch && S.tool) { const p = sketchPt(e); if (p) { $('info').textContent = `u ${fmt(p[0])}  v ${fmt(p[1])}`; preview(p); } return; }
  highlight(pickAt(e));
});

// ---------- sketch mode ----------
let draft = null;
function sketchPt(ev) {
  const fr = S.res?.sketches[S.sketch]?.frame; if (!fr) return null;
  setRay(ev);
  const o = new THREE.Vector3(...fr.o), hit = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...fr.z), o), new THREE.Vector3());
  if (!hit) return null;
  const d = hit.sub(o), step = ev.altKey ? 0.01 : ev.shiftKey ? 0.1 : 1, sn = (x) => +(Math.round(x / step) * step).toFixed(4);
  return [sn(d.dot(new THREE.Vector3(...fr.x))), sn(d.dot(new THREE.Vector3(...fr.y)))];
}
function makeEnt(tool, a, b) {
  const r = +Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(4);
  if (tool === 'rect') return { t: 'rect', cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
  if (tool === 'circle') return { t: 'circle', cx: a[0], cy: a[1], r };
  if (tool === 'polygon') return { t: 'polygon', cx: a[0], cy: a[1], r, n: 6 };
  if (tool === 'slot') return { t: 'slot', x1: a[0], y1: a[1], x2: b[0], y2: b[1], w: 6 };
}
const bbox = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
function addEnt(e) {
  if (e.t !== 'path' ? !(entPts(e).length > 2) || (e.r ?? e.w ?? 1) <= 0 || (e.h ?? 1) <= 0 : false) return;
  // a closed shape drawn fully inside an existing one becomes a hole
  if (e.closed !== false) { const n = bbox(entPts(e)); for (const o of S.res?.sketches[S.sketch]?.entities || []) { if (o.mode === 'cut' || o.closed === false) continue; const q = bbox(entPts(o)); if (n[0] > q[0] && n[1] > q[1] && n[2] < q[2] && n[3] < q[3]) e.mode = 'cut'; } }
  change(() => feat(S.sketch).entities.push(e));
}
function sketchClick(p, ev) {
  if (!p) return;
  if (S.tool === 'path') {
    if (!draft) draft = { pts: [p] };
    else if (draft.pts.length > 2 && Math.hypot(p[0] - draft.pts[0][0], p[1] - draft.pts[0][1]) < 1e-6) finishPath(true);
    else draft.pts.push(p);
  } else if (!draft) draft = { pts: [p] };
  else { const e = makeEnt(S.tool, draft.pts[0], p); draft = null; clear(draftG); addEnt(e); }
  hint();
}
function finishPath(closed) {
  const pts = draft?.pts; draft = null; clear(draftG); render();
  if (pts && pts.length >= (closed ? 3 : 2)) addEnt({ t: 'path', start: pts[0], closed, segs: pts.slice(1).map((to) => ({ to })) });
  hint();
}
function preview(p) {
  clear(draftG);
  const fr = S.res?.sketches[S.sketch]?.frame;
  if (draft && fr) addPoly(draftG, fr, S.tool === 'path' ? [...draft.pts, p] : entPts(makeEnt(S.tool, draft.pts[0], p)), 0xffe08a);
  render();
}
async function enterSketch(id) { S.sketch = id; S.sel = id; S.pick = null; S.tool = 'path'; draft = null; await rebuild(); lookAtSketch(id); panels(); }
async function exitSketch() { S.sketch = null; S.tool = null; draft = null; clear(draftG); await rebuild(); panels(); }
function hint() {
  $('hint').textContent = S.pick ? `Picking ${S.pick.kind} — click the model (click again to deselect), Esc when done. The model is shown as it was before this feature.`
    : S.sketch ? (S.tool === 'path' ? 'Path: click points · click the first point or press Enter to close · Shift+Enter leaves it open (sweep path) · Esc cancels' : S.tool ? `${S.tool}: click two points` : 'Pick a tool') + ' · snap 1 mm (Shift 0.1, Alt off)'
    : 'Left-drag orbit · right-drag pan · wheel zoom · click a face/edge to measure';
}

// ---------- features ----------
function addFeature(type) {
  const f = defaults(type);
  S.sketch = S.tool = S.pick = draft = null; clear(draftG);
  let i = 1; while (feat(type + i)) i++; f.id = type + i;
  const before = S.doc.features.slice(0, S.upTo ?? undefined), lastSk = before.filter((x) => x.type === 'sketch').pop(), bodies = (S.res?.bodies || []).map((b) => b.name);
  for (const [k, kind] of FEATURES[type].fields) {
    if (kind === 'sketch' && lastSk) f[k] = lastSk.id;
    if (kind === 'body' && k !== 'target') f[k] = f.op === 'new' ? '' : bodies[bodies.length - 1] || '';
  }
  if (type === 'sweep') { const sk = before.filter((x) => x.type === 'sketch'); f.path = sk.find((s) => s.entities.some((e) => e.closed === false))?.id || ''; f.profile = sk.filter((s) => s.id !== f.path).pop()?.id || ''; }
  if (type === 'loft') f.sketches = before.filter((x) => x.type === 'sketch').slice(-2).map((s) => s.id);
  change(() => { S.doc.features.splice(S.upTo ?? S.doc.features.length, 0, f); if (S.upTo != null) S.upTo++; S.sel = f.id; });
  if (type === 'sketch') enterSketch(f.id);
}
const parseNum = (v) => (v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : v.trim());
const parseJSON = (v) => { try { return JSON.parse(v); } catch { return v; } };
function field(f, [k, kind, , help]) {
  const set = (v) => change(() => (f[k] = v)), val = f[k];
  const pickBtn = (pk) => h('button', { class: S.pick?.fid === f.id && S.pick.key === k ? 'on' : '', onclick: async () => { S.pick = S.pick?.key === k && S.pick.fid === f.id ? null : { fid: f.id, key: k, kind: pk }; hint(); panels(); await rebuild(); } }, 'Pick');
  const bodies = (S.res?.bodies || []).map((b) => b.name), sks = S.doc.features.filter((x) => x.type === 'sketch').map((x) => x.id);
  const sel = (opts) => h('select', { onchange: (e) => set(e.target.value) }, [...new Set(['', ...opts, typeof val === 'string' ? val : ''])].map((o) => h('option', { value: o, selected: o === val }, o || '—')));
  let ctl;
  if (kind === 'num') ctl = h('input', { value: val ?? '', onchange: (e) => set(parseNum(e.target.value)) });
  else if (kind === 'vec') ctl = [0, 1, 2].map((i) => h('input', { value: (Array.isArray(val) ? val : [0, 0, 0])[i], onchange: (e) => { const a = [...(Array.isArray(val) ? val : [0, 0, 0])]; a[i] = parseNum(e.target.value); set(a); } }));
  else if (kind === 'bool') ctl = h('input', { type: 'checkbox', checked: !!val, onchange: (e) => set(e.target.checked) });
  else if (kind === 'color') ctl = h('input', { type: 'color', value: val || '#8899aa', onchange: (e) => set(e.target.value) });
  else if (kind === 'op') ctl = sel(['new', 'add', 'cut', 'intersect']);
  else if (kind.startsWith('select:')) ctl = sel(kind.slice(7).split('|'));
  else if (kind === 'sketch') ctl = sel(sks);
  else if (kind === 'body') ctl = [h('input', { value: val || '', list: 'bodies', placeholder: f.op === 'new' ? 'new body name' : 'body', onchange: (e) => set(e.target.value.trim()) }), h('datalist', { id: 'bodies' }, bodies.map((b) => h('option', { value: b })))];
  else if (kind === 'sketches' || kind === 'bodies') ctl = h('input', { value: (val || []).join(', '), placeholder: 'comma separated', onchange: (e) => set(e.target.value.split(',').map((s) => s.trim()).filter(Boolean)) });
  else if (kind === 'edges' || kind === 'faces' || kind === 'points') ctl = [h('input', { value: JSON.stringify(val ?? ''), title: 'selector JSON', onchange: (e) => set(parseJSON(e.target.value)) }), pickBtn(kind), kind === 'edges' ? h('button', { onclick: () => set('all') }, 'All') : null];
  else if (kind === 'plane') ctl = [typeof val === 'string' ? sel(['XY', 'XZ', 'YZ']) : h('input', { value: JSON.stringify(val), onchange: (e) => set(parseJSON(e.target.value)) }), pickBtn('plane'), typeof val !== 'string' ? h('button', { onclick: () => set('XY') }, 'XY') : null];
  else if (kind === 'file') ctl = h('input', { type: 'file', accept: '.step,.stp', onchange: async (e) => { const b = new Uint8Array(await e.target.files[0].arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); set(btoa(s)); } });
  else if (kind === 'entities') return entities(f);
  else ctl = h('input', { value: val ?? '', onchange: (e) => set(e.target.value) });
  return [h('div', { class: 'row', title: help || '' }, h('label', {}, k), ctl), null];
}
function entities(f) {
  const editing = S.sketch === f.id;
  return [h('div', { class: 'row' }, h('button', { class: editing ? 'on' : '', onclick: () => (editing ? exitSketch() : enterSketch(f.id)) }, editing ? '✓ Finish sketch' : '✎ Edit sketch'), h('span', {}, `${f.entities.length} entities`)),
    f.entities.map((e, i) => h('div', { class: 'ent' },
      h('div', { class: 'row' }, h('b', { style: 'flex:1' }, e.t), e.closed === false ? h('span', {}, 'open') : h('button', { class: e.mode === 'cut' ? 'on' : '', title: 'subtract from the profile (hole)', onclick: () => change(() => (e.mode = e.mode === 'cut' ? 'add' : 'cut')) }, 'hole'), h('button', { class: 'x', onclick: () => change(() => f.entities.splice(i, 1)) }, '✕')),
      Object.keys(e).filter((k) => !['t', 'mode'].includes(k)).map((k) => h('div', { class: 'row' }, h('label', {}, k), h('input', { value: typeof e[k] === 'object' || typeof e[k] === 'boolean' ? JSON.stringify(e[k]) : e[k], onchange: (ev) => change(() => (e[k] = typeof e[k] === 'object' || typeof e[k] === 'boolean' ? parseJSON(ev.target.value) : parseNum(ev.target.value))) })))))];
}

// ---------- panels ----------
function panels() {
  const errs = S.res?.errors || {}, n = S.doc.features.length, upTo = S.upTo ?? n;
  fill('left',
    h('h3', {}, 'Parameters', h('button', { class: 'x', title: 'add parameter', onclick: () => change(() => { let i = 1; while (S.doc.params.some((p) => p.name === 'p' + i)) i++; S.doc.params.push({ name: 'p' + i, expr: '10' }); }) }, '＋')),
    (S.doc.params || []).map((p, i) => h('div', { class: 'row', title: errs['param:' + p.name] || '' },
      h('input', { value: p.name, style: 'width:70px;flex:none', onchange: (e) => change(() => (p.name = e.target.value.trim())) }),
      h('input', { value: p.expr, style: errs['param:' + p.name] ? 'border-color:var(--err)' : '', onchange: (e) => change(() => (p.expr = e.target.value)) }),
      h('span', { style: 'width:44px;flex:none;color:var(--dim);text-align:right' }, S.res?.params[p.name] != null ? fmt(S.res.params[p.name]) : ''),
      h('button', { class: 'x', onclick: () => change(() => S.doc.params.splice(i, 1)) }, '✕'))),
    h('h3', {}, 'Timeline'),
    S.doc.features.map((f, i) => h('div', { class: 'item' + (f.id === S.sel ? ' sel' : '') + (errs[f.id] ? ' err' : '') + (f.suppressed || i >= upTo ? ' off' : ''), title: errs[f.id] || '', onclick: () => { S.sel = f.id; panels(); drawScene(); }, ondblclick: () => f.type === 'sketch' && enterSketch(f.id) },
      h('span', { class: 'nm' }, f.name || f.id), h('span', { class: 'ty' }, FEATURES[f.type]?.label || f.type),
      h('button', { class: 'x', title: 'move up', onclick: (e) => { e.stopPropagation(); if (i) change(() => S.doc.features.splice(i - 1, 0, S.doc.features.splice(i, 1)[0])); } }, '↑'),
      h('button', { class: 'x', title: 'move down', onclick: (e) => { e.stopPropagation(); if (i < n - 1) change(() => S.doc.features.splice(i + 1, 0, S.doc.features.splice(i, 1)[0])); } }, '↓'),
      h('button', { class: 'x', title: 'suppress', onclick: (e) => { e.stopPropagation(); change(() => (f.suppressed = !f.suppressed)); } }, f.suppressed ? '○' : '●'),
      h('button', { class: 'x', title: 'delete', onclick: (e) => { e.stopPropagation(); change(() => { S.doc.features.splice(i, 1); if (S.sel === f.id) S.sel = null; if (S.sketch === f.id) { S.sketch = null; S.tool = null; } if (S.pick?.fid === f.id) S.pick = null; }); } }, '✕'))),
    n ? h('div', { class: 'row', title: 'Rollback bar: rebuild only the first N features' }, h('label', {}, `Rollback ${upTo}/${n}`), h('input', { type: 'range', min: 0, max: n, value: upTo, onchange: (e) => { S.upTo = +e.target.value >= n ? null : +e.target.value; rebuild(); } })) : h('div', { style: 'color:var(--dim)' }, 'Empty — add a Sketch or a primitive from the toolbar.'),
    h('h3', {}, 'Bodies'),
    (S.res?.bodies || []).map((b, i) => h('div', { class: 'item' + (S.hidden.has(b.name) ? ' off' : ''), title: `volume ${fmt(b.volume)} mm³\narea ${fmt(b.area)} mm²\nmass ${fmt(b.mass)} g (density ${b.density} g/cm³)\ncenter of mass ${b.com.map(fmt).join(', ')}\nsize ${[0, 1, 2].map((k) => fmt(b.bbox[1][k] - b.bbox[0][k])).join(' × ')} mm`, onclick: () => { S.hidden.has(b.name) ? S.hidden.delete(b.name) : S.hidden.add(b.name); panels(); drawScene(); } },
      h('span', { class: 'sw', style: `background:${b.color || PALETTE[i % PALETTE.length]}` }), h('span', { class: 'nm' }, b.name), h('span', { class: 'ty' }, `${fmt(b.volume / 1000)} cm³ · ${fmt(b.mass)} g`))));
  const f = feat(S.sel);
  $('right').replaceChildren(...(f ? [
    h('h3', {}, FEATURES[f.type]?.label || f.type, h('span', {}, f.id)),
    errs[f.id] ? h('div', { class: 'errbox' }, errs[f.id]) : null,
    h('div', { class: 'row' }, h('label', {}, 'name'), h('input', { value: f.name || '', placeholder: f.id, onchange: (e) => change(() => (f.name = e.target.value || undefined)) })),
    (FEATURES[f.type]?.fields || []).map((fl) => field(f, fl)),
  ] : [h('h3', {}, 'Properties'), h('div', { style: 'color:var(--dim)' }, 'Select a feature in the timeline to edit it. Any number accepts an expression using parameters, e.g. w/2 + 3.'),
    Object.entries(errs).map(([k, v]) => h('div', { class: 'errbox' }, h('b', {}, k + ': '), v))]).flat(9).filter(Boolean));
  $('tools').replaceChildren(...(S.sketch ? [...['path', 'rect', 'circle', 'polygon', 'slot'].map((t) => h('button', { class: S.tool === t ? 'on' : '', onclick: () => { S.tool = t; draft = null; clear(draftG); panels(); } }, t[0].toUpperCase() + t.slice(1))), h('button', { onclick: exitSketch }, '✓ Finish sketch')] : []));
  hint();
}
function dialog(title, body, actions = []) {
  const d = h('dialog', {}, h('h3', {}, title), body, h('div', { class: 'row', style: 'justify-content:flex-end' }, actions, h('button', { onclick: () => d.remove() }, 'Close')));
  document.body.append(d); d.showModal(); d.addEventListener('close', () => d.remove()); return d;
}
function download(name, data, type = 'application/octet-stream') { const a = h('a', { href: URL.createObjectURL(new Blob([data], { type })), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
async function exportAs(kind) { try { status('Exporting…'); download(`${S.doc.name || 'model'}.${kind}`, await call('export', kind), kind === 'svg' ? 'image/svg+xml' : undefined); status('Exported ' + kind.toUpperCase()); } catch (e) { status('Export failed: ' + e.message); } }
function loadDoc(d, keepUndo) { if (keepUndo) S.undo.push(JSON.stringify(S.doc)); S.doc = { name: 'untitled', params: [], features: [], ...d }; S.sel = S.sketch = S.pick = S.tool = null; S.upTo = null; panels(); return rebuild(); }
function toolbar() {
  const groups = {};
  for (const [t, f] of Object.entries(FEATURES)) (groups[f.group] ||= []).push(h('button', { onclick: () => addFeature(t) }, f.label));
  const sect = h('select', { style: 'width:auto', title: 'section view', onchange: (e) => { const a = e.target.value; renderer.clippingPlanes = a ? [clip] : []; if (a) { clip.normal.set(a === 'X' ? -1 : 0, a === 'Y' ? -1 : 0, a === 'Z' ? -1 : 0); const c = new THREE.Box3().setFromObject(bodyG).getCenter(new THREE.Vector3()); clip.constant = c[a.toLowerCase()]; } render(); } }, ['', 'X', 'Y', 'Z'].map((a) => h('option', { value: a }, a ? 'Section ' + a : 'No section')));
  const sectPos = h('input', { type: 'range', min: -200, max: 200, step: 0.5, value: 0, style: 'width:80px', title: 'section position', oninput: (e) => { clip.constant = +e.target.value; render(); } });
  const open = h('input', { type: 'file', accept: '.json', style: 'display:none', onchange: async (e) => { try { loadDoc(JSON.parse(await e.target.files[0].text()), true).then(fit); save(); } catch (err) { status('Could not open: ' + err.message); } } });
  const G = (name, ...b) => h('div', { class: 'grp' }, h('span', {}, name), b);
  fill('bar',h('b', {}, 'forgeCAD'),
    G('File', h('button', { onclick: () => { if (confirm('Start a new empty document?')) { loadDoc({}, true); save(); } } }, 'New'), h('button', { onclick: () => open.click() }, 'Open'), open, h('button', { onclick: () => download((S.doc.name || 'model') + '.json', JSON.stringify(S.doc, null, 1)) }, 'Save'),
      h('button', { onclick: () => exportAs('step') }, 'STEP'), h('button', { onclick: () => exportAs('stl') }, 'STL'), h('button', { title: '3-view drawing', onclick: () => exportAs('svg') }, 'Drawing')),
    G('Edit', h('button', { onclick: () => restore(S.undo, S.redo) }, 'Undo'), h('button', { onclick: () => restore(S.redo, S.undo) }, 'Redo')),
    Object.entries(groups).map(([g, b]) => G(g, b)),
    G('View', h('button', { onclick: fit }, 'Fit'), h('button', { onclick: () => view([1, -1.2, 0.9]) }, 'Iso'), h('button', { onclick: () => view([0, -1, 0]) }, 'Front'), h('button', { onclick: () => view([0, 0, 1], [0, 1, 0]) }, 'Top'), h('button', { onclick: () => view([1, 0, 0]) }, 'Right'), sect, sectPos),
    G('Tools', h('button', { onclick: async () => { const r = await call('interference'); dialog('Interference check', h('pre', {}, r.length ? r.map((x) => `${x.a} ∩ ${x.b}: ${fmt(x.volume)} mm³`).join('\n') : 'No interference between visible bodies.')); } }, 'Interference'),
      h('button', { title: 'Edit the document as JSON · feature reference · MCP setup', onclick: aiPanel }, 'JSON / AI')));
}
function aiPanel() {
  const ta = h('textarea', { value: JSON.stringify(S.doc, null, 1), spellcheck: false });
  const d = dialog('Document JSON — the same file the CLI and MCP server edit', [ta, h('details', {}, h('summary', {}, 'Feature reference (what an AI agent reads via the `schema` tool)'), h('pre', { style: 'height:30vh' }, docs() + '\nMCP: node bin/forge.js mcp <doc.json>   ·   CLI: node bin/forge.js'))],
    [h('button', { class: 'on', onclick: () => { try { loadDoc(JSON.parse(ta.value), true); save(); d.remove(); } catch (e) { alert('Invalid JSON: ' + e.message); } } }, 'Apply')]);
}
addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea,select')) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? restore(S.redo, S.undo) : restore(S.undo, S.redo); }
  else if (e.key === 'Escape') { if (draft) { draft = null; clear(draftG); render(); } else if (S.pick) { S.pick = null; panels(); rebuild(); } else if (S.sketch) exitSketch(); hint(); }
  else if (e.key === 'Enter' && draft && S.tool === 'path') finishPath(!e.shiftKey);
  else if (e.key === 'f') fit();
});

// ---------- boot ----------
toolbar(); panels(); resize();
(async () => {
  let d = null;
  try { const r = await fetch('/api/doc'); if (r.ok && r.headers.get('x-forge-doc')) { const t = await r.text(); d = JSON.parse(t); S.server = true; S.lastSaved = t; } } catch {}
  if (!d) try { d = JSON.parse(localStorage.getItem('forge-doc')); } catch {}
  await loadDoc(d || {}); view([1, -1.2, 0.9]);
  if (S.server) new EventSource('/api/events').onmessage = async () => { // live reload when the CLI / an AI agent edits the file
    const t = await (await fetch('/api/doc')).text();
    if (t !== S.lastSaved && t !== JSON.stringify(S.doc, null, 1)) { S.lastSaved = t; try { const keep = S.sel; await loadDoc(JSON.parse(t), true); if (feat(keep)) { S.sel = keep; panels(); } status('Reloaded — document changed on disk'); } catch {} }
  };
})();
