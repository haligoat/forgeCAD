// Parametric B-rep kernel on OpenCascade (via replicad). Runs identically in a browser worker and in node.
import * as R from 'replicad';
import { FEATURES } from './schema.js';
import { solve } from './solver.js';

export function init(oc) { R.setOC(oc); }
const V = (v) => [v.x, v.y, v.z];
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const AX = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

function evalExpr(e, vals) {
  if (typeof e === 'number') return e;
  if (typeof e !== 'string' || !e.trim()) throw Error('expected a number, got ' + JSON.stringify(e));
  const k = Object.keys(vals);
  const r = Function(...k, 'with(Math){return (' + e + ')}')(...k.map((x) => vals[x]));
  if (typeof r !== 'number' || !isFinite(r)) throw Error(`expression "${e}" is not a finite number`);
  return r;
}
const fkey = (f) => { try { return V(f.pointOnSurface(0.5, 0.5)); } catch { return V(f.center); } };
const ekey = (e) => V(e.pointAt(0.5));
function nearest(items, keyf, pts) {
  const keys = items.map(keyf);
  return pts.map((p) => { let bi = 0, bd = Infinity; keys.forEach((k, i) => { const d = d2(k, p); if (d < bd) { bd = d; bi = i; } }); return items[bi]; });
}

let last = { bodies: new Map() };

// ---- rigid 4x4 transforms (row-major) for assemblies ----
const mul = (A, B) => A.map((r, i) => B[0].map((_, j) => r.reduce((s, _v, k) => s + A[i][k] * B[k][j], 0)));
const trans = ([x, y, z]) => [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]];
const rotA = (ax, deg) => { const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180); return ax === 0 ? [[1, 0, 0, 0], [0, c, -s, 0], [0, s, c, 0], [0, 0, 0, 1]] : ax === 1 ? [[c, 0, s, 0], [0, 1, 0, 0], [-s, 0, c, 0], [0, 0, 0, 1]] : [[c, -s, 0, 0], [s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]; };
const euler = ([x, y, z]) => mul(rotA(2, z), mul(rotA(1, y), rotA(0, x)));
const inv = (M) => { const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => M[j][i])), t = R.map((r) => -(r[0] * M[0][3] + r[1] * M[1][3] + r[2] * M[2][3])); return [[...R[0], t[0]], [...R[1], t[1]], [...R[2], t[2]], [0, 0, 0, 1]]; };
function applyM(shape, M) {
  const ang = Math.acos(Math.max(-1, Math.min(1, (M[0][0] + M[1][1] + M[2][2] - 1) / 2)));
  let s = shape.clone();
  if (ang > 1e-9) {
    let ax = [M[2][1] - M[1][2], M[0][2] - M[2][0], M[1][0] - M[0][1]], L = Math.hypot(...ax);
    if (L < 1e-6) { const d = [M[0][0], M[1][1], M[2][2]], i = d.indexOf(Math.max(...d)), a = Math.sqrt((d[i] + 1) / 2); ax = [0, 1, 2].map((j) => (j === i ? a : M[i][j] / (2 * a))); L = Math.hypot(...ax); }
    s = s.rotate((ang * 180) / Math.PI, [0, 0, 0], ax.map((c) => c / L));
  }
  return s.translate([M[0][3], M[1][3], M[2][3]]);
}
// Mate connector frame on a face: origin at the face centroid, z along its normal.
function frame(I, pt) {
  const faces = I.src.flatMap(([, b]) => b.shape.faces);
  if (!faces.length) throw Error('instance has no faces');
  const f = nearest(faces, fkey, [pt])[0], o = V(f.center), z = V(f.normalAt(f.center));
  const a = z.map(Math.abs), e = [0, 0, 0]; e[a.indexOf(Math.min(...a))] = 1;
  const dz = e[0] * z[0] + e[1] * z[1] + e[2] * z[2]; let x = e.map((c, i) => c - dz * z[i]); const L = Math.hypot(...x); x = x.map((c) => c / L);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [[x[0], y[0], z[0], o[0]], [x[1], y[1], z[1], o[1]], [x[2], y[2], z[2], o[2]], [0, 0, 0, 1]];
}

