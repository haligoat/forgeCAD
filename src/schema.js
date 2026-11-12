// Single source of truth for feature types: drives the UI forms, the kernel defaults and the AI docs.
// Field kinds: num (number or expression string), vec ([x,y,z] of num), text, bool, select:a|b, body, bodies,
// sketch, sketches, edges, faces (selectors), op, plane.
const OP = ['op', 'op', 'new', 'new = make a body, add = fuse into `body`, cut, intersect'];
const BODY = ['body', 'body', '', 'target body name (for op=new: name of the new body)'];
const AT = ['at', 'vec', [0, 0, 0], 'position'];
export const FEATURES = {
  sketch: { label: 'Sketch', group: 'Sketch', fields: [
    ['plane', 'plane', 'XY', '"XY" | "XZ" | "YZ" | {face:{body,point:[x,y,z]}} | {origin,normal,xDir}'],
    ['offset', 'num', 0, 'offset along plane normal'],
    ['entities', 'entities', [], 'see SKETCH ENTITIES'] ] },
  extrude: { label: 'Extrude', group: 'Create', fields: [['sketch', 'sketch', ''], ['distance', 'num', 10, 'negative flips direction'], OP, BODY,
    ['symmetric', 'bool', false], ['twist', 'num', 0, 'degrees'], ['taper', 'num', 1, 'end scale factor, 1 = straight']] },
  revolve: { label: 'Revolve', group: 'Create', fields: [['sketch', 'sketch', ''], ['axis', 'vec', [0, 0, 1], 'world axis direction'],
    ['origin', 'vec', [0, 0, 0]], ['angle', 'num', 360], OP, BODY] },
  loft: { label: 'Loft', group: 'Create', fields: [['sketches', 'sketches', [], 'ordered, one closed profile each'], ['ruled', 'bool', false], OP, BODY] },
  sweep: { label: 'Sweep', group: 'Create', fields: [['profile', 'sketch', '', 'closed profile, drawn around its origin'], ['path', 'sketch', '', 'sketch with one open path'], OP, BODY] },
  coil: { label: 'Coil', group: 'Create', fields: [['radius', 'num', 10], ['pitch', 'num', 5], ['height', 'num', 30], ['wire', 'num', 1, 'wire radius'], ['lefthand', 'bool', false], AT, OP, BODY] },
  box: { label: 'Box', group: 'Create', fields: [['size', 'vec', [20, 20, 20]], ['centered', 'bool', false, 'center in Z too (always centered in XY)'], AT, OP, BODY] },
  cylinder: { label: 'Cylinder', group: 'Create', fields: [['r', 'num', 10], ['h', 'num', 20], ['dir', 'vec', [0, 0, 1]], AT, OP, BODY] },
  sphere: { label: 'Sphere', group: 'Create', fields: [['r', 'num', 10], AT, OP, BODY] },
  cone: { label: 'Cone', group: 'Create', fields: [['r1', 'num', 10], ['r2', 'num', 0], ['h', 'num', 20], AT, OP, BODY] },
  torus: { label: 'Torus', group: 'Create', fields: [['R', 'num', 20], ['r', 'num', 5], AT, OP, BODY] },
  hole: { label: 'Hole', group: 'Modify', fields: [BODY, ['points', 'points', [[0, 0, 0]], 'hole start points'], ['dir', 'vec', [0, 0, -1], 'drill direction'],
    ['d', 'num', 5, 'diameter'], ['depth', 'num', 10], ['cboreD', 'num', 0, 'counterbore diameter (0 = none)'], ['cboreDepth', 'num', 0],
    ['csinkD', 'num', 0, 'countersink diameter (0 = none)'], ['csinkAngle', 'num', 90]] },
  fillet: { label: 'Fillet', group: 'Modify', fields: [BODY, ['radius', 'num', 2], ['edges', 'edges', 'all']] },
  chamfer: { label: 'Chamfer', group: 'Modify', fields: [BODY, ['distance', 'num', 1], ['edges', 'edges', 'all']] },
  shell: { label: 'Shell', group: 'Modify', fields: [BODY, ['thickness', 'num', 2], ['faces', 'faces', { points: [] }, 'faces to remove (open)']] },
  draft: { label: 'Draft', group: 'Modify', fields: [BODY, ['angle', 'num', 3], ['faces', 'faces', { points: [] }], ['neutral', 'select:XY|XZ|YZ', 'XY']] },
  split: { label: 'Split', group: 'Modify', fields: [BODY, ['plane', 'select:XY|XZ|YZ', 'XY'], ['offset', 'num', 0], ['keep', 'select:positive|negative', 'positive']] },
  transform: { label: 'Move/Copy', group: 'Modify', fields: [BODY, ['translate', 'vec', [0, 0, 0]], ['angle', 'num', 0], ['axis', 'vec', [0, 0, 1]],
    ['origin', 'vec', [0, 0, 0]], ['scale', 'num', 1], ['copy', 'text', '', 'if set, leaves the original and names the copy']] },
  mirror: { label: 'Mirror', group: 'Pattern', fields: [BODY, ['plane', 'select:XY|XZ|YZ', 'YZ'], ['origin', 'vec', [0, 0, 0]], ['copy', 'text', '', 'if set, new body name; else fused into body']] },
  linearPattern: { label: 'Linear Pattern', group: 'Pattern', fields: [BODY, ['dir', 'vec', [1, 0, 0]], ['spacing', 'num', 20], ['count', 'num', 3],
    ['dir2', 'vec', [0, 1, 0]], ['spacing2', 'num', 20], ['count2', 'num', 1],
    ['op', 'select:add|new|cut|intersect', 'add', 'add = fuse copies into body; new = separate bodies; cut/intersect = use copies as tools on `target`'], ['target', 'body', '']] },
  circularPattern: { label: 'Circular Pattern', group: 'Pattern', fields: [BODY, ['axis', 'vec', [0, 0, 1]], ['origin', 'vec', [0, 0, 0]], ['count', 'num', 6], ['angle', 'num', 360, 'total angle'],
    ['op', 'select:add|new|cut|intersect', 'add'], ['target', 'body', '']] },
  boolean: { label: 'Boolean', group: 'Modify', fields: [['op', 'select:add|cut|intersect', 'add'], ['target', 'body', ''], ['tools', 'bodies', []], ['keepTools', 'bool', false]] },
  appearance: { label: 'Appearance', group: 'Assembly', fields: [BODY, ['color', 'color', '#8899aa'], ['opacity', 'num', 1], ['density', 'num', 1, 'g/cm^3 (steel 7.85, aluminium 2.7, PLA 1.24)'], ['hidden', 'bool', false]] },
  remove: { label: 'Delete Body', group: 'Assembly', fields: [BODY] },
  import: { label: 'Import STEP', group: 'Assembly', fields: [BODY, ['data', 'file', '', 'base64 STEP data'], ['path', 'text', '', 'or a file path (CLI/MCP only)']] },
};
export const SKETCH_ENTITIES = `SKETCH ENTITIES (2D, plane coordinates, every number may be an expression string like "w/2"):
 {t:"rect",cx,cy,w,h,r?,rot?}  {t:"circle",cx,cy,r}  {t:"ellipse",cx,cy,rx,ry,rot?}  {t:"polygon",cx,cy,r,n,rot?}
 {t:"slot",x1,y1,x2,y2,w}
 {t:"path",start:[x,y],closed:true,segs:[{to:[x,y]} | {to,via:[x,y]} (3-point arc) | {to,bulge} | {to,c1,c2} (bezier) | {to,tangent:true}, ...]}
   a seg may carry fillet:r to round the corner at its end.  Open paths (closed:false) are only used as sweep paths.
 Any closed entity may have mode:"cut" to subtract it (holes); default mode is "add" (overlapping adds are unioned).`;
export function defaults(type) {
  const o = { type };
  for (const [k, , d] of FEATURES[type].fields) o[k] = structuredClone(d);
  return o;
}
export function docs() {
  let s = `forgeCAD document = JSON {name, params:[{name,expr}], features:[{id,type,name?,suppressed?,...fields}]}.
Units mm / degrees. Features run top to bottom (parametric timeline). Any "num" may be an expression using params and Math (e.g. "w/2+sin(PI/4)").
Selectors (edges/faces): "all" | {points:[[x,y,z],...]} (nearest edge midpoint / face mid-point) | {dir:"X"|"Y"|"Z"} (edges along axis) | {plane:"XY"|"XZ"|"YZ",offset} (lying in plane) | {parallel:"XY"} — keys combine with AND.
FEATURES:\n`;
  for (const [t, f] of Object.entries(FEATURES))
    s += ` ${t}: ` + f.fields.map(([k, kind, d, h]) => `${k}<${kind}>=${JSON.stringify(d)}${h ? ' (' + h + ')' : ''}`).join('; ') + '\n';
  return s + SKETCH_ENTITIES + '\n';
}
