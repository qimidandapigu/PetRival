import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http.mjs';
import { solve, generate, RULES } from '../shared/game.mjs';

async function fixture(t, directory) {
  let now = 1000000;
  const dataDir = directory || mkdtempSync(join(tmpdir(), 'petrival-test-'));
  const app = createApp({ dataDir, env: { AI_MODE: 'algorithm' }, now: () => now });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  const raw = async (path, input, cookie, extraHeaders = {}) => {
    const res = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie } : {}), ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders }, body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const client = async (name, defense = true) => {
    const login = await raw('/api/session', {});
    const call = (path, input) => raw(path, input, login.cookie);
    const created = await call('/api/pets', { name, species: 'sprout', defense });
    assert.equal(created.status, 201);
    return { cookie: login.cookie, call, pet: created.body.mine };
  };
  return { ...app, base, raw, client, dataDir, addTime: ms => { now += ms; } };
}
const own = m => m.sides.find(s => s.own);

test('real HTTP two-owner challenge: ready snapshots, both agents play, humans clear/fail, rank once', async t => {
  const f = await fixture(t), a = await f.client('Alpha'), b = await f.client('Beta');
  await f.arena.idle();
  const before = (await a.call('/api/state')).body;
  const start = performance.now();
  const created = await a.call('/api/challenges', { opponentId: b.pet.id });
  assert.equal(created.status, 201); assert.ok(performance.now() - start < 2000);
  const id = created.body.id, locked = own(created.body).level;
  assert.equal(created.body.training, false); assert.equal(created.body.status, 'active');
  assert.equal(JSON.stringify(created.body).includes('proof'), false);
  assert.equal(own(created.body).level.rows.length, 8);
  await f.arena.idle();
  const startedA = await a.call(`/api/challenges/${id}/start`, {});
  const startedB = await b.call(`/api/challenges/${id}/start`, {});
  assert.equal(startedA.body.sides.every(s => s.agent.status === 'cleared'), true);
  assert.equal(own(startedA.body).agent.actions, undefined, 'AI answer hidden before human finishes');
  assert.deepEqual(own(startedA.body).level, locked, 'background replenishment cannot change the match');
  assert.equal((await a.call(`/api/challenges/${id}/finish`, { actions: '', won: true, score: 999999, elapsedMs: 0 })).status, 422);
  f.addTime(1500);
  const clear = await a.call(`/api/challenges/${id}/finish`, { actions: solve(locked.rows).actions, score: 999999, elapsedMs: 0 });
  assert.equal(own(clear.body).human.score, 100); assert.equal(own(clear.body).human.elapsedMs, 1500);
  assert.ok(own(clear.body).agent.actions);
  const fail = await b.call(`/api/challenges/${id}/finish`, { actions: '', giveUp: true });
  assert.equal(fail.body.status, 'done'); assert.equal(fail.body.winner, a.pet.id);
  assert.equal(own(fail.body).human.score, -20); assert.equal(own(fail.body).human.rankMs, RULES.limitMs);
  const ranked = (await a.call('/api/state')).body;
  assert.equal(ranked.mine.score, 200); assert.equal(ranked.leaderboard.find(p => p.id === b.pet.id).score, 80);
  assert.equal(ranked.mine.played, 1);
  await a.call(`/api/challenges/${id}/finish`, { actions: '' });
  assert.equal((await a.call('/api/state')).body.mine.score, 200);
  assert.notEqual(f.arena.s.pets[a.pet.id].readyId, before.mine.level.id);
  assert.equal(startedB.body.sides.find(s => s.own).level.id, before.mine.level.id);
});

test('HTTP authorization, cross-site requests, static allowlist and one-pet ownership', async t => {
  const f = await fixture(t), a = await f.client('Owner'), b = await f.client('Other'), c = await f.client('Outsider');
  await f.arena.idle();
  const m = (await a.call('/api/challenges', { opponentId: b.pet.id })).body;
  assert.equal((await c.call(`/api/challenges/${m.id}`)).status, 404);
  assert.equal((await c.call(`/api/challenges/${m.id}/finish`, { actions: '', giveUp: true })).status, 404);
  assert.equal((await f.raw('/api/state')).status, 401);
  assert.equal((await f.raw('/api/pets/prepare', {}, a.cookie, { Origin: 'https://hostile.example' })).status, 403);
  assert.equal((await a.call('/api/pets', { name: 'duplicate', species: 'fox' })).status, 409);
  assert.equal((await fetch(f.base + '/.env')).status, 404);
  assert.equal((await fetch(f.base + '/data/petrival.json')).status, 404);
  assert.equal((await fetch(f.base + '/server/arena.mjs')).status, 404);
});

