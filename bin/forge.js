#!/usr/bin/env node
// forge CLI + MCP server. The document JSON file is the single source of truth; the GUI live-reloads it.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import opencascade from 'replicad-opencascadejs';
import * as K from '../src/kernel.js';
import { docs, FEATURES, defaults, normalize } from '../src/schema.js';

const [cmd, ...args] = process.argv.slice(2);
const boot = async () => K.init(await opencascade({ wasmBinary: fs.readFileSync(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url)) }));
const load = (p) => normalize(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { name: path.basename(p, '.json') });
const save = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 1));
const r3 = (x) => (typeof x === 'number' ? +x.toFixed(3) : Array.isArray(x) ? x.map(r3) : x);
// target: {studio?: id} | {assembly?: id}. Default: the first part studio.
async function summary(doc, t = {}) {
  const r = await K.evaluate(doc, { mesh: false, readFile: (p) => fs.promises.readFile(p), studio: t.studio, assembly: t.assembly });
  return { ok: !Object.keys(r.errors).length, target: t.assembly ? { assembly: t.assembly } : { studio: t.studio || doc.studios[0].id }, errors: r.errors, params: r.params, ms: r.ms,
    sketches: Object.fromEntries(Object.entries(r.sketches).filter(([, s]) => s.solve).map(([k, s]) => [k, { constraintsSatisfied: s.solve.ok, degreesOfFreedom: s.solve.dof }])),
    bodies: r.bodies.map((b) => ({ name: b.name, volume_mm3: r3(b.volume), area_mm2: r3(b.area), mass_g: r3(b.mass), centerOfMass: r3(b.com), bbox: r3(b.bbox), faces: b.faces, edges: b.edges })),
    interference: K.interference().map((i) => ({ ...i, volume: r3(i.volume) })) };
}
const uid = (list, pre) => { let i = 1; while (list.some((f) => f.id === pre + i)) i++; return pre + i; };
const studioOf = (d, id) => { const s = id ? d.studios.find((x) => x.id === id) : d.studios[0]; if (!s) throw Error(`no part studio "${id}". Have: ${d.studios.map((x) => x.id).join(', ')}`); return s; };
const asmOf = (d, id) => { const a = id ? d.assemblies.find((x) => x.id === id) : d.assemblies[0]; if (!a) throw Error(`no assembly "${id || ''}". Have: ${d.assemblies.map((x) => x.id).join(', ') || 'none — call add_assembly'}`); return a; };
// Mutations shared by CLI and MCP. Each returns the evaluated summary so an agent sees errors immediately.
const ops = {
  schema: async () => docs(),
  get_document: async (p) => load(p),
  evaluate: async (p, a) => summary(load(p), a),
  set_document: async (p, { document }) => { normalize(document); save(p, document); return summary(document); },
  add_feature: async (p, { feature, index, studio }) => {
    const d = load(p), s = studioOf(d, studio);
    if (!FEATURES[feature.type]) throw Error(`unknown type "${feature.type}". Valid: ${Object.keys(FEATURES).join(', ')}`);
    const f = { ...defaults(feature.type), ...feature, id: feature.id || uid(s.features, feature.type) };
    if (s.features.some((x) => x.id === f.id)) throw Error(`feature id "${f.id}" already exists`);
    s.features.splice(index ?? s.features.length, 0, f); save(p, d);
    return { id: f.id, ...(await summary(d, { studio: s.id })) };
  },
  update_feature: async (p, { id, patch, studio }) => {
    const d = load(p), s = studioOf(d, studio), f = s.features.find((x) => x.id === id);
    if (!f) throw Error(`no feature "${id}" in ${s.id}. Have: ${s.features.map((x) => x.id).join(', ')}`);
    Object.assign(f, patch); save(p, d); return summary(d, { studio: s.id });
  },
  remove_feature: async (p, { id, studio }) => { const d = load(p), s = studioOf(d, studio); s.features = s.features.filter((x) => x.id !== id); save(p, d); return summary(d, { studio: s.id }); },
  set_param: async (p, { name, expr }) => {
    const d = load(p), q = d.params.find((x) => x.name === name);
    if (expr === null || expr === undefined) d.params = d.params.filter((x) => x.name !== name); else if (q) q.expr = String(expr); else d.params.push({ name, expr: String(expr) });
    save(p, d); return summary(d);
  },
  add_studio: async (p, { name }) => { const d = load(p), id = uid(d.studios, 'studio'); d.studios.push({ id, name: name || id, features: [] }); save(p, d); return { id }; },
  add_assembly: async (p, { name }) => { const d = load(p), id = uid(d.assemblies, 'assembly'); d.assemblies.push({ id, name: name || id, instances: [], mates: [] }); save(p, d); return { id }; },
  add_instance: async (p, { instance, assembly }) => {
    const d = load(p), a = asmOf(d, assembly), i = { translate: [0, 0, 0], rotate: [0, 0, 0], ...instance, id: instance.id || uid(a.instances, 'inst') };
    studioOf(d, i.studio); a.instances.push(i); save(p, d); return { id: i.id, ...(await summary(d, { assembly: a.id })) };
  },
  add_mate: async (p, { mate, assembly }) => {
    const d = load(p), a = asmOf(d, assembly), m = { k: 'fasten', angle: 0, offset: 0, flip: false, ...mate, id: mate.id || uid(a.mates, 'mate') };
    a.mates.push(m); save(p, d); return { id: m.id, ...(await summary(d, { assembly: a.id })) };
  },
  update_assembly_item: async (p, { id, patch, assembly }) => {
    const d = load(p), a = asmOf(d, assembly), x = [...a.instances, ...a.mates].find((y) => y.id === id);
    if (!x) throw Error(`no instance or mate "${id}" in ${a.id}`);
    if (patch === null) { a.instances = a.instances.filter((y) => y.id !== id); a.mates = a.mates.filter((y) => y.id !== id); } else Object.assign(x, patch);
    save(p, d); return summary(d, { assembly: a.id });
  },
  export: async (p, { out, studio, assembly }) => {
    await summary(load(p), { studio, assembly });
    const kind = { '.step': 'step', '.stp': 'step', '.stl': 'stl', '.svg': 'svg' }[path.extname(out).toLowerCase()];
    if (!kind) throw Error('output must end in .step, .stl or .svg (3-view drawing)');
    const bytes = await K.exportModel(kind); fs.writeFileSync(out, bytes); return { wrote: out, bytes: bytes.length };
  },
};
const S = { type: 'string' }, O = { type: 'object' };
const TOOLS = [
  ['schema', 'Read this first: the full document format, every feature type with fields and defaults, sketch entities, constraints, selectors, assemblies and mates.', {}],
  ['get_document', 'Return the current CAD document JSON.', {}],
  ['evaluate', 'Rebuild a part studio (default: the first) or an assembly; returns errors, sketch constraint status, body volumes/mass/bounding boxes, interference.', { studio: S, assembly: S }],
  ['add_feature', 'Append (or insert at index) a feature to a part studio; missing fields get defaults. Returns the evaluation.', { feature: O, index: { type: 'number' }, studio: S }, ['feature']],
  ['update_feature', 'Shallow-merge patch into the feature with this id. Returns the evaluation.', { id: S, patch: O, studio: S }, ['id', 'patch']],
  ['remove_feature', 'Delete a feature by id.', { id: S, studio: S }, ['id']],
  ['set_param', 'Create/update a named parameter (expression string); expr null deletes it.', { name: S, expr: { type: ['string', 'number', 'null'] } }, ['name']],
  ['add_studio', 'Create a new empty part studio; returns its id.', { name: S }],
  ['add_assembly', 'Create a new empty assembly; returns its id.', { name: S }],
  ['add_instance', 'Insert a part-studio body into an assembly: {studio, body?, translate?, rotate?}.', { instance: O, assembly: S }, ['instance']],
  ['add_mate', 'Add a mate {k, a:{inst,point}, b:{inst,point}, angle?, offset?, flip?}; instance b moves onto a.', { mate: O, assembly: S }, ['mate']],
  ['update_assembly_item', 'Patch an instance or mate by id (e.g. {angle:45} to drive a revolute mate); patch null deletes it.', { id: S, patch: { type: ['object', 'null'] }, assembly: S }, ['id']],
  ['set_document', 'Replace the whole document.', { document: O }, ['document']],
  ['export', 'Export a part studio or assembly to a file: .step, .stl, or .svg (front/top/right drawing).', { out: S, studio: S, assembly: S }, ['out']],
];

