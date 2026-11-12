import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FEATURES, defaults, docs, normalize } from './schema.js';
import { listPoints, pointOf } from './solver.js';
import './style.css';

// ---------- tiny DOM helpers ----------
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k in e && k !== 'list') e[k] = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids.flat(9).filter((x) => x != null && x !== false));
  return e;
};
const $ = (id) => document.getElementById(id);
const fill = (id, ...kids) => $(id).replaceChildren(...kids.flat(9).filter((x) => x != null && x !== false));
const status = (s) => ($('status').textContent = s);
const fmt = (x) => (Math.abs(x) >= 1e5 ? x.toExponential(3) : +x.toFixed(3));
const uid = (list, pre) => { let i = 1; while (list.some((x) => x.id === pre + i)) i++; return pre + i; };

// ---------- kernel worker ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let rid = 0;
const pending = new Map();
worker.onmessage = ({ data }) => { const p = pending.get(data.id); pending.delete(data.id); data.error ? p.rej(Error(data.error)) : p.res(data.result); };
const call = (cmd, ...args) => new Promise((res, rej) => { pending.set(++rid, { res, rej }); worker.postMessage({ id: rid, cmd, args }); });

// ---------- state ----------
const S = { doc: normalize({ name: 'untitled' }), tab: null, res: null, sel: null, upTo: null, undo: [], redo: [], pick: null, sketch: null, tool: null, skSel: [], face: null, hidden: new Set(), server: false, lastSaved: '' };
const isAsm = () => S.tab?.kind === 'assembly';
const cur = () => (isAsm() ? S.doc.assemblies : S.doc.studios).find((x) => x.id === S.tab?.id);
const F = () => (isAsm() ? [] : cur()?.features) || [];
const feat = (id) => F().find((f) => f.id === id);
const idx = (id) => F().findIndex((f) => f.id === id);
const asmItem = (id) => isAsm() && [...cur().instances, ...cur().mates].find((x) => x.id === id);
function fixState() { if (!cur()) S.tab = { kind: 'studio', id: S.doc.studios[0].id }; if (!feat(S.sel) && !asmItem(S.sel)) S.sel = null; if (!feat(S.sketch)) { S.sketch = S.tool = null; } if (S.pick?.fid && !feat(S.pick.fid)) S.pick = null; }

function change(fn) { S.undo.push(JSON.stringify(S.doc)); if (S.undo.length > 200) S.undo.shift(); S.redo = []; fn && fn(); return dirty(); }
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
function restore(from, to) { if (!from.length) return; to.push(JSON.stringify(S.doc)); S.doc = normalize(JSON.parse(from.pop())); fixState(); dirty(); }

let building = false, again = false, buildP = null;
function rebuild() { if (building) { again = true; return buildP; } return (buildP = build()); }
async function build() {
  building = true;
  do {
    again = false; status('Rebuilding…');
    const opts = isAsm() ? { assembly: S.tab.id } : { studio: S.tab.id, upTo: S.pick?.fid ? idx(S.pick.fid) : S.sketch ? idx(S.sketch) + 1 : S.upTo ?? undefined };
    try {
      S.res = await call('evaluate', S.doc, opts); S.face = null;
      writeBack(); drawScene(); panels();
      const n = Object.keys(S.res.errors).length;
      status(`${S.res.bodies.length} bodies · ${isAsm() ? cur().instances.length + ' instances' : F().length + ' features'} · ${S.res.ms} ms` + (n ? ` · ${n} error${n > 1 ? 's' : ''}` : ''));
    } catch (e) { status('Kernel error: ' + e.message); }
  } while (again);
  building = false;
}
// Store solved sketch coordinates back into the document so the next solve starts from the solution.
function writeBack() {
  let ch = false;
  const cp = (r, s) => { for (const k in r) { if (typeof r[k] === 'number' && typeof s?.[k] === 'number') { const v = +s[k].toFixed(6); if (Math.abs(v - r[k]) > 1e-9) { r[k] = v; ch = true; } } else if (r[k] && typeof r[k] === 'object') cp(r[k], s?.[k]); } };
  for (const [id, sk] of Object.entries(S.res.sketches || {})) { const f = feat(id); if (f?.constraints?.length && sk.solve?.ok) f.entities.forEach((e, i) => cp(e, sk.entities[i])); }
  if (ch) save();
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
const bodyG = new THREE.Group(), sketchG = new THREE.Group(), hlG = new THREE.Group(), selG = new THREE.Group(), markG = new THREE.Group(), draftG = new THREE.Group();
scene.add(bodyG, sketchG, selG, hlG, markG, draftG);
const clip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
function render() { renderer.render(scene, camera); }
function resize() { const r = canvas.parentElement.getBoundingClientRect(); renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); render(); }
new ResizeObserver(resize).observe(canvas.parentElement);

