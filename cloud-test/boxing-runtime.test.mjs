import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('Worker boxing model wait leaves health, human input and D1 state responsive', { timeout: 30000 }, async t => {
  let release, seen;
  const arrived = new Promise(resolve => { seen = resolve; });
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const request = JSON.parse(raw); assert.equal(request.max_tokens, 1024);
    const observation = JSON.parse(request.messages[1].content);
    assert.ok(observation.self); assert.ok(!('input' in observation));
    release = () => res.end(JSON.stringify({ choices: [{ message: { content: '{"actions":["advance","jab"]}' } }] }));
    seen();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { release?.(); server.close(resolve); server.closeAllConnections(); }));
  const bundle = await build({ entryPoints: ['cloud/worker.mjs'], bundle: true, platform: 'neutral', format: 'esm', external: ['node:*', 'cloudflare:*'], write: false });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: { AI_MODE: 'model', MODEL_API_KEY: 'fixture', MODEL_CHAT_URL: `http://127.0.0.1:${server.address().port}/model` } });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) for (const sql of readFileSync('drizzle/' + file, 'utf8').split('--> statement-breakpoint')) if (sql.trim()) await db.prepare(sql).run();
  const call = (path, body) => mf.dispatchFetch('https://runtime.test' + path, { method: body ? 'POST' : 'GET', headers: { 'oai-authenticated-user-id': 'box-runtime', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await call('/api/pets', { name: 'Box', species: 'fox', defense: true });
  const lobby = await (await call('/api/boxing')).json();
  const match = await (await call('/api/boxing', { opponentId: lobby.pets.find(p => p.bot).id })).json();
  const working = call('/api/boxing/work', {});
  await arrived;
  const responses = await Promise.all([call('/api/health'), call(`/api/boxing/${match.id}/input`, { seq: 1, action: 'advance' }), call(`/api/boxing/${match.id}`)]);
  assert.ok(responses.every(r => r.status === 200));
  assert.equal((await responses[2].json()).status, 'active');
  release(); assert.deepEqual(await (await working).json(), { worked: true });
  const saved = JSON.parse((await db.prepare('SELECT data FROM boxing_matches WHERE id=?').bind(match.id).first()).data);
  assert.deepEqual(saved.petBout._controls[0].queue, ['advance', 'jab']);
});