async function mcp(docPath) {
  await boot();
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  for await (const line of readline.createInterface({ input: process.stdin })) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue;
    const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') ok({ protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'forgeCAD', version: '0.2.0' }, instructions: 'Parametric CAD with part studios and assemblies. Call `schema` first. Edits are saved to the document file and appear live in the forgeCAD GUI.' });
    else if (m.method === 'tools/list') ok({ tools: TOOLS.map(([name, description, properties, required = []]) => ({ name, description, inputSchema: { type: 'object', properties, required } })) });
    else if (m.method === 'tools/call') {
      try { if (!ops[m.params.name]) throw Error('unknown tool ' + m.params.name); const r = await ops[m.params.name](docPath, m.params.arguments || {}); ok({ content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }] }); }
      catch (e) { ok({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] }); }
    } else if (m.method === 'ping') ok({});
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
  }
}

const J = (s) => { try { return JSON.parse(s); } catch (e) { throw Error('invalid JSON argument: ' + e.message); } };
const usage = `forge — local parametric CAD
  forge schema                             print the document/feature reference
  forge eval <doc.json> [id]               rebuild a part studio or assembly (by id), print errors + mass properties
  forge add <doc.json> '<feature json>'    append a feature to the first part studio
  forge set <doc.json> <id> '<patch>'      patch a feature
  forge rm <doc.json> <id>                 remove a feature
  forge param <doc.json> <name> [expr]     set (or delete) a parameter
  forge export <doc.json> <out.step|.stl|.svg> [id]
  forge call <doc.json> <tool> '<args>'    call any MCP tool from the shell (add_instance, add_mate, ...)
  forge mcp [doc.json]                     MCP server on stdio (default ./model.json)
  npm start                                open the GUI (FORGE_DOC=path to pick the document)`;