const PALETTE = ['#8fa3b8', '#c9a26b', '#7fb58a', '#b58fb8', '#b8a08f', '#8fb8b5', '#b88f8f', '#a3a86e'];
const clear = (g) => { for (const c of [...g.children]) { c.geometry?.dispose(); g.remove(c); } };
const dots = (group, pts, color, size) => { if (!pts.length) return; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3)); group.add(new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false }))); };
const mApply = (M, p) => [0, 1, 2].map((i) => M[i][0] * p[0] + M[i][1] * p[1] + M[i][2] * p[2] + M[i][3]);
const mInv = (M, p) => { const d = p.map((c, i) => c - M[i][3]); return [0, 1, 2].map((i) => M[0][i] * d[0] + M[1][i] * d[1] + M[2][i] * d[2]); };
function drawScene() {
  clear(bodyG); clear(sketchG); clear(markG); clear(selG); clear(hlG);
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
  const used = new Set(F().flatMap((f) => [f.sketch, f.profile, f.path, ...(f.sketches || [])]));
  for (const [id, sk] of Object.entries(S.res?.sketches || {})) {
    const active = id === S.sketch;
    if (!active && id !== S.sel && used.has(id)) continue;
    sk.entities.forEach((e, i) => addPoly(sketchG, sk.frame, entPts(e), !active ? 0x5a7fa8 : S.skSel.some((r) => r[0] === i && r[1] === 'e') ? 0xffb84f : e.mode === 'cut' ? 0xff8f6b : 0x6bd0ff));
    if (active) {
      const P = (r) => to3(sk.frame, pointOf(sk.entities, r));
      dots(markG, listPoints(sk.entities).map(P), 0xcfe8ff, 6);
      dots(markG, S.skSel.filter((r) => r[1] !== 'e').map(P), 0xffb84f, 12);
    }
  }
  const f = feat(S.sel), m = isAsm() && cur().mates.find((x) => x.id === S.sel);
  if (f) dots(markG, [...(f.edges?.points || []), ...(f.faces?.points || []), ...(f.points || [])].filter((p) => p.every((c) => typeof c === 'number')), 0xffb84f, 9);
  if (m) dots(markG, [m.a, m.b].filter((c) => S.res?.instances?.[c?.inst]).map((c) => mApply(S.res.instances[c.inst], c.point)), 0xffb84f, 11);
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
  const useEdge = eh && (want ? want === 'edges' : true) && (!fh || want === 'edges' || eh.distance < fh.distance + thr * 2);
  const hit = useEdge ? eh : fh; if (!hit) return null;
  const b = hit.object.userData.body, kind = hit.object.userData.kind, i = kind === 'face' ? hit.faceIndex * 3 : hit.index;
  const group = (kind === 'face' ? b.faceGroups : b.edgeGroups).find((g) => i >= g.start && i < g.start + g.count);
  return group && { kind, body: b, group, point: hit.point.toArray(), obj: hit.object };
}
function highlight(hit, G = hlG, color = 0xffb84f) {
  clear(G);
  if (hit) {
    const g = hit.group, geo = new THREE.BufferGeometry(), src = hit.obj.geometry;
    if (hit.kind === 'face') { geo.setAttribute('position', src.attributes.position); geo.setIndex(new THREE.BufferAttribute(src.index.array.subarray(g.start, g.start + g.count), 1)); G.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }))); }
    else { geo.setAttribute('position', new THREE.BufferAttribute(src.attributes.position.array.subarray(g.start * 3, (g.start + g.count) * 3), 3)); G.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false }))); }
  }
  render();
}
let lastPt = null;
function showInfo(hit) {
  const g = hit.group, d = lastPt ? `  ·  distance from last pick ${fmt(Math.hypot(...hit.point.map((c, i) => c - lastPt[i])))} mm` : '';
  $('info').textContent = (hit.kind === 'face' ? `${hit.body.name} · ${g.type || 'face'} · area ${fmt(g.area || 0)} mm²` : `${hit.body.name} · ${g.type || 'edge'} · length ${fmt(g.length || 0)} mm`) + `  ·  (${hit.point.map(fmt).join(', ')})` + d;
  lastPt = hit.point;
}
const r4 = (p) => p.map((c) => +c.toFixed(4));
function applyPick(hit) {
  const { fid, key, kind } = S.pick;
  if (kind === 'mate') {
    if (hit.kind !== 'face' || !hit.body.inst) return;
    const c = { inst: hit.body.inst, point: r4(mInv(S.res.instances[hit.body.inst], hit.group.key)) };
    if (!S.pick.a) { S.pick.a = c; highlight(hit, selG, 0x51cf66); return hint(); }
    if (S.pick.a.inst === c.inst) return status('Pick a face on a different instance');
    const m = { id: uid(cur().mates, 'mate'), k: S.pick.k, a: S.pick.a, b: c, angle: 0, offset: 0, flip: false };
    return change(() => { cur().mates.push(m); S.sel = m.id; S.pick = null; });
  }
  const f = feat(fid); if (!f) return;
  if (kind === 'plane') { if (hit.kind === 'face') change(() => { f.plane = { face: { body: hit.body.name, point: r4(hit.group.key) } }; S.pick = null; }); return; }
  if (kind === 'points') { change(() => { f[key] = [...(f[key] || []), r4(hit.point)]; if ('body' in f && !f.body) f.body = hit.body.name; }); return; }
  if ((kind === 'edges') !== (hit.kind === 'edge') || !hit.group.key) return;
  change(() => {
    const curp = f[key] && typeof f[key] === 'object' ? f[key].points || [] : [], k = r4(hit.group.key);
    const j = curp.findIndex((p) => Math.hypot(...p.map((c, i) => c - k[i])) < 1e-3);
    f[key] = { points: j >= 0 ? curp.filter((_, i) => i !== j) : [...curp, k] };
    f.body = hit.body.name;
  });
}
let down = null;
canvas.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.button !== 0) return;
  if (S.sketch && S.tool) return S.tool === 'select' ? selectAt(sketchPt(e, true)) : sketchClick(sketchPt(e));
  const hit = pickAt(e);
  if (S.pick) return hit && applyPick(hit);
  S.face = hit?.kind === 'face' ? hit : null; highlight(S.face, selG, 0x4f9dff);
  if (hit) { showInfo(hit); if (hit.body.inst) { S.sel = hit.body.inst; panels(); } }
  hint();
});
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  if (S.sketch && S.tool) { const p = sketchPt(e); if (p) { $('info').textContent = `u ${fmt(p[0])}  v ${fmt(p[1])}`; if (S.tool !== 'select') preview(p); } return; }
  highlight(pickAt(e));
});

