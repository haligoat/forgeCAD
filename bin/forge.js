#!/usr/bin/env node
// forge CLI + MCP server. The document JSON file is the single source of truth; the GUI live-reloads it.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import opencascade from 'replicad-opencascadejs';
import * as K from '../src/kernel.js';
import { docs, FEATURES, defaults } from '../src/schema.js';

const [cmd, ...args] = process.argv.slice(2);
const boot = async () => K.init(await opencascade({ wasmBinary: fs.readFileSync(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url)) }));
const load = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { name: path.basename(p, '.json'), params: [], features: [] });
const save = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 1));
const r3 = (x) => (typeof x === 'number' ? +x.toFixed(3) : Array.isArray(x) ? x.map(r3) : x);
async function summary(doc) {
  const r = await K.evaluate(doc, { mesh: false, readFile: (p) => fs.promises.readFile(p) });
  return { ok: !Object.keys(r.errors).length, errors: r.errors, params: r.params, ms: r.ms,
    bodies: r.bodies.map((b) => ({ name: b.name, volume_mm3: r3(b.volume), area_mm2: r3(b.area), mass_g: r3(b.mass), centerOfMass: r3(b.com), bbox: r3(b.bbox), faces: b.faces, edges: b.edges })),
    interference: K.interference().map((i) => ({ ...i, volume: r3(i.volume) })) };
}
const newId = (doc, type) => { let i = 1; while (doc.features.some((f) => f.id === type + i)) i++; return type + i; };
// Mutations shared by CLI and MCP. Each returns the evaluated summary so an agent sees errors immediately.
const ops = {
  schema: async () => docs(),
  get_document: async (p) => load(p),
  evaluate: async (p) => summary(load(p)),
  set_document: async (p, { document }) => { save(p, document); return summary(document); },
  add_feature: async (p, { feature, index }) => {
    const d = load(p);
    if (!FEATURES[feature.type]) throw Error(`unknown type "${feature.type}". Valid: ${Object.keys(FEATURES).join(', ')}`);
    const f = { ...defaults(feature.type), ...feature, id: feature.id || newId(d, feature.type) };
    if (d.features.some((x) => x.id === f.id)) throw Error(`feature id "${f.id}" already exists`);
    d.features.splice(index ?? d.features.length, 0, f); save(p, d);
    return { id: f.id, ...(await summary(d)) };
  },
  update_feature: async (p, { id, patch }) => {
    const d = load(p), f = d.features.find((x) => x.id === id);
    if (!f) throw Error(`no feature "${id}". Have: ${d.features.map((x) => x.id).join(', ')}`);
    Object.assign(f, patch); save(p, d); return summary(d);
  },
  remove_feature: async (p, { id }) => { const d = load(p); d.features = d.features.filter((x) => x.id !== id); save(p, d); return summary(d); },
  set_param: async (p, { name, expr }) => {
    const d = load(p), q = (d.params ||= []).find((x) => x.name === name);
    if (expr === null || expr === undefined) d.params = d.params.filter((x) => x.name !== name); else if (q) q.expr = String(expr); else d.params.push({ name, expr: String(expr) });
    save(p, d); return summary(d);
  },
  export: async (p, { out }) => {
    await summary(load(p));
    const kind = { '.step': 'step', '.stp': 'step', '.stl': 'stl', '.svg': 'svg' }[path.extname(out).toLowerCase()];
    if (!kind) throw Error('output must end in .step, .stl or .svg (3-view drawing)');
    const bytes = await K.exportModel(kind); fs.writeFileSync(out, bytes); return { wrote: out, bytes: bytes.length };
  },
};
const TOOLS = [
  ['schema', 'Read this first: the full document format, every feature type with fields and defaults, sketch entities, selectors.', {}],
  ['get_document', 'Return the current CAD document JSON.', {}],
  ['evaluate', 'Rebuild the model; returns errors per feature, body volumes/mass/bounding boxes, interference.', {}],
  ['add_feature', 'Append (or insert at index) a feature; missing fields get defaults. Returns the evaluation.', { feature: { type: 'object' }, index: { type: 'number' } }, ['feature']],
  ['update_feature', 'Shallow-merge patch into the feature with this id. Returns the evaluation.', { id: { type: 'string' }, patch: { type: 'object' } }, ['id', 'patch']],
  ['remove_feature', 'Delete a feature by id.', { id: { type: 'string' } }, ['id']],
  ['set_param', 'Create/update a named parameter (expression string); expr null deletes it.', { name: { type: 'string' }, expr: { type: ['string', 'number', 'null'] } }, ['name']],
  ['set_document', 'Replace the whole document.', { document: { type: 'object' } }, ['document']],
  ['export', 'Export to a file: .step, .stl, or .svg (front/top/right drawing).', { out: { type: 'string' } }, ['out']],
];

async function mcp(docPath) {
  await boot();
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  for await (const line of readline.createInterface({ input: process.stdin })) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue;
    const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') ok({ protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'forgeCAD', version: '0.1.0' }, instructions: 'Parametric CAD. Call `schema` first. Edits are saved to the document file and appear live in the forgeCAD GUI.' });
    else if (m.method === 'tools/list') ok({ tools: TOOLS.map(([name, description, properties, required = []]) => ({ name, description, inputSchema: { type: 'object', properties, required } })) });
    else if (m.method === 'tools/call') {
      try { const r = await ops[m.params.name](docPath, m.params.arguments || {}); ok({ content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }] }); }
      catch (e) { ok({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] }); }
    } else if (m.method === 'ping') ok({});
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
  }
}

const J = (s) => { try { return JSON.parse(s); } catch (e) { throw Error('invalid JSON argument: ' + e.message); } };
const usage = `forge — local parametric CAD
  forge schema                           print the document/feature reference
  forge eval <doc.json>                  rebuild, print errors + mass properties
  forge add <doc.json> '<feature json>'  append a feature
  forge set <doc.json> <id> '<patch>'    patch a feature
  forge rm <doc.json> <id>               remove a feature
  forge param <doc.json> <name> [expr]   set (or delete) a parameter
  forge export <doc.json> <out.step|.stl|.svg>
  forge mcp [doc.json]                   MCP server on stdio (default ./model.json)
  npm start                              open the GUI (FORGE_DOC=path to pick the document)`;
try {
  if (cmd === 'mcp') await mcp(path.resolve(args[0] || process.env.FORGE_DOC || 'model.json'));
  else if (cmd === 'schema') console.log(docs());
  else if (['eval', 'add', 'set', 'rm', 'param', 'export'].includes(cmd) && args[0]) {
    await boot();
    const p = path.resolve(args[0]);
    const r = cmd === 'eval' ? await ops.evaluate(p) : cmd === 'add' ? await ops.add_feature(p, { feature: J(args[1]) }) : cmd === 'set' ? await ops.update_feature(p, { id: args[1], patch: J(args[2]) })
      : cmd === 'rm' ? await ops.remove_feature(p, { id: args[1] }) : cmd === 'param' ? await ops.set_param(p, { name: args[1], expr: args[2] }) : await ops.export(p, { out: path.resolve(args[1]) });
    console.log(JSON.stringify(r, null, 1));
    if (r.ok === false) process.exitCode = 1;
  } else console.log(usage);
} catch (e) { console.error('error: ' + (e.message || e)); process.exitCode = 1; }
