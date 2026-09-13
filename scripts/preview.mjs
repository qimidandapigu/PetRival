import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import worker from '../cloud/worker.mjs';
import { database } from '../cloud-test/support.mjs';
const root = resolve('dist/client');
const db = database();
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const env = { DB: db, AI_MODE: 'algorithm', ASSETS: { async fetch(req) {
  const path = new URL(req.url).pathname;
  const filename = resolve(root, '.' + (path === '/' ? '/index.html' : path));
  if (!filename.startsWith(root + sep)) return new Response('Not found', { status: 404 });
  try { return new Response(await readFile(filename), { headers: { 'content-type': types[extname(filename)] || 'application/octet-stream' } }); }
  catch { return new Response('Not found', { status: 404 }); }
} } };
const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) });
    const response = await worker.fetch(request, env, {});
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch { res.writeHead(500); res.end('Preview unavailable'); }
});
server.listen(0, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${server.address().port}`));