// ---------- sketch mode ----------
let draft = null;
function sketchPt(ev, raw) {
  const fr = S.res?.sketches[S.sketch]?.frame; if (!fr) return null;
  setRay(ev);
  const o = new THREE.Vector3(...fr.o), hit = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...fr.z), o), new THREE.Vector3());
  if (!hit) return null;
  const d = hit.sub(o), step = raw || ev.altKey ? 0.001 : ev.shiftKey ? 0.1 : 1, sn = (x) => +(Math.round(x / step) * step).toFixed(4);
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
  if (e.t !== 'path' && (!(entPts(e).length > 2) || (e.r ?? e.w ?? 1) <= 0 || (e.h ?? 1) <= 0)) return;
  // a closed shape drawn fully inside an existing one becomes a hole
  if (e.closed !== false) { const n = bbox(entPts(e)); for (const o of S.res?.sketches[S.sketch]?.entities || []) { if (o.mode === 'cut' || o.closed === false) continue; const q = bbox(entPts(o)); if (n[0] > q[0] && n[1] > q[1] && n[2] < q[2] && n[3] < q[3]) e.mode = 'cut'; } }
  change(() => feat(S.sketch).entities.push(e));
}
function sketchClick(p) {
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
async function enterSketch(id) { S.sketch = id; S.sel = id; S.pick = null; S.tool = 'path'; S.skSel = []; draft = null; await rebuild(); lookAtSketch(id); panels(); }
async function exitSketch() { S.sketch = null; S.tool = null; S.skSel = []; draft = null; clear(draftG); await rebuild(); panels(); }
// --- constraints: select points / circles, then apply ---
function selectAt(p) {
  const sk = S.res?.sketches[S.sketch]; if (!sk || !p) return;
  let best = null, bd = camera.position.distanceTo(controls.target) * 0.012;
  for (const ref of listPoints(sk.entities)) { const q = pointOf(sk.entities, ref), d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = ref; } }
  if (!best) sk.entities.forEach((e, i) => { if (e.r == null || e.t === 'rect') return; const d = Math.abs(Math.hypot(p[0] - (e.cx || 0), p[1] - (e.cy || 0)) - e.r); if (d < bd) { bd = d; best = [i, 'e']; } });
  if (!best) S.skSel = []; else { const j = S.skSel.findIndex((r) => r[0] === best[0] && r[1] === best[1]); j >= 0 ? S.skSel.splice(j, 1) : S.skSel.push(best); }
  drawScene(); panels();
}
const CONS = { coincident: '2 points', horizontal: '2 points', vertical: '2 points', distance: '2 points', fix: '1 or more points', parallel: '4 points (line 1, then line 2)', perpendicular: '4 points (line 1, then line 2)', equal: '4 points (line 1, then line 2)', angle: '4 points (line 1, then line 2)', midpoint: '3 points (the midpoint, then both ends)', onLine: '3 points (the point, then the line)', radius: '1 circle', equalRadius: '2 circles', onCircle: '1 point + 1 circle', tangent: '2 points (a line) + 1 circle' };
function constrain(k) {
  const E = S.res?.sketches[S.sketch]?.entities, f = feat(S.sketch); if (!E || !f) return;
  const P = S.skSel.filter((r) => r[1] !== 'e'), C = S.skSel.filter((r) => r[1] === 'e').map((r) => r[0]), pt = (r) => pointOf(E, r), need = (np, nc) => P.length === np && C.length === nc;
  const [a, b, c, d] = P; let add;
  if (['coincident', 'horizontal', 'vertical'].includes(k) && need(2, 0)) add = [{ k, a, b }];
  else if (k === 'distance' && need(2, 0)) add = [{ k, a, b, v: +Math.hypot(pt(a)[0] - pt(b)[0], pt(a)[1] - pt(b)[1]).toFixed(3) }];
  else if (k === 'fix' && P.length && !C.length) add = P.map((q) => ({ k, a: q, x: +pt(q)[0].toFixed(4), y: +pt(q)[1].toFixed(4) }));
  else if (['parallel', 'perpendicular', 'equal'].includes(k) && need(4, 0)) add = [{ k, a, b, c, d }];
  else if (k === 'angle' && need(4, 0)) { const u = [pt(b)[0] - pt(a)[0], pt(b)[1] - pt(a)[1]], v = [pt(d)[0] - pt(c)[0], pt(d)[1] - pt(c)[1]]; add = [{ k, a, b, c, d, v: +(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]) / D).toFixed(2) }]; }
  else if (['midpoint', 'onLine'].includes(k) && need(3, 0)) add = [{ k, a, b, c }];
  else if (k === 'radius' && need(0, 1)) add = [{ k, e: C[0], v: +E[C[0]].r.toFixed(3) }];
  else if (k === 'equalRadius' && need(0, 2)) add = [{ k, e: C[0], f: C[1] }];
  else if (k === 'onCircle' && need(1, 1)) add = [{ k, a, e: C[0] }];
  else if (k === 'tangent' && need(2, 1)) add = [{ k, a, b, e: C[0] }];
  else return status(`${k}: select ${CONS[k]} with the Select tool first`);
  S.skSel = []; change(() => (f.constraints ||= []).push(...add));
}
function dropEntity(f, i) {
  const hit = (c) => ['a', 'b', 'c', 'd'].some((k) => Array.isArray(c[k]) && c[k][0] === i) || c.e === i || c.f === i;
  f.constraints = (f.constraints || []).filter((c) => !hit(c));
  for (const c of f.constraints) { for (const k of ['a', 'b', 'c', 'd']) if (Array.isArray(c[k]) && c[k][0] > i) c[k] = [c[k][0] - 1, c[k][1]]; for (const k of ['e', 'f']) if (typeof c[k] === 'number' && c[k] > i) c[k]--; }
  f.entities.splice(i, 1); S.skSel = [];
}
function hint() {
  $('hint').textContent = S.pick?.kind === 'mate' ? (S.pick.a ? 'Mate: now click a face on the instance that should MOVE' : 'Mate: click a face on the instance that stays put') + ' · Esc cancels'
    : S.pick ? `Picking ${S.pick.kind} — click the model (click again to deselect), Esc when done. The model is shown as it was before this feature.`
    : S.sketch ? (S.tool === 'select' ? 'Select: click points or circles, then a constraint button · click empty space to clear' : S.tool === 'path' ? 'Path: click points · click the first point or Enter to close · Shift+Enter leaves it open (sweep path)' : `${S.tool}: click two points`) + ' · snap 1 mm (Shift 0.1, Alt off) · Esc exits'
    : isAsm() ? 'Insert part-studio bodies, then mate faces together · click an instance to edit it'
    : S.face ? 'Face selected — Sketch will start on this face' : 'Left-drag orbit · right-drag pan · wheel zoom · click a face/edge to measure or select';
}

