import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { solve } from '../shared/game.mjs';

test('actual Worker runtime reaches model HTTP for gameplay and rejects redirects without forwarding credentials', { timeout: 60000 }, async t => {
  let calls = 0, redirected = 0, redirect = false;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/redirected') { redirected++; res.end('{}'); return; }
    calls++;
    assert.equal(req.headers.authorization, 'Bearer runtime-test-key');
    if (redirect) { res.writeHead(307, { location: '/redirected' }); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw), board = JSON.parse(request.messages[1].content).rows;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ actions: solve(board).actions }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const output = await build({ entryPoints: ['cloud/worker.mjs'], bundle: true, platform: 'neutral', format: 'esm', target: 'es2022', external: ['node:*', 'cloudflare:*'], write: false });
  const mf = new Miniflare({ modules: true, script: output.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: { AI_MODE: 'model', MODEL_NAME: 'runtime-test', MODEL_API_KEY: 'runtime-test-key', MODEL_CHAT_URL: `http://127.0.0.1:${server.address().port}/model` } });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint')) if (sql.trim()) await db.prepare(sql.trim()).run();
  }
  const call = async (path, body) => {
    const response = await mf.dispatchFetch(`https://runtime.test${path}`, { method: body ? 'POST' : 'GET', headers: { 'oai-authenticated-user-id': 'runtime-user', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
  };
  await call('/api/pets', { name: 'RuntimePet', species: 'xiaotangyuan', defense: true });
  const state = await call('/api/state'), rival = state.pets.find(p => p.bot);
  const match = await call('/api/challenges', { opponentId: rival.id });
  const worked = await call('/api/work?lane=foreground', {});
  assert.deepEqual(worked, { worked: true }); assert.equal(calls, 1);
  const live = await call(`/api/challenges/${match.id}`);
  assert.equal(live.status, 'active'); assert.equal(live.sides.find(s => s.own).agent.status, 'running');
  const job = await db.prepare("SELECT data FROM jobs WHERE kind='play' AND status='done'").first();
  assert.ok(job, 'successful model result was committed in D1');
  redirect = true;
  const failure = await call('/api/work?lane=foreground', {});
  assert.equal(failure.failed, true); assert.equal(calls, 2); assert.equal(redirected, 0);
  assert.equal((await call(`/api/challenges/${match.id}`)).status, 'void');
  assert.equal((await call('/api/state')).mine.score, 0);
});