async function runStudio(feats, vals, opts, errors, prefix = '') {
  const sketches = {}, skOut = {};
  const n = (v) => evalExpr(v, vals);
  const v3 = (a, d) => (typeof a === 'string' && AX[a] ? AX[a] : (a || d).map(n));
  const bodies = new Map();
  const get = (name) => {
    if (!name) { const l = [...bodies.keys()].pop(); if (!l) throw Error('no body exists yet'); return l; }
    if (!bodies.has(name)) throw Error(`body "${name}" not found (have: ${[...bodies.keys()].join(', ') || 'none'})`);
    return name;
  };
  const put = (name, shape, from) => bodies.set(name, { ...(bodies.get(name) || from || { color: null, opacity: 1, density: 1 }), shape });
  const combine = (op, target, tool) => {
    const b = bodies.get(target);
    put(target, op === 'add' ? b.shape.fuse(tool) : op === 'cut' ? b.shape.cut(tool) : b.shape.intersect(tool));
  };
  const apply = (f, shape) => {
    const op = f.op || 'new';
    if (op === 'new') put(f.body || f.name || f.id, shape); else combine(op, get(f.body), shape);
  };
  const finder = (shape, sel, kind) => {
    if (!sel || sel === 'all') return undefined;
    const parts = [];
    if (sel.points?.length) { const list = nearest(kind === 'edge' ? shape.edges : shape.faces, kind === 'edge' ? ekey : fkey, sel.points.map((p) => p.map(n))); parts.push((x) => x.inList(list)); }
    if (sel.dir) parts.push((x) => x.inDirection(sel.dir));
    if (sel.plane) parts.push((x) => x.inPlane(sel.plane, n(sel.offset || 0)));
    if (sel.parallel) parts.push((x) => x.parallelTo(sel.parallel));
    if (!parts.length) throw Error('empty selection — pick at least one ' + kind);
    return (x) => (parts.length === 1 ? parts[0](x) : x.and(parts));
  };
  const planeOf = (f) => {
    const p = f.plane || 'XY';
    let pl;
    if (typeof p === 'string') pl = R.makePlane(p, 0);
    else if (p.face) { const b = bodies.get(get(p.face.body)); pl = R.makePlaneFromFace(nearest(b.shape.faces, fkey, [p.face.point.map(n)])[0]); }
    else pl = new R.Plane(v3(p.origin, [0, 0, 0]), p.xDir ? v3(p.xDir) : null, v3(p.normal, [0, 0, 1]));
    const off = n(f.offset || 0);
    return off ? pl.translate(V(pl.zDir).map((c) => c * off)) : pl;
  };
  const entity = (e) => {
    const g = (k, d) => (e[k] === undefined ? d : n(e[k]));
    let d;
    if (e.t === 'rect') d = R.drawRoundedRectangle(g('w'), g('h'), g('r', 0)).rotate(g('rot', 0)).translate(g('cx', 0), g('cy', 0));
    else if (e.t === 'circle') d = R.drawCircle(g('r')).translate(g('cx', 0), g('cy', 0));
    else if (e.t === 'ellipse') { const a = g('rx'), b = g('ry'); d = R.drawEllipse(Math.max(a, b), Math.min(a, b)).rotate(g('rot', 0) + (a < b ? 90 : 0)).translate(g('cx', 0), g('cy', 0)); }
    else if (e.t === 'polygon') d = R.drawPolysides(g('r'), Math.round(g('n', 6))).rotate(g('rot', 0)).translate(g('cx', 0), g('cy', 0));
    else if (e.t === 'slot') { const x1 = g('x1'), y1 = g('y1'), x2 = g('x2'), y2 = g('y2'), w = g('w'); d = R.drawRoundedRectangle(Math.hypot(x2 - x1, y2 - y1) + w, w, w / 2 - 1e-6).rotate(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI).translate((x1 + x2) / 2, (y1 + y2) / 2); }
    else if (e.t === 'path') {
      let pen = R.draw(e.start.map(n));
      for (const s of e.segs || []) {
        const to = s.to.map(n);
        if (s.via) pen = pen.threePointsArcTo(to, s.via.map(n));
        else if (s.bulge !== undefined) pen = pen.bulgeArcTo(to, n(s.bulge));
        else if (s.c1) pen = pen.cubicBezierCurveTo(to, s.c1.map(n), (s.c2 || s.c1).map(n));
        else if (s.tangent) pen = pen.tangentArcTo(to);
        else pen = pen.lineTo(to);
        if (s.fillet) pen = pen.customCorner(n(s.fillet));
      }
      d = e.closed === false ? pen.done() : pen.close();
    } else throw Error('unknown sketch entity type ' + e.t);
    return d;
  };
  const resolveNums = (o) => Array.isArray(o) ? o.map(resolveNums) : o && typeof o === 'object'
    ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 't' || k === 'mode' ? v : resolveNums(v)]))
    : typeof o === 'string' ? n(o) : o;
  const one = (s) => (s.sketches ? one(s.sketches[0]) : s.outerSketch || s);
  const sk = (id) => { if (!sketches[id]) throw Error(`sketch "${id}" not found (or failed)`); return sketches[id]; };
  const profile = (id) => { const s = sk(id); if (!s.drawing) throw Error(`sketch "${id}" has no closed profile`); return s.drawing.sketchOnPlane(s.plane); };
  const rot = (shape, angle, origin, axis) => (angle ? shape.rotate(angle, origin, axis) : shape);

  const run = {
    sketch(f) {
      const plane = planeOf(f);
      let drawing = null; const open = [], cuts = [];
      const ents = resolveNums(f.entities || []), cons = (f.constraints || []).filter((c) => !c.suppressed);
      const sv = cons.length ? solve(ents, f.entities, cons, n) : null;
      if (sv && !sv.ok) errors[prefix + f.id] = `sketch constraints not satisfied (residual ${sv.residual.toExponential(2)}) — conflicting or over-constrained`;
      for (const e of ents) {
        if (e.construction) continue;
        const d = entity(e);
        if (e.t === 'path' && e.closed === false) open.push(d);
        else if (e.mode === 'cut') cuts.push(d);
        else drawing = drawing ? drawing.fuse(d) : d;
      }
      for (const c of cuts) if (drawing) drawing = drawing.cut(c);
      sketches[f.id] = { plane, drawing, open };
      skOut[f.id] = { frame: { o: V(plane.origin), x: V(plane.xDir), y: V(plane.yDir), z: V(plane.zDir) }, entities: ents, solve: sv };
    },
    extrude(f) {
      const d = n(f.distance), tw = n(f.twist || 0), tp = n(f.taper ?? 1), s = sk(f.sketch);
      const cfg = {}; if (tw) cfg.twistAngle = tw; if (tp !== 1) cfg.extrusionProfile = { profile: 'linear', endFactor: tp };
      let shape = profile(f.sketch).extrude(d, cfg);
      if (f.symmetric) shape = shape.translate(V(s.plane.zDir).map((c) => (-c * d) / 2));
      apply(f, shape);
    },
    revolve(f) { apply(f, profile(f.sketch).revolve(v3(f.axis, AX.Z), { origin: v3(f.origin, [0, 0, 0]), angle: n(f.angle ?? 360) })); },
    loft(f) { const ss = f.sketches.map((id) => one(profile(id))); if (ss.length < 2) throw Error('loft needs 2+ sketches'); apply(f, ss[0].loftWith(ss.slice(1), { ruled: !!f.ruled })); },
    sweep(f) {
      const path = sk(f.path), prof = sk(f.profile);
      if (!path.open.length) throw Error('path sketch needs an open path (closed:false)');
      if (!prof.drawing) throw Error('profile sketch has no closed profile');
      apply(f, one(path.open[0].sketchOnPlane(path.plane)).sweepSketch((pl, origin) => one(prof.drawing.sketchOnPlane(pl.translateTo(origin)))));
    },
    coil(f) { apply(f, R.sketchHelix(n(f.pitch), n(f.height), n(f.radius), [0, 0, 0], [0, 0, 1], !!f.lefthand).sweepSketch((plane, origin) => R.sketchCircle(n(f.wire), { plane, origin }), { frenet: true }).translate(v3(f.at, [0, 0, 0]))); },
    box(f) { const s = v3(f.size); let b = R.makeBaseBox(...s); if (f.centered) b = b.translate([0, 0, -s[2] / 2]); apply(f, b.translate(v3(f.at, [0, 0, 0]))); },
    cylinder(f) { apply(f, R.makeCylinder(n(f.r), n(f.h), v3(f.at, [0, 0, 0]), v3(f.dir, AX.Z))); },
    sphere(f) { apply(f, R.makeSphere(n(f.r)).translate(v3(f.at, [0, 0, 0]))); },
    cone(f) { const r1 = n(f.r1), r2 = n(f.r2 || 0), h = n(f.h); let pen = R.draw([0, 0]).lineTo([r1, 0]).lineTo([Math.max(r2, 0), h]); if (r2 > 0) pen = pen.lineTo([0, h]); apply(f, pen.close().sketchOnPlane('XZ').revolve([0, 0, 1]).translate(v3(f.at, [0, 0, 0]))); },
    torus(f) { apply(f, R.drawCircle(n(f.r)).translate(n(f.R), 0).sketchOnPlane('XZ').revolve([0, 0, 1]).translate(v3(f.at, [0, 0, 0]))); },
    hole(f) {
      const name = get(f.body), dir = v3(f.dir, [0, 0, -1]), L = Math.hypot(...dir), u = dir.map((c) => c / L);
      const r = n(f.d) / 2, depth = n(f.depth), cb = n(f.cboreD || 0), cs = n(f.csinkD || 0);
      for (const p0 of f.points?.length ? f.points : [f.at || [0, 0, 0]]) {
        const p = p0.map(n), start = p.map((c, i) => c - u[i] * 0.01);
        let tool = R.makeCylinder(r, depth + 0.01, start, u);
        if (cb > 0) tool = tool.fuse(R.makeCylinder(cb / 2, n(f.cboreDepth) + 0.01, start, u));
        if (cs > 2 * r) {
          const h = (cs / 2 - r) / Math.tan((n(f.csinkAngle || 90) * Math.PI) / 360);
          tool = tool.fuse(R.sketchCircle(cs / 2, { plane: new R.Plane(p, null, u) }).loftWith(R.sketchCircle(r, { plane: new R.Plane(p.map((c, i) => c + u[i] * h), null, u) })));
        }
        combine('cut', name, tool);
      }
    },
    fillet(f) { const name = get(f.body), s = bodies.get(name).shape; put(name, s.fillet(n(f.radius), finder(s, f.edges, 'edge'))); },
    chamfer(f) { const name = get(f.body), s = bodies.get(name).shape; put(name, s.chamfer(n(f.distance), finder(s, f.edges, 'edge'))); },
    shell(f) { const name = get(f.body), s = bodies.get(name).shape; put(name, s.shell(n(f.thickness), finder(s, f.faces, 'face'))); },
    draft(f) { const name = get(f.body), s = bodies.get(name).shape; put(name, s.draft(n(f.angle), finder(s, f.faces, 'face'), f.neutral || 'XY')); },
    split(f) {
      const name = get(f.body), s = bodies.get(name).shape, B = 1e5, off = n(f.offset || 0), pos = (f.keep || 'positive') === 'positive';
      const i = { XY: 2, XZ: 1, YZ: 0 }[f.plane || 'XY'], a = [-B, -B, -B], b = [B, B, B];
      if (pos) a[i] = off; else b[i] = off;
      put(name, s.intersect(R.makeBox(a, b)));
    },
    transform(f) {
      const name = get(f.body), b = bodies.get(name);
      let s = b.shape.clone(); const sc = n(f.scale ?? 1), o = v3(f.origin, [0, 0, 0]);
      if (sc !== 1) s = s.scale(sc, o);
      s = rot(s, n(f.angle || 0), o, v3(f.axis, AX.Z)).translate(v3(f.translate, [0, 0, 0]));
      put(f.copy || name, s, b);
    },
    mirror(f) {
      const name = get(f.body), b = bodies.get(name), m = b.shape.clone().mirror(f.plane || 'YZ', v3(f.origin, [0, 0, 0]));
      if (f.copy) put(f.copy, m, b); else put(name, b.shape.fuse(m));
    },
    linearPattern(f) {
      const name = get(f.body), b = bodies.get(name), d1 = v3(f.dir, AX.X), d2v = v3(f.dir2, AX.Y), s1 = n(f.spacing), s2 = n(f.spacing2 || 0);
      const c1 = Math.round(n(f.count)), c2 = Math.round(n(f.count2 || 1)), copies = [];
      const u = (d) => { const L = Math.hypot(...d); return d.map((c) => c / L); }, a = u(d1), c = u(d2v);
      for (let i = 0; i < c1; i++) for (let j = 0; j < c2; j++) if (i || j) copies.push(b.shape.clone().translate(a.map((x, k) => x * s1 * i + c[k] * s2 * j)));
      pattern(f, name, b, copies);
    },
    circularPattern(f) {
      const name = get(f.body), b = bodies.get(name), cnt = Math.round(n(f.count)), tot = n(f.angle ?? 360), copies = [];
      const step = Math.abs(tot) >= 360 ? 360 / cnt : tot / (cnt - 1);
      for (let i = 1; i < cnt; i++) copies.push(b.shape.clone().rotate(step * i, v3(f.origin, [0, 0, 0]), v3(f.axis, AX.Z)));
      pattern(f, name, b, copies);
    },
    boolean(f) {
      const t = get(f.target);
      for (const tool of f.tools || []) { combine(f.op || 'add', t, bodies.get(get(tool)).shape); if (!f.keepTools) bodies.delete(tool); }
    },
    appearance(f) { const b = bodies.get(get(f.body)); if (f.color) b.color = f.color; if (f.opacity !== undefined) b.opacity = n(f.opacity); if (f.density !== undefined) b.density = n(f.density); b.hidden = !!f.hidden; },
    remove(f) { bodies.delete(get(f.body)); },
    async import(f) {
      let bytes;
      if (f.data) bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      else if (f.path && opts.readFile) bytes = await opts.readFile(f.path);
      else throw Error('import needs data (base64) or path');
      put(f.body || f.name || f.id, await R.importSTEP(new Blob([bytes])));
    },
  };
  function pattern(f, name, b, copies) {
    const op = f.op || 'add';
    if (op === 'new') copies.forEach((c, i) => put(`${name}_${i + 2}`, c, b));
    else if (op === 'add') put(name, copies.reduce((acc, c) => acc.fuse(c), b.shape));
    else { const t = get(f.target); if (t === name) throw Error('pattern target must differ from the tool body'); for (const c of [b.shape, ...copies]) combine(op, t, c); bodies.delete(name); }
  }

  const upTo = opts.upTo ?? feats.length;
  for (let i = 0; i < Math.min(upTo, feats.length); i++) {
    const f = feats[i];
    if (f.suppressed) continue;
    try {
      if (!run[f.type]) throw Error(`unknown feature type "${f.type}" (valid: ${Object.keys(FEATURES).join(', ')})`);
      await run[f.type](f);
    } catch (e) { errors[prefix + f.id] = String(e?.message || e).slice(0, 300) || 'kernel error'; }
  }
  return { bodies, skOut };
}

