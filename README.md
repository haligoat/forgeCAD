# forgeCAD

Open-source parametric CAD that runs entirely on your machine. A real B-rep kernel (OpenCascade compiled to WASM), a feature timeline, and three ways in: GUI, CLI, and an MCP server so AI agents can model alongside you.

No cloud, no account, no telemetry. The document is a plain JSON file you can diff and version with git.

## Quick start

```bash
npm install
npm test           # rebuilds examples/showcase.json headless
npm start          # GUI at http://localhost:5173
```

## What it does

- **Parametric timeline** — every feature is an entry in `features[]`, rebuilt top to bottom. Named parameters and expressions (`"w/2 + 3"`) anywhere a number goes.
- **Sketch** — rect, circle, ellipse, polygon, slot, paths with lines / 3-point arcs / tangent arcs / beziers / corner fillets, on base planes, offset planes or model faces. Cut-mode entities make holes.
- **Create** — extrude (symmetric, twist, taper), revolve, loft, sweep, coil, box, cylinder, sphere, cone, torus.
- **Modify** — hole (counterbore / countersink), fillet, chamfer, shell, draft, split, booleans, move / rotate / scale / copy.
- **Pattern** — mirror, linear (2-direction), circular; patterns can add, make bodies, or cut a target.
- **Multi-body** — named bodies, colour, opacity, density, mass properties, interference check.
- **Interchange** — STEP import and export, STL export, SVG 3-view drawing with hidden lines.

## CLI

```bash
node bin/forge.js schema                               # full feature reference
node bin/forge.js eval model.json                      # errors + volume / mass / bbox
node bin/forge.js add model.json '{"type":"box","size":[40,30,10],"body":"base"}'
node bin/forge.js set model.json box1 '{"size":[50,30,10]}'
node bin/forge.js param model.json w 60
node bin/forge.js export model.json out.step           # or .stl / .svg
```

## AI / MCP

```json
{ "mcpServers": { "forgecad": { "command": "node", "args": ["/path/to/forgeCAD/bin/forge.js", "mcp", "/path/to/model.json"] } } }
```

Tools: `schema`, `get_document`, `evaluate`, `add_feature`, `update_feature`, `remove_feature`, `set_param`, `set_document`, `export`. Every edit returns the rebuilt model's errors and mass properties, so an agent gets feedback on each step. The GUI live-reloads the same file.

## Not there yet

Honest list: no geometric sketch constraint solver (dimensions are driven by parameters and expressions instead), no assembly mates / joints, no sheet metal, CAM, simulation, surfacing tools or dimensioned drawings. Contributions welcome.

## License

MIT. The kernel dependency `replicad-opencascadejs` is LGPL-2.1.