// ---------- features ----------
function addFeature(type) {
  const f = defaults(type), face = S.face;
  S.sketch = S.tool = S.pick = draft = null; clear(draftG);
  f.id = uid(F(), type);
  const before = F().slice(0, S.upTo ?? undefined), lastSk = before.filter((x) => x.type === 'sketch').pop(), bodies = (S.res?.bodies || []).map((b) => b.name);
  for (const [k, kind] of FEATURES[type].fields) {
    if (kind === 'sketch' && lastSk) f[k] = lastSk.id;
    if (kind === 'body' && k !== 'target') f[k] = f.op === 'new' ? '' : face?.body.name || bodies[bodies.length - 1] || '';
  }
  if (type === 'sketch' && face?.group.type === 'PLANE') f.plane = { face: { body: face.body.name, point: r4(face.group.key) } };
  if (type === 'sweep') { const sk = before.filter((x) => x.type === 'sketch'); f.path = sk.find((s) => s.entities.some((e) => e.closed === false))?.id || ''; f.profile = sk.filter((s) => s.id !== f.path).pop()?.id || ''; }
  if (type === 'loft') f.sketches = before.filter((x) => x.type === 'sketch').slice(-2).map((s) => s.id);
  change(() => { F().splice(S.upTo ?? F().length, 0, f); if (S.upTo != null) S.upTo++; S.sel = f.id; });
  if (type === 'sketch') enterSketch(f.id);
}
const parseNum = (v) => (v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : v.trim());
const parseJSON = (v) => { try { return JSON.parse(v); } catch { return v; } };
const numIn = (val, set) => h('input', { value: val ?? '', onchange: (e) => set(parseNum(e.target.value)) });
const vecIn = (val, set) => [0, 1, 2].map((i) => h('input', { value: (Array.isArray(val) ? val : [0, 0, 0])[i], onchange: (e) => { const a = [...(Array.isArray(val) ? val : [0, 0, 0])]; a[i] = parseNum(e.target.value); set(a); } }));
const row = (label, ...ctl) => h('div', { class: 'row' }, h('label', {}, label), ctl);
function field(f, [k, kind, , help]) {
  const set = (v) => change(() => (f[k] = v)), val = f[k];
  const pickBtn = (pk) => h('button', { class: S.pick?.fid === f.id && S.pick.key === k ? 'on' : '', onclick: () => { S.pick = S.pick?.key === k && S.pick.fid === f.id ? null : { fid: f.id, key: k, kind: pk }; panels(); rebuild(); } }, 'Pick');
  const bodies = (S.res?.bodies || []).map((b) => b.name), sks = F().filter((x) => x.type === 'sketch').map((x) => x.id);
  const sel = (opts) => h('select', { onchange: (e) => set(e.target.value) }, [...new Set(['', ...opts, typeof val === 'string' ? val : ''])].map((o) => h('option', { value: o, selected: o === val }, o || '—')));
  let ctl;
  if (kind === 'num') ctl = numIn(val, set);
  else if (kind === 'vec') ctl = vecIn(val, set);
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
  else if (kind === 'constraints') return null;
  else ctl = h('input', { value: val ?? '', onchange: (e) => set(e.target.value) });
  return h('div', { class: 'row', title: help || '' }, h('label', {}, k), ctl);
}
function entities(f) {
  const editing = S.sketch === f.id, sv = S.res?.sketches[f.id]?.solve, refs = (c) => ['a', 'b', 'c', 'd'].filter((k) => c[k]).map((k) => `${c[k][0]}:${c[k][1]}`).concat(['e', 'f'].filter((k) => c[k] != null).map((k) => '○' + c[k])).join('  ');
  return [h('div', { class: 'row' }, h('button', { class: editing ? 'on' : '', onclick: () => (editing ? exitSketch() : enterSketch(f.id)) }, editing ? '✓ Finish sketch' : '✎ Edit sketch'), h('span', {}, `${f.entities.length} entities`)),
    f.entities.map((e, i) => h('div', { class: 'ent' },
      h('div', { class: 'row' }, h('b', { style: 'flex:1' }, `${i} · ${e.t}`), e.closed === false ? h('span', {}, 'open') : h('button', { class: e.mode === 'cut' ? 'on' : '', title: 'subtract from the profile (hole)', onclick: () => change(() => (e.mode = e.mode === 'cut' ? 'add' : 'cut')) }, 'hole'), h('button', { class: 'x', onclick: () => change(() => dropEntity(f, i)) }, '✕')),
      Object.keys(e).filter((k) => !['t', 'mode'].includes(k)).map((k) => row(k, h('input', { value: typeof e[k] === 'object' || typeof e[k] === 'boolean' ? JSON.stringify(e[k]) : e[k], onchange: (ev) => change(() => (e[k] = typeof e[k] === 'object' || typeof e[k] === 'boolean' ? parseJSON(ev.target.value) : parseNum(ev.target.value))) }))))),
    h('h3', {}, 'Constraints', sv ? h('span', { style: `color:var(--${sv.ok ? (sv.dof ? 'dim' : 'ok') : 'err'})` }, !sv.ok ? 'conflict' : sv.dof ? `${sv.dof} DOF free` : 'fully defined') : null),
    (f.constraints || []).length ? null : h('div', { style: 'color:var(--dim)' }, 'None. In the sketch, use Select to pick points/circles, then a constraint.'),
    (f.constraints || []).map((c, i) => h('div', { class: 'row', title: JSON.stringify(c) }, h('label', {}, c.k), 'v' in c ? numIn(c.v, (v) => change(() => (c.v = v))) : h('span', { style: 'flex:1;color:var(--dim)' }, refs(c)), h('button', { class: 'x', onclick: () => change(() => f.constraints.splice(i, 1)) }, '✕')))];
}