// Assembly: instances of part-studio bodies, positioned by a base transform then by mates (in order; mate.b moves onto mate.a).
async function runAssembly(studios, asm, vals, opts, errors) {
  const n = (v) => evalExpr(v, vals), v3 = (a) => (a || [0, 0, 0]).map(n), cache = new Map(), inst = {}, bodies = new Map();
  const studio = async (id) => {
    if (!cache.has(id)) { const s = studios.find((x) => x.id === id); if (!s) throw Error(`part studio "${id}" not found`); cache.set(id, (await runStudio(s.features || [], vals, { readFile: opts.readFile }, errors, id + '/')).bodies); }
    return cache.get(id);
  };
  for (const i of asm.instances || []) {
    try {
      const sb = await studio(i.studio), names = i.body ? [i.body] : [...sb.keys()];
      if (!names.length) throw Error(`part studio "${i.studio}" has no bodies`);
      for (const nm of names) if (!sb.has(nm)) throw Error(`body "${nm}" not in part studio "${i.studio}" (have: ${[...sb.keys()].join(', ')})`);
      inst[i.id] = { src: names.map((nm) => [nm, sb.get(nm)]), M: mul(trans(v3(i.translate)), euler(v3(i.rotate))) };
    } catch (e) { errors[i.id] = String(e?.message || e); }
  }
  for (const m of asm.mates || []) {
    if (m.suppressed) continue;
    try {
      const A = inst[m.a?.inst], B = inst[m.b?.inst];
      if (!A || !B || A === B) throw Error('a mate needs two different, valid instances');
      const J = mul(mul(rotA(2, n(m.angle || 0)), trans([0, 0, n(m.offset || 0)])), m.flip ? trans([0, 0, 0]) : rotA(0, 180));
      B.M = mul(mul(mul(A.M, frame(A, m.a.point.map(n))), J), inv(frame(B, m.b.point.map(n))));
    } catch (e) { errors[m.id] = String(e?.message || e); }
  }
  for (const [id, i] of Object.entries(inst)) for (const [nm, b] of i.src) bodies.set(i.src.length > 1 ? `${id}/${nm}` : id, { ...b, shape: applyM(b.shape, i.M), inst: id });
  return { bodies, instances: Object.fromEntries(Object.entries(inst).map(([k, v]) => [k, v.M])), studioBodies: Object.fromEntries([...cache].map(([k, v]) => [k, [...v.keys()]])) };
}

