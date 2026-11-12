// Kernel worker: keeps OpenCascade off the UI thread.
import opencascade from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import * as K from './kernel.js';

const ready = opencascade({ locateFile: () => wasmUrl }).then((oc) => K.init(oc));
const cmds = {
  evaluate: (doc, opts) => K.evaluate(doc, opts),
  export: (kind) => K.exportModel(kind),
  interference: () => K.interference(),
};
self.onmessage = async ({ data: { id, cmd, args } }) => {
  try {
    await ready;
    const result = await cmds[cmd](...args);
    const transfer = [];
    if (result?.bodies) for (const b of result.bodies) if (b.mesh) transfer.push(...Object.values(b.mesh).map((a) => a.buffer));
    self.postMessage({ id, result }, transfer);
  } catch (e) { self.postMessage({ id, error: String(e?.message || e) }); }
};
