import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http.mjs';
import { generate, solve } from '../shared/game.mjs';

test('step practice HTTP selects the short loop, locks its level, reuses a pending run, and keeps rankings unchanged', async t => {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'petrival-step-http-')),
    env: { AI_MODE: 'model', MODEL_API_KEY: 'fixture-only', MODEL_PLAY_EFFORT: 'low' } });
  app.brain.generate = async () => generate(56);
  let release, calls = 0, selected;
  const held = new Promise(resolve => { release = resolve; });
  app.brain.play = async (rows, options) => {
    calls++; selected = options.style; await held;
    return { actions: solve(rows).actions, elapsedMs: 20, method: 'model', model: 'deepseek-v4-pro', effort: 'none', playStyle: 'push', turn: 10 };
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release(); await app.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (path, data) => fetch(base + path, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const state = await (await post('/api/pets', { name: 'StepTester', species: 'fox' })).json();
  await app.arena.idle();
  assert.throws(() => app.arena.startPractice('invalid-owner', { style: 'unbounded' }), /未知试玩方式/);
  const practice = await (await post('/api/practice/start', { style: 'push' })).json();
  assert.equal(practice.run.playStyle, 'push'); assert.equal(practice.run.effort, 'none'); assert.equal(practice.ranked, false);
  const again = await (await post('/api/practice/start', { style: 'plan' })).json();
  assert.equal(again.id, practice.id); assert.equal(again.run.playStyle, 'push');
  assert.equal(calls, 1); assert.equal(selected, 'push');
  release(); await app.arena.idle();
  const ended = await (await fetch(base + `/api/practice/${practice.id}`, { headers: { cookie } })).json();
  assert.equal(ended.run.status, 'cleared'); assert.equal(ended.level.id, practice.level.id);
  const after = await (await fetch(base + '/api/state', { headers: { cookie } })).json();
  assert.equal(after.mine.score, state.mine.score); assert.equal(after.playEffort, 'low');
});