// opts: {studio: id} (default: first studio) or {assembly: id}; upTo, mesh, readFile.
export async function evaluate(doc, opts = {}) {
  const t0 = Date.now(), vals = {}, errors = {};
  for (const p of doc.params || []) { try { vals[p.name] = evalExpr(p.expr, vals); } catch (e) { errors['param:' + p.name] = e.message; } }
  const studios = doc.studios || [{ id: 'studio1', features: doc.features || [] }];
  let bodies, skOut = {}, extra = {};
  if (opts.assembly) {
    const asm = (doc.assemblies || []).find((a) => a.id === opts.assembly);
    if (!asm) throw Error(`assembly "${opts.assembly}" not found`);
    ({ bodies, ...extra } = await runAssembly(studios, asm, vals, opts, errors));
  } else {
    const st = studios.find((s) => s.id === opts.studio) || studios[0];
    ({ bodies, skOut } = await runStudio(st.features || [], vals, opts, errors));
  }
  last = { bodies };
  const out = [];
  for (const [name, b] of bodies) {
    try { out.push(describe(name, b, opts.mesh !== false)); } catch (e) { errors['body:' + name] = 'tessellation failed: ' + e.message; }
  }
  return { bodies: out, sketches: skOut, errors, params: vals, ms: Date.now() - t0, ...extra };
}