// ---------- tabs (part studios + assemblies) ----------
async function switchTab(kind, id) { S.tab = { kind, id }; S.sel = S.sketch = S.pick = S.tool = S.face = null; S.upTo = null; S.skSel = []; draft = null; clear(draftG); panels(); await rebuild(); fit(); }
function addTab(kind) {
  const list = kind === 'studio' ? S.doc.studios : S.doc.assemblies, id = uid(list, kind), name = `${kind === 'studio' ? 'Part Studio' : 'Assembly'} ${list.length + 1}`;
  change(() => list.push(kind === 'studio' ? { id, name, features: [] } : { id, name, instances: [], mates: [] })); switchTab(kind, id);
}
function tabs() {
  const tab = (kind, x, icon) => h('div', { class: 'tab' + (S.tab.kind === kind && S.tab.id === x.id ? ' on' : ''), title: 'double-click to rename', onclick: () => switchTab(kind, x.id), ondblclick: () => { const n = prompt('Rename', x.name); if (n) change(() => (x.name = n)); } }, icon + ' ' + (x.name || x.id),
    h('button', { class: 'x', title: 'delete', onclick: (e) => { e.stopPropagation(); if (kind === 'studio' && S.doc.studios.length < 2) return status('A document needs at least one part studio'); if (!confirm(`Delete "${x.name}"?`)) return; change(() => { const l = kind === 'studio' ? S.doc.studios : S.doc.assemblies; l.splice(l.indexOf(x), 1); fixState(); }); } }, '✕'));
  fill('tabs', S.doc.studios.map((s) => tab('studio', s, '◧')), S.doc.assemblies.map((a) => tab('assembly', a, '⚙')), h('button', { onclick: () => addTab('studio') }, '＋ Part Studio'), h('button', { onclick: () => addTab('assembly') }, '＋ Assembly'));
}

