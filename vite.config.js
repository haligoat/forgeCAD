// Dev server + tiny local API: the document file on disk is the source of truth shared by GUI, CLI and MCP.
import fs from 'node:fs';
import path from 'node:path';

const DOC = path.resolve(process.env.FORGE_DOC || 'model.json');
const api = () => ({
  name: 'forge-api',
  configureServer(server) {
    const clients = new Set();
    let t;
    try {
      fs.watch(path.dirname(DOC), (ev, fn) => {
        if (fn !== path.basename(DOC)) return;
        clearTimeout(t);
        t = setTimeout(() => clients.forEach((r) => r.write('data: change\n\n')), 80);
      });
    } catch {}
    server.middlewares.use('/api/doc', (req, res) => {
      if (req.method === 'PUT') {
        let b = '';
        req.on('data', (c) => (b += c));
        req.on('end', () => { try { JSON.parse(b); fs.writeFileSync(DOC, b); res.end('ok'); } catch (e) { res.statusCode = 400; res.end(String(e)); } });
      } else {
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-forge-doc', encodeURIComponent(DOC));
        res.end(fs.readFileSync(fs.existsSync(DOC) ? DOC : 'examples/showcase.json'));
      }
    });
    server.middlewares.use('/api/events', (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    });
  },
});
export default {
  plugins: [api()],
  server: { port: 5173, host: '127.0.0.1' },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['replicad-opencascadejs'] },
  build: { target: 'esnext' },
};
