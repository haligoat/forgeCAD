// 2D geometric constraint solver for sketches (Levenberg–Marquardt, numeric Jacobian).
// Works on numerically resolved entities; a coordinate is free unless the document gives it as an expression.
// Point refs: [entityIndex, k] — path: k=0 is start, k>=1 is the end of segment k-1; slot: 'a' | 'b'; others: 'c' (center).
export function pointOf(E, [i, k]) {
  const e = E[i];
  if (!e) throw Error(`constraint references missing entity ${i}`);
  if (e.t === 'path') { const p = k === 0 ? e.start : e.segs?.[k - 1]?.to; if (!p) throw Error(`path ${i} has no point ${k}`); return p; }
  if (e.t === 'slot') return k === 'b' ? [e.x2, e.y2] : [e.x1, e.y1];
  return [e.cx || 0, e.cy || 0];
}
export function listPoints(E) {
  return E.flatMap((e, i) => (e.t === 'path' ? [[i, 0], ...(e.segs || []).map((_, k) => [i, k + 1])] : e.t === 'slot' ? [[i, 'a'], [i, 'b']] : [[i, 'c']]));
}
const KEYS = { circle: ['cx', 'cy', 'r'], polygon: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'], rect: ['cx', 'cy', 'w', 'h'], slot: ['x1', 'y1', 'x2', 'y2'] };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], cross = (a, b) => a[0] * b[1] - a[1] * b[0], dot = (a, b) => a[0] * b[0] + a[1] * b[1], len = (a) => Math.hypot(a[0], a[1]) || 1e-12;
const rad = (E, i) => { if (E[i]?.r == null) throw Error(`entity ${i} has no radius`); return E[i].r; };
// Each returns residuals that are zero when satisfied. P = point lookup, n = expression evaluator.
const RES = {
  coincident: (c, P) => sub(P(c.a), P(c.b)),
  horizontal: (c, P) => [P(c.a)[1] - P(c.b)[1]],
  vertical: (c, P) => [P(c.a)[0] - P(c.b)[0]],
  distance: (c, P, n) => [len(sub(P(c.a), P(c.b))) - n(c.v)],
  fix: (c, P, n) => [P(c.a)[0] - n(c.x), P(c.a)[1] - n(c.y)],
  parallel: (c, P) => { const u = sub(P(c.b), P(c.a)), v = sub(P(c.d), P(c.c)); return [cross(u, v) / (len(u) * len(v))]; },
  perpendicular: (c, P) => { const u = sub(P(c.b), P(c.a)), v = sub(P(c.d), P(c.c)); return [dot(u, v) / (len(u) * len(v))]; },
  equal: (c, P) => [len(sub(P(c.b), P(c.a))) - len(sub(P(c.d), P(c.c)))],
  angle: (c, P, n) => { const u = sub(P(c.b), P(c.a)), v = sub(P(c.d), P(c.c)); let d = Math.atan2(cross(u, v), dot(u, v)) - (n(c.v) * Math.PI) / 180; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return [d * len(u)]; },
  midpoint: (c, P) => { const a = P(c.a), b = P(c.b), q = P(c.c); return [a[0] - (b[0] + q[0]) / 2, a[1] - (b[1] + q[1]) / 2]; },
  onLine: (c, P) => { const u = sub(P(c.c), P(c.b)); return [cross(u, sub(P(c.a), P(c.b))) / len(u)]; },
  radius: (c, P, n, E) => [rad(E, c.e) - n(c.v)],
  equalRadius: (c, P, n, E) => [rad(E, c.e) - rad(E, c.f)],
  onCircle: (c, P, n, E) => [len(sub(P(c.a), P([c.e, 'c']))) - rad(E, c.e)],
  tangent: (c, P, n, E) => { const u = sub(P(c.b), P(c.a)); return [Math.abs(cross(u, sub(P([c.e, 'c']), P(c.a)))) / len(u) - rad(E, c.e)]; },
};
export const CONSTRAINTS = `SKETCH CONSTRAINTS (sketch.constraints:[...], solved on every rebuild; numeric coordinates are free, expression strings are fixed):
 point ref = [entityIndex,k]: path k=0 start, k>=1 end of segment k-1; slot "a"|"b"; circle/rect/polygon/ellipse "c". e,f = entity indices (circles). v may be an expression.
 {k:"coincident",a,b} {k:"horizontal",a,b} {k:"vertical",a,b} {k:"distance",a,b,v} {k:"fix",a,x,y}
 {k:"parallel",a,b,c,d} {k:"perpendicular",a,b,c,d} {k:"equal",a,b,c,d} {k:"angle",a,b,c,d,v} (lines a-b and c-d, degrees)
 {k:"midpoint",a,b,c} (a at middle of b-c) {k:"onLine",a,b,c} {k:"radius",e,v} {k:"equalRadius",e,f} {k:"onCircle",a,e} {k:"tangent",a,b,e} (line a-b tangent to circle e)`;

function gauss(A, b) { // solves A x = b in place, returns x (A square)
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (Math.abs(A[p][i]) < 1e-14) continue;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; if (!f) continue; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { if (Math.abs(A[i][i]) < 1e-14) continue; let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
  return x;
}
function rank(J, nv) {
  const A = J.map((r) => [...r]); let rk = 0;
  for (let c = 0; c < nv && rk < A.length; c++) {
    let p = rk; for (let r = rk + 1; r < A.length; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-7) continue;
    [A[rk], A[p]] = [A[p], A[rk]];
    for (let r = rk + 1; r < A.length; r++) { const f = A[r][c] / A[rk][c]; for (let k = c; k < nv; k++) A[r][k] -= f * A[rk][k]; }
    rk++;
  }
  return rk;
}
// E: resolved entities (mutated to the solution). raw: the document's entities (to tell free numbers from fixed expressions).
export function solve(E, raw, cons, n) {
  const V = [];
  const add = (o, k, r) => { if (typeof r === 'number' || r === undefined) { if (o[k] === undefined) o[k] = 0; V.push([o, k]); } };
  E.forEach((e, i) => {
    const r = raw[i];
    if (e.t === 'path') { [0, 1].forEach((j) => add(e.start, j, r.start[j])); (e.segs || []).forEach((s, q) => [0, 1].forEach((j) => add(s.to, j, r.segs[q].to[j]))); }
    else for (const k of KEYS[e.t] || []) add(e, k, r[k]);
  });
  const before = E.map((e) => (e.t === 'path' ? [e.start, ...(e.segs || []).map((s) => s.to)].map((p) => [...p]) : null));
  const P = (ref) => pointOf(E, ref);
  const res = () => cons.flatMap((c) => { if (!RES[c.k]) throw Error(`unknown constraint "${c.k}"`); return RES[c.k](c, P, n, E); });
  const get = () => V.map(([o, k]) => o[k]), set = (x) => V.forEach(([o, k], i) => (o[k] = x[i]));
  const cost = (r) => r.reduce((s, v) => s + v * v, 0);
  const jac = (r0) => { const x = get(), J = r0.map(() => new Array(V.length).fill(0)); V.forEach(([o, k], j) => { o[k] = x[j] + 1e-6; res().forEach((v, i) => (J[i][j] = (v - r0[i]) / 1e-6)); o[k] = x[j]; }); return J; };
  let r = res(), c0 = cost(r), lam = 1e-3;
  const nv = V.length;
  for (let it = 0; it < 80 && c0 > 1e-20 && nv; it++) {
    const J = jac(r);
    const x = get(), A = Array.from({ length: nv }, (_, a) => Array.from({ length: nv }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0) + (a === b ? lam : 0)));
    const g = Array.from({ length: nv }, (_, a) => -J.reduce((s, row, i) => s + row[a] * r[i], 0));
    const dx = gauss(A, g);
    set(x.map((v, i) => v + dx[i]));
    const r1 = res(), c1 = cost(r1);
    if (c1 < c0) { r = r1; c0 = c1; lam = Math.max(lam / 3, 1e-9); } else { set(x); lam *= 5; if (lam > 1e9) break; }
  }
  // arcs: carry the "via" point along with its segment's endpoints
  E.forEach((e, i) => (e.segs || []).forEach((s, q) => { if (!s.via) return; const b = before[i], p0 = q ? e.segs[q - 1].to : e.start; s.via = [0, 1].map((j) => s.via[j] + (p0[j] - b[q][j] + s.to[j] - b[q + 1][j]) / 2); }));
  const residual = Math.sqrt(c0);
  return { ok: residual < 1e-5, residual, vars: nv, dof: nv ? nv - rank(jac(res()), nv) : 0 };
}