// ---------- panels ----------
function panels() {
  fixState();
  const errs = S.res?.errors || {}, asm = isAsm();
  const params = [h('h3', {}, 'Parameters', h('button', { class: 'x', title: 'add parameter', onclick: () => change(() => S.doc.params.push({ name: uid(S.doc.params.map((p) => ({ id: p.name })), 'p'), expr: '10' })) }, '＋')),
    S.doc.params.map((p, i) => h('div', { class: 'row', title: errs['param:' + p.name] || '' },
      h('input', { value: p.name, style: 'width:70px;flex:none', onchange: (e) => change(() => (p.name = e.target.value.trim())) }),
      h('input', { value: p.expr, style: errs['param:' + p.name] ? 'border-color:var(--err)' : '', onchange: (e) => change(() => (p.expr = e.target.value)) }),
      h('span', { style: 'width:44px;flex:none;color:var(--dim);text-align:right' }, S.res?.params[p.name] != null ? fmt(S.res.params[p.name]) : ''),
      h('button', { class: 'x', onclick: () => change(() => S.doc.params.splice(i, 1)) }, '✕')))];
  const item = (x, label, type, list, extra = {}) => { const i = list.indexOf(x); return h('div', { class: 'item' + (x.id === S.sel ? ' sel' : '') + (errs[x.id] ? ' err' : '') + (x.suppressed || extra.off ? ' off' : ''), title: errs[x.id] || '', onclick: () => { S.sel = x.id; panels(); drawScene(); }, ondblclick: extra.dbl },
    h('span', { class: 'nm' }, label), h('span', { class: 'ty' }, type),
    extra.move ? [h('button', { class: 'x', title: 'move up', onclick: (e) => { e.stopPropagation(); if (i) change(() => list.splice(i - 1, 0, list.splice(i, 1)[0])); } }, '↑'), h('button', { class: 'x', title: 'move down', onclick: (e) => { e.stopPropagation(); if (i < list.length - 1) change(() => list.splice(i + 1, 0, list.splice(i, 1)[0])); } }, '↓')] : null,
    'suppressed' in extra ? h('button', { class: 'x', title: 'suppress', onclick: (e) => { e.stopPropagation(); change(() => (x.suppressed = !x.suppressed)); } }, x.suppressed ? '○' : '●') : null,
    h('button', { class: 'x', title: 'delete', onclick: (e) => { e.stopPropagation(); change(() => { list.splice(i, 1); if (extra.del) extra.del(); fixState(); }); } }, '✕')); };
  const bodies = [h('h3', {}, asm ? 'Parts' : 'Bodies'), (S.res?.bodies || []).map((b, i) => h('div', { class: 'item' + (S.hidden.has(b.name) ? ' off' : ''), title: `click to show/hide\nvolume ${fmt(b.volume)} mm³\narea ${fmt(b.area)} mm²\nmass ${fmt(b.mass)} g (density ${b.density} g/cm³)\ncenter of mass ${b.com.map(fmt).join(', ')}\nsize ${[0, 1, 2].map((k) => fmt(b.bbox[1][k] - b.bbox[0][k])).join(' × ')} mm`, onclick: () => { S.hidden.has(b.name) ? S.hidden.delete(b.name) : S.hidden.add(b.name); panels(); drawScene(); } },
    h('span', { class: 'sw', style: `background:${b.color || PALETTE[i % PALETTE.length]}` }), h('span', { class: 'nm' }, b.name), h('span', { class: 'ty' }, `${fmt(b.volume / 1000)} cm³ · ${fmt(b.mass)} g`)))];
  if (asm) {
    const a = cur();
    fill('left', params, h('h3', {}, 'Instances'), a.instances.length ? a.instances.map((x) => item(x, x.id, x.studio + (x.body ? ' / ' + x.body : ''), a.instances, { del: () => (a.mates = a.mates.filter((m) => m.a.inst !== x.id && m.b.inst !== x.id)) })) : h('div', { style: 'color:var(--dim)' }, 'Empty — use Insert in the ribbon to add part-studio bodies.'),
      h('h3', {}, 'Mates'), a.mates.length ? a.mates.map((m) => item(m, m.id, `${m.k} · ${m.a.inst} ← ${m.b.inst}`, a.mates, { suppressed: 1, move: 1 })) : h('div', { style: 'color:var(--dim)' }, 'None — pick a mate type, then one face on each instance.'), bodies);
  } else {
    const n = F().length, upTo = S.upTo ?? n;
    fill('left', params, h('h3', {}, 'Features'),
      F().map((f, i) => item(f, f.name || f.id, FEATURES[f.type]?.label || f.type, F(), { suppressed: 1, move: 1, off: i >= upTo, dbl: () => f.type === 'sketch' && enterSketch(f.id) })),
      n ? h('div', { class: 'row', title: 'Rollback bar: rebuild only the first N features' }, h('label', {}, `Rollback ${upTo}/${n}`), h('input', { type: 'range', min: 0, max: n, value: upTo, onchange: (e) => { S.upTo = +e.target.value >= n ? null : +e.target.value; rebuild(); } })) : h('div', { style: 'color:var(--dim)' }, 'Empty — start with Sketch, or add a primitive from the ribbon.'), bodies);
  }
  // properties
  const f = feat(S.sel), it = asmItem(S.sel), set = (o, k) => (v) => change(() => (o[k] = v));
  let props;
  if (f) props = [h('h3', {}, FEATURES[f.type]?.label || f.type, h('span', {}, f.id)), errs[f.id] ? h('div', { class: 'errbox' }, errs[f.id]) : null,
    row('name', h('input', { value: f.name || '', placeholder: f.id, onchange: (e) => change(() => (f.name = e.target.value || undefined)) })), (FEATURES[f.type]?.fields || []).map((fl) => field(f, fl))];
  else if (it && 'studio' in it) { const names = S.res?.studioBodies?.[it.studio] || [];
    props = [h('h3', {}, 'Instance', h('span', {}, it.id)), errs[it.id] ? h('div', { class: 'errbox' }, errs[it.id]) : null,
      row('studio', h('select', { onchange: (e) => change(() => { it.studio = e.target.value; it.body = ''; }) }, S.doc.studios.map((s) => h('option', { value: s.id, selected: s.id === it.studio }, s.name)))),
      row('body', h('select', { onchange: (e) => set(it, 'body')(e.target.value) }, ['', ...names].map((b) => h('option', { value: b, selected: b === (it.body || '') }, b || 'all bodies')))),
      row('translate', vecIn(it.translate, set(it, 'translate'))), row('rotate', vecIn(it.rotate, set(it, 'rotate'))),
      h('div', { class: 'help' }, 'Base position (mm, degrees about X/Y/Z). A mate that moves this instance overrides it.')]; }
  else if (it) props = [h('h3', {}, 'Mate', h('span', {}, it.id)), errs[it.id] ? h('div', { class: 'errbox' }, errs[it.id]) : null,
    row('type', h('select', { onchange: (e) => set(it, 'k')(e.target.value) }, ['fasten', 'revolute', 'slider', 'cylindrical'].map((k) => h('option', { value: k, selected: k === it.k }, k)))),
    row('fixed', h('span', {}, it.a.inst)), row('moves', h('span', {}, it.b.inst)),
    row('angle', numIn(it.angle, set(it, 'angle'))), typeof it.angle === 'number' ? row('', h('input', { type: 'range', min: -180, max: 180, value: it.angle, title: 'drag to rotate about the mate axis', onchange: (e) => set(it, 'angle')(+e.target.value) })) : null,
    row('offset', numIn(it.offset, set(it, 'offset'))), row('flip', h('input', { type: 'checkbox', checked: !!it.flip, onchange: (e) => set(it, 'flip')(e.target.checked) })),
    h('div', { class: 'help' }, 'The two picked faces are made coincident at their centroids, normals opposed; angle turns the moving part about that axis, offset slides it along it.')];
  else props = [h('h3', {}, 'Properties'), h('div', { style: 'color:var(--dim)' }, asm ? 'Select an instance or mate to edit it.' : 'Select a feature to edit it. Any number accepts an expression using parameters, e.g. w/2 + 3.'),
    Object.entries(errs).map(([k, v]) => h('div', { class: 'errbox' }, h('b', {}, k + ': '), v))];
  fill('right', props);
  ribbon(); tabs(); hint();
}
function dialog(title, body, actions = []) {
  const d = h('dialog', {}, h('h3', {}, title), body, h('div', { class: 'row', style: 'justify-content:flex-end' }, actions, h('button', { onclick: () => d.remove() }, 'Close')));
  document.body.append(d); d.showModal(); d.addEventListener('close', () => d.remove()); return d;
}
function download(name, data, type = 'application/octet-stream') { const a = h('a', { href: URL.createObjectURL(new Blob([data], { type })), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
async function exportAs(kind) { try { status('Exporting…'); download(`${cur()?.name || S.doc.name || 'model'}.${kind}`, await call('export', kind), kind === 'svg' ? 'image/svg+xml' : undefined); status('Exported ' + kind.toUpperCase()); } catch (e) { status('Export failed: ' + e.message); } }
function loadDoc(d, keepUndo) { if (keepUndo) S.undo.push(JSON.stringify(S.doc)); S.doc = normalize({ name: 'untitled', ...d }); S.sel = S.sketch = S.pick = S.tool = null; S.upTo = null; fixState(); panels(); return rebuild(); }
const G = (name, ...b) => h('div', { class: 'grp' }, h('div', { class: 'btns' }, b), h('span', {}, name));
function menu() {
  const open = h('input', { type: 'file', accept: '.json', style: 'display:none', onchange: async (e) => { try { loadDoc(JSON.parse(await e.target.files[0].text()), true).then(fit); save(); } catch (err) { status('Could not open: ' + err.message); } } });
  fill('menu', h('b', {}, 'forgeCAD'), h('input', { value: S.doc.name || '', title: 'document name', style: 'width:150px', onchange: (e) => change(() => (S.doc.name = e.target.value)) }),
    h('button', { onclick: () => { if (confirm('Start a new empty document?')) { loadDoc({}, true); save(); } } }, 'New'), h('button', { onclick: () => open.click() }, 'Open'), open, h('button', { onclick: () => download((S.doc.name || 'model') + '.json', JSON.stringify(S.doc, null, 1)) }, 'Save'),
    h('span', { class: 'sep' }), h('button', { onclick: () => restore(S.undo, S.redo) }, '↶ Undo'), h('button', { onclick: () => restore(S.redo, S.undo) }, '↷ Redo'),
    h('span', { class: 'sep' }), h('span', { class: 'lbl' }, 'Export'), h('button', { onclick: () => exportAs('step') }, 'STEP'), h('button', { onclick: () => exportAs('stl') }, 'STL'), h('button', { title: '3-view drawing with hidden lines', onclick: () => exportAs('svg') }, 'Drawing'),
    h('span', { style: 'flex:1' }),
    h('button', { onclick: async () => { const r = await call('interference'); dialog('Interference check', h('pre', {}, r.length ? r.map((x) => `${x.a} ∩ ${x.b}: ${fmt(x.volume)} mm³`).join('\n') : 'No interference between visible bodies.')); } }, 'Interference'),
    h('button', { title: 'Edit the document as JSON · feature reference · MCP setup', onclick: aiPanel }, '{ } JSON / AI'));
  const sect = h('select', { style: 'width:auto', title: 'section view', onchange: (e) => { const a = e.target.value; renderer.clippingPlanes = a ? [clip] : []; if (a) { clip.normal.set(a === 'X' ? -1 : 0, a === 'Y' ? -1 : 0, a === 'Z' ? -1 : 0); clip.constant = new THREE.Box3().setFromObject(bodyG).getCenter(new THREE.Vector3())[a.toLowerCase()]; } render(); } }, ['', 'X', 'Y', 'Z'].map((a) => h('option', { value: a }, a ? 'Section ' + a : 'No section')));
  fill('viewbar', h('button', { onclick: fit }, 'Fit'), h('button', { onclick: () => view([1, -1.2, 0.9]) }, 'Iso'), h('button', { onclick: () => view([0, -1, 0]) }, 'Front'), h('button', { onclick: () => view([0, 0, 1], [0, 1, 0]) }, 'Top'), h('button', { onclick: () => view([1, 0, 0]) }, 'Right'), sect,
    h('input', { type: 'range', min: -200, max: 200, step: 0.5, value: 0, style: 'width:70px', title: 'section position', oninput: (e) => { clip.constant = +e.target.value; render(); } }));
}
// Contextual ribbon: sketch tools while sketching, modelling tools in a part studio, insert/mate tools in an assembly.
function ribbon() {
  const tool = (t, label) => h('button', { class: S.tool === t ? 'on' : '', onclick: () => { S.tool = t; draft = null; clear(draftG); panels(); } }, label);
  if (S.sketch) return fill('ribbon', G('Draw', tool('path', 'Line / Path'), tool('rect', 'Rectangle'), tool('circle', 'Circle'), tool('polygon', 'Polygon'), tool('slot', 'Slot')),
    G(`Constrain${S.skSel.length ? ` (${S.skSel.length} selected)` : ''}`, tool('select', '⬚ Select'), Object.keys(CONS).map((k) => h('button', { title: 'needs ' + CONS[k], onclick: () => constrain(k) }, k[0].toUpperCase() + k.slice(1)))),
    G('Sketch', h('button', { class: 'on', onclick: exitSketch }, '✓ Finish')));
  if (isAsm()) return fill('ribbon',
    G('Insert', S.doc.studios.map((s) => h('button', { title: 'insert every body of this part studio', onclick: () => change(() => { const i = { id: uid(cur().instances, 'inst'), studio: s.id, body: '', translate: [0, 0, 0], rotate: [0, 0, 0] }; cur().instances.push(i); S.sel = i.id; }) }, '＋ ' + s.name))),
    G('Mate', ['fasten', 'revolute', 'slider', 'cylindrical'].map((k) => h('button', { class: S.pick?.k === k ? 'on' : '', onclick: () => { S.pick = S.pick?.k === k ? null : { kind: 'mate', k }; clear(selG); panels(); render(); } }, k[0].toUpperCase() + k.slice(1)))));
  const groups = {};
  for (const [t, f] of Object.entries(FEATURES)) (groups[f.group] ||= []).push(h('button', { class: t === 'sketch' ? 'on' : '', onclick: () => addFeature(t) }, f.label));
  fill('ribbon', Object.entries(groups).map(([g, b]) => G(g === 'Assembly' ? 'Body' : g, b)));
}
function aiPanel() {
  const ta = h('textarea', { value: JSON.stringify(S.doc, null, 1), spellcheck: false });
  const d = dialog('Document JSON — the same file the CLI and MCP server edit', [ta, h('details', {}, h('summary', {}, 'Reference (what an AI agent reads via the `schema` tool)'), h('pre', { style: 'height:30vh' }, docs() + '\nMCP: node bin/forge.js mcp <doc.json>   ·   CLI: node bin/forge.js'))],
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
fixState(); menu(); panels(); resize();
(async () => {
  let d = null;
  try { const r = await fetch('/api/doc'); if (r.ok && r.headers.get('x-forge-doc')) { const t = await r.text(); d = JSON.parse(t); S.server = true; S.lastSaved = t; } } catch {}
  if (!d) try { d = JSON.parse(localStorage.getItem('forge-doc')); } catch {}
  await loadDoc(d || {}); menu(); view([1, -1.2, 0.9]);
  if (S.server) new EventSource('/api/events').onmessage = async () => { // live reload when the CLI / an AI agent edits the file
    const t = await (await fetch('/api/doc')).text();
    if (t !== S.lastSaved && t !== JSON.stringify(S.doc, null, 1)) { S.lastSaved = t; try { const keep = S.sel, tab = S.tab; S.undo.push(JSON.stringify(S.doc)); S.doc = normalize(JSON.parse(t)); S.tab = tab; S.sel = keep; S.pick = null; fixState(); panels(); await rebuild(); status('Reloaded — document changed on disk'); } catch {} }
  };
})();
