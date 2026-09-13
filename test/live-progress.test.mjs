import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/http.mjs';
import { PetBrain } from '../server/provider.mjs';
import { generate, replay, solve, RULES } from '../shared/game.mjs';

async function until(check, message) {
  const start = Date.now();
  while (!(await check())) { if (Date.now() - start > 5000) throw new Error(message); await delay(10); }
}
async function fixture(t) {
  const requests = [], first = [], second = [];
  let holdFirst = true, holdSecond = true;
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); requests.push(request);
    const design = request.messages[0].content.startsWith('You design Sokoban');
    const input = JSON.parse(request.messages[1].content);
    const respond = () => {
      const content = design ? { rows: input.editableSkeleton } : { actions: input.turn === 1 ? solve(input.rows).actions.slice(0, 2) : solve(input.rows).actions };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    };
    if (!design && input.turn === 1 && holdFirst) first.push(respond);
    else if (!design && input.turn > 1 && holdSecond) second.push(respond);
    else respond();
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const env = { AI_MODE: 'model', MODEL_CHAT_URL: `http://127.0.0.1:${provider.address().port}/chat/completions`, MODEL_NAME: 'live-fixture', MODEL_API_KEY: 'fixture-only' };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'petrival-live-test-')), env, brainOptions: { stepMs: 10 } });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await app.close(); await new Promise(r => { provider.close(r); provider.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = async name => {
    const login = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = async (path, input) => {
      const response = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) });
      const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
    };
    const created = await call('/api/pets', { name, species: 'fox', defense: true });
    return { call, cookie, pet: created.mine };
  };
  return { ...app, client, requests, first, second, env,
    releaseFirst: () => { holdFirst = false; first.splice(0).forEach(r => r()); },
    releaseSecond: () => { holdSecond = false; second.splice(0).forEach(r => r()); } };
}

test('HTTP human starts during blocked planning and owner sees only executed AI prefix during next blocked plan', async t => {
  const f = await fixture(t), a = await f.client('LeftAI'), b = await f.client('RightHuman');
  await f.arena.idle();
  const match = await a.call('/api/challenges', { opponentId: b.pet.id });
  await until(() => f.first.length === 2, 'both initial model requests should be held');
  const started = await a.call(`/api/challenges/${match.id}/start`, {});
  const own = value => value.sides.find(s => s.own);
  assert.equal(own(started).human.status, 'running', 'human does not await model planning');
  assert.equal(own(started).agent.actions, '', 'no planned future moves are exposed');
  assert.match(own(started).agent.note, /思考/);
  assert.equal(own(started).agent.model, 'live-fixture');
  assert.equal(started.sides.find(s => !s.own).agent.actions, undefined);
  f.releaseFirst();
  await until(() => f.second.length === 2, 'both models should plan again after executing two moves');
  const live = await a.call(`/api/challenges/${match.id}`);
  const visible = own(live), prefix = solve(visible.level.rows).actions.slice(0, 2);
  assert.equal(visible.human.status, 'running');
  assert.equal(visible.agent.status, 'running');
  assert.equal(visible.agent.actions, prefix, 'engine-executed prefix is visible before the model completes');
  assert.equal(visible.agent.steps, replay(visible.level.rows, prefix).steps);
  assert.equal(replay(visible.level.rows, prefix).won, false);
  assert.equal(live.sides.find(s => !s.own).agent.actions, undefined, 'opponent future/replay stays hidden');
  assert.equal(JSON.stringify(live).includes('proof'), false);
  for (const request of f.requests.filter(r => r.messages[0].content.startsWith('Play Sokoban'))) {
    assert.deepEqual(Object.keys(JSON.parse(request.messages[1].content)).sort(), ['rows', 'turn']);
    assert.equal(request.messages.length, 2);
  }
  const realStartedAt = f.arena.s.challenges[match.id].sides[0].agent.startedAt;
  f.releaseSecond(); await f.arena.idle();
  const complete = own(await a.call(`/api/challenges/${match.id}`));
  assert.equal(complete.agent.status, 'cleared');
  assert.equal(replay(complete.level.rows, complete.agent.actions).won, true);
  assert.ok(complete.agent.elapsedMs >= complete.agent.actions.length * 10);
  assert.ok(complete.agent.elapsedMs <= Date.now() - realStartedAt + 20, 'execution delay is counted once, not charged again');
  assert.equal(complete.human.status, 'running');
});

test('one game clock bounds planning plus execution and retains only executed actions on timeout', async () => {
  let now = 0;
  const board = generate(51);
  const brain = new PetBrain({ run: async () => ({ actions: board.proof, solved: true }) }, { AI_MODE: 'algorithm' }, { stepMs: 0, now: () => now });
  try {
    const prefixes = [];
    const result = await brain.play(board.rows, { onProgress: p => { prefixes.push(p.actions); if (p.actions.length) now = RULES.limitMs + 1; } });
    assert.equal(result.timedOut, true); assert.equal(result.elapsedMs, RULES.limitMs);
    assert.equal(result.actions, board.proof.slice(0, 1));
    assert.equal(prefixes.at(-1), result.actions);
    assert.match(result.note, /超时/);
  } finally { brain.close(); }
});

