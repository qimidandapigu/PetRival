import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http.mjs';
import { solve, replay } from '../shared/game.mjs';

async function modelFixture(t, behavior = {}) {
  const requests = [], held = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw); requests.push(body);
    const generation = body.messages[0].content.includes('design Sokoban');
    const respond = () => {
      if (behavior.unavailable && !generation) { res.writeHead(503); res.end('{}'); return; }
      let content;
      if (generation) {
        const skeleton = JSON.parse(body.messages[1].content).editableSkeleton;
        content = behavior.invalidGeneration || (behavior.repairOnce && requests.filter(r => r.messages[0].content.includes('design Sokoban')).length === 1) ? { rows: ['invalid'] } : { rows: skeleton };
      } else {
        const board = JSON.parse(body.messages[1].content).rows;
        content = { actions: behavior.invalidPlayer ? 'WIN' : behavior.badPlayer ? 'U' : solve(board).actions };
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    };
    if (generation && behavior.hold) held.push(respond); else respond();
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'petrival-model-test-')), env: { AI_MODE: 'model', MODEL_CHAT_URL: `http://127.0.0.1:${provider.address().port}/chat/completions`, MODEL_NAME: 'test-double', MODEL_API_KEY: 'local-test-only' } });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const release = () => { behavior.hold = false; held.splice(0).forEach(r => r()); };
  t.after(async () => { release(); await app.arena.idle(); await app.close(); await new Promise(r => { provider.close(r); provider.closeIdleConnections(); }); });
  const client = async name => {
    const login = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = async (path, input) => {
      const response = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) });
      const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
    };
    const created = await call('/api/pets', { name, species: 'fox', defense: true });
    return { call, pet: created.mine };
  };
  return { ...app, client, behavior, requests, held, release };
}

test('real provider HTTP wiring generates, repairs, verifies, and independently executes model moves', async t => {
  const f = await modelFixture(t, { repairOnce: true }), a = await f.client('ModelA'), b = await f.client('ModelB');
  await f.arena.idle();
  const ready = await a.call('/api/state'); assert.equal(ready.mine.level.method, 'model');
  assert.ok(f.requests.some(r => r.messages.some(m => m.content.includes('invalidDraft'))), 'repair feedback reached provider HTTP');
  const m = await a.call('/api/challenges', { opponentId: b.pet.id });
  await f.arena.idle();
  const loaded = await a.call(`/api/challenges/${m.id}`);
  assert.ok(loaded.sides.every(s => s.agent.status === 'cleared' && s.agent.method === 'model'));
  for (const request of f.requests.filter(r => r.messages[0].content.startsWith('Play Sokoban'))) {
    const input = JSON.parse(request.messages[1].content);
    assert.deepEqual(Object.keys(input).sort(), ['rows', 'turn']);
    assert.equal(request.messages.length, 2, 'no shared author or human conversation');
    assert.equal(JSON.stringify(request).includes('proof'), false);
  }
  const stored = f.arena.s.challenges[m.id];
  assert.ok(stored.sides.every(s => replay(f.arena.s.levels[s.levelId].rows, s.agent.actions).won), 'production game engine verified actual model moves');
});

test('malformed model moves are contestant failure, not a free voided match', async t => {
  const f = await modelFixture(t, { invalidPlayer: true }), a = await f.client('InvalidA'), b = await f.client('InvalidB');
  await f.arena.idle();
  const m = await a.call('/api/challenges', { opponentId: b.pet.id }); await f.arena.idle();
  const view = await a.call(`/api/challenges/${m.id}`);
  assert.equal(view.status, 'active');
  assert.ok(view.sides.every(s => s.agent.status === 'failed' && s.agent.score === -20));
});

test('challenge returns while model generation is held, locking cached levels without waiting', async t => {
  const f = await modelFixture(t, { hold: true }), a = await f.client('InstantA'), b = await f.client('InstantB');
  const result = await Promise.race([
    a.call('/api/challenges', { opponentId: b.pet.id }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('challenge awaited blocked model')), 2000); timer.unref(); }),
  ]);
  assert.equal(result.status, 'active');
  assert.equal(result.sides.find(s => s.own).level.id, b.pet.level.id);
  assert.ok(f.arena.s.pets[a.pet.id].preparing);
  f.release(); await f.arena.idle();
  const after = await a.call(`/api/challenges/${result.id}`);
  assert.equal(after.sides.find(s => s.own).level.id, b.pet.level.id);
  assert.notEqual(f.arena.s.pets[b.pet.id].readyId, b.pet.level.id);
});

test('bad model generation keeps old verified level; no silent algorithm fallback labelled model', async t => {
  const f = await modelFixture(t, { invalidGeneration: true }), a = await f.client('SafeCache');
  const old = a.pet.level.id; await f.arena.idle();
  const view = await a.call('/api/state');
  assert.equal(view.mine.level.id, old); assert.notEqual(view.mine.level.method, 'model');
  assert.ok(view.mine.prepareError); assert.equal(view.mine.preparing, false);
});

test('valid but unsuccessful model moves fail; model infrastructure error voids instead of penalizing', async t => {
  const f = await modelFixture(t, { badPlayer: true }), a = await f.client('TryA'), b = await f.client('TryB');
  await f.arena.idle();
  const m = await a.call('/api/challenges', { opponentId: b.pet.id }); await f.arena.idle();
  const failed = await a.call(`/api/challenges/${m.id}`);
  assert.ok(failed.sides.every(s => s.agent.status === 'failed' && s.agent.score === -20));
  f.behavior.unavailable = true;
  const c = await f.client('TryC'); await f.arena.idle();
  const outage = await a.call('/api/challenges', { opponentId: c.pet.id }); await f.arena.idle();
  const voided = await a.call(`/api/challenges/${outage.id}`);
  assert.equal(voided.status, 'void'); assert.equal((await a.call('/api/state')).mine.score, 0);
});