test('human timer survives repeated start and timeout; absence voids rather than assigning a loss', async t => {
  const f = await fixture(t), a = await f.client('Timer'), b = await f.client('Absent');
  await f.arena.idle();
  const m = (await a.call('/api/challenges', { opponentId: b.pet.id })).body;
  const started = (await a.call(`/api/challenges/${m.id}/start`, {})).body;
  f.addTime(5000);
  const repeated = (await a.call(`/api/challenges/${m.id}/start`, {})).body;
  assert.equal(own(started).human.deadline, own(repeated).human.deadline);
  f.addTime(RULES.limitMs);
  const timeout = (await a.call(`/api/challenges/${m.id}`)).body;
  assert.equal(own(timeout).human.status, 'failed'); assert.equal(own(timeout).human.score, -20);
  f.addTime(24 * 3600000);
  const expired = (await a.call(`/api/challenges/${m.id}`)).body;
  assert.equal(expired.status, 'void');
  assert.equal((await a.call('/api/state')).body.mine.score, 0);
  assert.equal((await b.call('/api/state')).body.mine.losses, 0);
});

test('training bots have no fabricated humans or ranked results', async t => {
  const f = await fixture(t), a = await f.client('Learner');
  await f.arena.idle();
  const view = (await a.call('/api/state')).body;
  const m = (await a.call('/api/challenges', { opponentId: view.pets.find(p => p.bot).id })).body;
  await a.call(`/api/challenges/${m.id}/start`, {}); await f.arena.idle();
  const ended = (await a.call(`/api/challenges/${m.id}/finish`, { actions: '', giveUp: true })).body;
  assert.equal(ended.status, 'done'); assert.equal(ended.training, true); assert.equal(ended.winner, null);
  assert.equal(ended.sides.find(s => !s.own).human.status, 'not_applicable');
  const after = (await a.call('/api/state')).body;
  assert.equal(after.mine.score, 0); assert.equal(after.mine.played, 0); assert.equal(after.leaderboard.length, 1);
});

test('durable identity, active deadline, immutable boards and settled results survive process recreation', async t => {
  const f = await fixture(t), a = await f.client('Saved'), b = await f.client('Stored');
  await f.arena.idle();
  const m = (await a.call('/api/challenges', { opponentId: b.pet.id })).body;
  await a.call(`/api/challenges/${m.id}/start`, {}); await f.arena.idle();
  const previous = (await a.call(`/api/challenges/${m.id}`)).body;
  await f.close();
  const next = await fixture(t, f.dataDir);
  const restored = await next.raw(`/api/challenges/${m.id}`, undefined, a.cookie);
  assert.equal(restored.status, 200); assert.equal(own(restored.body).human.deadline, own(previous).human.deadline);
  assert.deepEqual(own(restored.body).level, own(previous).level);
  const saved = JSON.parse(readFileSync(join(f.dataDir, 'petrival.json'), 'utf8'));
  assert.equal(Object.keys(saved.sessions).some(k => k === a.cookie.split('=')[1]), false, 'session token is hashed at rest');
});

test('defense opt-in, active match cap and duplicate pairing protect asynchronous opponents', async t => {
  const f = await fixture(t), a = await f.client('Challenger'), b = await f.client('Private', false);
  await f.arena.idle();
  assert.equal((await a.call('/api/challenges', { opponentId: b.pet.id })).status, 409);
  const c = await f.client('Defender'); await f.arena.idle();
  assert.equal((await a.call('/api/challenges', { opponentId: c.pet.id })).status, 201);
  assert.equal((await a.call('/api/challenges', { opponentId: c.pet.id })).status, 409);
});

test('equal team scores use server-measured time to choose the winning pet', async t => {
  const f = await fixture(t), a = await f.client('Fast'), b = await f.client('Slow');
  await f.arena.idle();
  const board = generate(41);
  f.arena.attachLevel(f.arena.s.pets[a.pet.id], board); f.arena.attachLevel(f.arena.s.pets[b.pet.id], board); f.store.save();
  const m = (await a.call('/api/challenges', { opponentId: b.pet.id })).body;
  await f.arena.idle();
  await a.call(`/api/challenges/${m.id}/start`, {}); await b.call(`/api/challenges/${m.id}/start`, {});
  f.addTime(1000); await a.call(`/api/challenges/${m.id}/finish`, { actions: board.proof });
  f.addTime(2000); const ended = (await b.call(`/api/challenges/${m.id}/finish`, { actions: board.proof })).body;
  assert.equal(ended.status, 'done'); assert.equal(ended.winner, a.pet.id);
  assert.ok(ended.sides.every(s => s.total.score === 200));
  assert.equal((await a.call('/api/state')).body.leaderboard[0].id, a.pet.id);
});