test('HTTP live own-level practice is immediate, private, cached and excluded from rankings', async t => {
  const f = await fixture(t), a = await f.client('PracticeOwner'), b = await f.client('PracticeOther');
  await f.arena.idle();
  const practice = await a.call('/api/practice/start', {});
  assert.equal(practice.ranked, false); assert.equal(practice.run.status, 'running');
  assert.equal(practice.level.id, (await a.call('/api/state')).mine.level.id);
  await until(() => f.first.length === 1, 'practice planning should be pending');
  const duplicate = await a.call('/api/practice/start', {});
  assert.equal(duplicate.id, practice.id, 'double-click reuses existing run without another model request');
  const forbidden = await fetch(`http://127.0.0.1:${f.server.address().port}/api/practice/${practice.id}`, { headers: { cookie: b.cookie } });
  assert.equal(forbidden.status, 404);
  f.releaseFirst(); await until(() => f.second.length === 1, 'practice should execute prefix before second planning');
  const live = await a.call(`/api/practice/${practice.id}`);
  assert.equal(live.run.actions.length, 2); assert.equal(live.run.status, 'running');
  f.releaseSecond(); await f.arena.idle();
  const ended = await a.call(`/api/practice/${practice.id}`);
  assert.equal(ended.run.status, 'cleared'); assert.ok(replay(ended.level.rows, ended.run.actions).won);
  const state = await a.call('/api/state');
  assert.equal(state.mine.score, 0); assert.equal(state.mine.played, 0);
});

test('HTTP restart preserves executed prefix and voids interrupted AI instead of resetting competition clock', async t => {
  const f = await fixture(t), a = await f.client('RestartA'), b = await f.client('RestartB');
  await f.arena.idle();
  const match = await a.call('/api/challenges', { opponentId: b.pet.id });
  await until(() => f.first.length === 2, 'initial plans should be held');
  await a.call(`/api/challenges/${match.id}/start`, {});
  f.releaseFirst(); await until(() => f.second.length === 2, 'executed prefixes should exist');
  const before = await a.call(`/api/challenges/${match.id}`), own = m => m.sides.find(s => s.own);
  await f.close();
  const next = createApp({ dataDir: dirname(f.store.file), env: { AI_MODE: 'algorithm' }, brainOptions: { stepMs: 0 } });
  await new Promise(r => next.server.listen(0, '127.0.0.1', r)); t.after(() => next.close());
  const response = await fetch(`http://127.0.0.1:${next.server.address().port}/api/challenges/${match.id}`, { headers: { cookie: a.cookie } });
  assert.equal(response.status, 200); const after = await response.json();
  assert.equal(after.status, 'void'); assert.match(after.voidReason, /服务重启/);
  assert.equal(own(after).agent.actions, own(before).agent.actions);
  assert.equal(own(after).agent.startedAt, own(before).agent.startedAt);
  assert.equal(own(after).human.deadline, own(before).human.deadline);
  assert.equal(own(after).pet.played, 0); assert.equal(own(after).pet.score, 0);
});

test('close aborts active provider HTTP calls and queued requests without waiting for upstream response', async t => {
  const f = await fixture(t);
  const board = generate(52), input = [
    { role: 'system', content: 'Play Sokoban' },
    { role: 'user', content: JSON.stringify({ rows: board.rows, turn: 1 }) },
  ];
  const calls = Promise.allSettled([f.brain.json(input), f.brain.json(input), f.brain.json(input)]);
  await until(() => f.first.length === 2 && f.brain.queue.length === 1, 'active and queued HTTP calls should exist');
  f.brain.close();
  const results = await Promise.race([calls, delay(1000).then(() => { throw new Error('close did not cancel calls'); })]);
  assert.ok(results.every(r => r.status === 'rejected'));
  assert.equal(f.brain.calls, 0); assert.equal(f.brain.queue.length, 0);
  assert.equal(f.requests.length, 2, 'queued request was never sent');
});

test('default DeepSeek Pro request sends high thinking with reasoning-sized budget and no secret metadata', async t => {
  const observed = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    observed.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"actions":"U"}' } }] }) };
  });
  const brain = new PetBrain({}, { AI_MODE: 'model', MODEL_API_KEY: 'fixture-only' });
  try {
    await brain.json([{ role: 'user', content: 'Return JSON actions.' }]);
    assert.equal(observed[0].url, 'https://api.deepseek.com/chat/completions');
    assert.equal(observed[0].body.model, 'deepseek-v4-pro');
    assert.deepEqual(observed[0].body.thinking, { type: 'enabled' });
    assert.equal(observed[0].body.reasoning_effort, 'high');
    assert.equal(observed[0].body.max_tokens, 16384);
    assert.deepEqual(brain.info(), { mode: 'model', model: 'deepseek-v4-pro' });
  } finally { brain.close(); }
});