function describe(name, b, withMesh) {
  const s = b.shape, bb = s.boundingBox.bounds;
  let volume = 0, area = 0, com = [0, 0, 0];
  try { volume = R.measureVolume(s); area = R.measureArea(s); com = R.measureShapeVolumeProperties(s).centerOfMass; } catch {}
  const o = { name, inst: b.inst, color: b.color, opacity: b.opacity ?? 1, hidden: !!b.hidden, density: b.density ?? 1, volume, area, com, mass: (volume / 1000) * (b.density ?? 1), bbox: bb, faces: s.faces.length, edges: s.edges.length };
  if (!withMesh) return o;
  const m = s.mesh({ tolerance: 0.05, angularTolerance: 0.25 }), em = s.meshEdges({ tolerance: 0.05, angularTolerance: 0.25 });
  const fById = new Map(s.faces.map((f) => [f.hashCode, f])), eById = new Map(s.edges.map((e) => [e.hashCode, e]));
  o.mesh = { vertices: new Float32Array(m.vertices), normals: new Float32Array(m.normals), triangles: new Uint32Array(m.triangles), lines: new Float32Array(em.lines) };
  o.faceGroups = m.faceGroups.map((g) => { const f = fById.get(g.faceId); let i = {}; try { i = { key: fkey(f), area: R.measureArea(f), type: f.geomType, normal: V(f.normalAt()) }; } catch {} return { start: g.start, count: g.count, ...i }; });
  o.edgeGroups = em.edgeGroups.map((g) => { const e = eById.get(g.edgeId); let i = {}; try { i = { key: ekey(e), length: e.length, type: e.geomType }; } catch {} return { start: g.start, count: g.count, ...i }; });
  return o;
}