try {
  if (cmd === 'mcp') await mcp(path.resolve(args[0] || process.env.FORGE_DOC || 'model.json'));
  else if (cmd === 'schema') console.log(docs());
  else if (['eval', 'add', 'set', 'rm', 'param', 'export', 'call'].includes(cmd) && args[0]) {
    await boot();
    const p = path.resolve(args[0]), tgt = (id) => (!id ? {} : load(p).assemblies.some((a) => a.id === id) ? { assembly: id } : { studio: id });
    const r = cmd === 'eval' ? await ops.evaluate(p, tgt(args[1])) : cmd === 'add' ? await ops.add_feature(p, { feature: J(args[1]) }) : cmd === 'set' ? await ops.update_feature(p, { id: args[1], patch: J(args[2]) })
      : cmd === 'rm' ? await ops.remove_feature(p, { id: args[1] }) : cmd === 'param' ? await ops.set_param(p, { name: args[1], expr: args[2] })
      : cmd === 'call' ? await (ops[args[1]] || (() => { throw Error('unknown tool ' + args[1]); }))(p, J(args[2] || '{}')) : await ops.export(p, { out: path.resolve(args[1]), ...tgt(args[2]) });
    console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1));
    if (r.ok === false) process.exitCode = 1;
  } else console.log(usage);
} catch (e) { console.error('error: ' + (e.message || e)); process.exitCode = 1; }