const visible = () => [...last.bodies].filter(([, b]) => !b.hidden);
export async function exportModel(kind) {
  const list = visible();
  if (!list.length) throw Error('nothing to export');
  if (kind === 'step') return new Uint8Array(await R.exportSTEP(list.map(([name, b]) => ({ shape: b.shape, name, color: b.color || '#8899aa', alpha: b.opacity ?? 1 }))).arrayBuffer());
  if (kind === 'stl') return new Uint8Array(await R.makeCompound(list.map(([, b]) => b.shape)).blobSTL({ tolerance: 0.02, angularTolerance: 0.2, binary: true }).arrayBuffer());
  if (kind === 'svg') return new TextEncoder().encode(drawing());
  throw Error('unknown export kind ' + kind);
}
// 3-view engineering drawing (front / top / right) with hidden lines dashed.
export function drawing() {
  const comp = R.makeCompound(visible().map(([, b]) => b.shape));
  let x = 10, body = '', H = 0;
  for (const view of ['front', 'top', 'right']) {
    const { visible: vis, hidden } = R.drawProjection(comp, view);
    const [[x0, y0], [x1, y1]] = vis.boundingBox.bounds, w = x1 - x0 + 4, h = y1 - y0 + 4;
    const paths = (d, extra) => d.toSVGPaths().flat(9).map((p) => `<path d="${p}" ${extra}/>`).join('');
    body += `<svg x="${x}" y="14" width="${w}" height="${h}" viewBox="${vis.toSVGViewBox(2)}" fill="none" stroke="#000" stroke-width="0.25">${paths(hidden, 'stroke="#999" stroke-dasharray="1 1"')}${paths(vis, '')}</svg><text x="${x}" y="9" font-size="5" font-family="sans-serif">${view.toUpperCase()}  ${(x1 - x0).toFixed(2)} × ${(y1 - y0).toFixed(2)} mm</text>`;
    x += w + 12; H = Math.max(H, h);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x} ${H + 24}" width="${x * 4}" height="${(H + 24) * 4}"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`;
}
// Pairwise interference volumes between visible bodies.
export function interference() {
  const l = visible(), res = [];
  for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
    let v = 0; try { v = R.measureVolume(l[i][1].shape.intersect(l[j][1].shape)); } catch {}
    if (v > 1e-6) res.push({ a: l[i][0], b: l[j][0], volume: v });
  }
  return res;
}
