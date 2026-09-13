import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudStore, transaction } from '../cloud/store.mjs';
import { CloudArena } from '../cloud/arena.mjs';
import { makeBrain, executeJob } from '../cloud/brain.mjs';
import { solve, RULES } from '../shared/game.mjs';
import { database } from './support.mjs';
import worker from '../cloud/worker.mjs';

function fixture() {
  const db = database(), brain = makeBrain({ AI_MODE: 'algorithm' }); let now = Date.now();
  const act = fn => transaction(db, store => fn(new CloudArena(store, brain, { now: () => now }), store));
  return { db, brain, act, later(ms) { now += ms; }, async job() {
    const claim = await act(a => a.claimJob()); if (!claim) return false;
    const result = await executeJob(brain, claim); await act(a => a.finishJob(claim, result)); return true;
  } };
}
async function players(f) {
  const a = await f.act(arena => arena.createPet('alice', { name: '汤圆', species: 'xiaotangyuan', defense: true }));
  const b = await f.act(arena => arena.createPet('bob', { name: '狐狸', species: 'fox', defense: true }));
  return { a, b };
}

test('D1 revision conflicts reject stale writes without partial entity or ledger writes', async () => {
  const f = fixture(); await players(f);
  const first = await CloudStore.load(f.db), second = await CloudStore.load(f.db);
  const id = Object.values(first.state.pets).find(p => p.owner === 'alice').id;
  first.state.pets[id].name = 'new'; second.state.pets[id].name = 'stale';
  assert.equal(await first.commit(), true); assert.equal(await second.commit(), false);
  assert.equal((await CloudStore.load(f.db)).state.pets[id].name, 'new');
});

test('two players finish concurrently: locked levels, durable agent plans, scores and ledger settle exactly once', async () => {
  const f = fixture(), { a, b } = await players(f);
  const match = await f.act(arena => arena.challenge('alice', b.id));
  const locked = match.sides.map(s => s.level.id);
  await Promise.all([f.act(arena => arena.start('alice', match.id)), f.act(arena => arena.start('bob', match.id))]);
  await f.job(); await f.job();
  const live = await f.act(arena => arena.matchView(arena.matchFor(match.id, 'alice'), 'alice'));
  assert.equal(live.status, 'active'); assert.equal(live.sides[0].agent.status, 'running');
  assert.equal(JSON.stringify(live).includes('_plan'), false); assert.equal(JSON.stringify(live).includes('proof'), false);
  const before = await f.act(arena => arena.view('alice'));
  assert.equal(before.mine.score, 0);
  f.later(1000);
  const finishA = () => f.act(arena => arena.finish('alice', match.id, { actions: solve(match.sides[0].level.rows).actions, score: 999999 }));
  const finishB = () => f.act(arena => arena.finish('bob', match.id, { actions: '', giveUp: true, score: 999999 }));
  await Promise.all([finishA(), finishB()]);
  f.later(60000);
  await Promise.all([f.act(arena => arena.view('alice')), f.act(arena => arena.view('bob'))]);
  await Promise.all([finishA(), finishB(), finishA()]);
  const after = await f.act(arena => arena.view('alice'));
  assert.equal(after.mine.score, 200); assert.equal(after.mine.played, 1);
  assert.equal(after.leaderboard.find(p => p.id === b.id).score, 80);
  assert.equal(after.challenges[0].status, 'done');
  assert.deepEqual(after.challenges[0].sides.map(s => s.level.id), locked);
  assert.equal(f.db.connection.prepare('SELECT count(*) n FROM score_ledger').get().n, 2);
  assert.deepEqual({ ...f.db.connection.prepare('SELECT delta,total FROM score_ledger WHERE pet_id=?').get(a.id) }, { delta: 200, total: 200 });
  await f.job(); await f.job();
  const replaced = await f.act(arena => arena.view('alice'));
  assert.notEqual(replaced.mine.level.id, locked[1]);
  assert.deepEqual(replaced.challenges[0].sides.map(s => s.level.id), locked);
});

test('training never writes a score ledger and practice survives request reconstruction', async () => {
  const f = fixture(), { a } = await players(f);
  const bot = await f.act(arena => Object.values(arena.s.pets).find(p => p.bot).id);
  const match = await f.act(arena => arena.challenge('alice', bot));
  await f.act(arena => arena.start('alice', match.id));
  await f.job(); await f.job();
  await f.act(arena => arena.finish('alice', match.id, { actions: solve(match.sides[0].level.rows).actions }));
  f.later(60000); const view = await f.act(arena => arena.view('alice'));
  assert.equal(view.challenges[0].status, 'done'); assert.equal(view.mine.score, 0); assert.equal(view.mine.played, 0);
  assert.equal(f.db.connection.prepare('SELECT count(*) n FROM score_ledger').get().n, 0);
  const practice = await f.act(arena => arena.startPractice('alice'));
  await f.job(); f.later(60000);
  const replay = await f.act(arena => arena.getPractice('alice', practice.id));
  assert.equal(replay.run.status, 'cleared'); assert.equal(replay.ranked, false);
  assert.equal(JSON.stringify(replay).includes('_plan'), false);
  await assert.rejects(f.act(arena => arena.getPractice('bob', practice.id)), /无权/);
});

test('a disconnected model worker voids the match rather than penalizing pets', async () => {
  const f = fixture(), { b } = await players(f), match = await f.act(a => a.challenge('alice', b.id));
  const claimed = await f.act(a => a.claimJob()); assert.equal(claimed.kind, 'play');
  f.later(RULES.limitMs + 11000);
  const view = await f.act(a => a.view('alice'));
  assert.equal(view.challenges[0].status, 'void'); assert.equal(view.mine.score, 0);
  assert.equal(f.db.connection.prepare('SELECT count(*) n FROM score_ledger').get().n, 0);
});

test('HTTP identity follows the same signed-in user on another device; others cannot change the pet', async () => {
  const db = database(), env = { DB: db, AI_MODE: 'algorithm' };
  const call = (path, user, body) => worker.fetch(new Request(`https://example.test${path}`, { method: body ? 'POST' : 'GET', headers: { 'oai-authenticated-user-id': user, ...(body ? { 'Content-Type': 'application/json', Origin: 'https://example.test' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, {});
  assert.equal((await call('/api/session', 'account-a', {})).status, 200);
  const created = await call('/api/pets', 'account-a', { name: '小汤圆', species: 'xiaotangyuan', defense: true });
  assert.equal(created.status, 201);
  const view = await (await call('/api/state', 'account-a')).json();
  assert.equal(view.mine.name, '小汤圆'); assert.equal(view.storage, 'D1'); assert.equal(view.signedIn, true);
  assert.equal((await (await call('/api/state', 'account-b')).json()).mine, null);
  const bad = await call('/api/pets/appearance', 'account-a', { score: 999999 }); assert.equal(bad.status, 422);
  const csrf = await worker.fetch(new Request('https://example.test/api/pets', { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{}' }), env, {});
  assert.equal(csrf.status, 403);
  const malformed = await worker.fetch(new Request('https://example.test/api/pets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' }), env, {});
  assert.equal(malformed.status, 400);
});

test('winning model plan with trailing moves stops on the win and cannot poison later requests', async () => {
  const f = fixture(); await players(f);
  const p = await f.act(a => a.startPractice('alice'));
  const job = await f.act(a => a.claimJob('alice'));
  const solution = solve(p.level.rows).actions;
  await f.act(a => a.finishJob(job, { actions: solution + 'UD' }));
  f.later(60000);
  const done = await f.act(a => a.getPractice('alice', p.id));
  assert.equal(done.run.status, 'cleared'); assert.equal(done.run.actions, solution);
  assert.equal((await f.act(a => a.view('alice'))).mine.score, 0);
});

test('unrelated users cannot claim another match; a late model error cannot void an already timed-out run', async () => {
  const f = fixture(), { b } = await players(f);
  const match = await f.act(a => a.challenge('alice', b.id));
  assert.equal(await f.act(a => a.claimJob('mallory')), null);
  const job = await f.act(a => a.claimJob('alice'));
  f.later(RULES.limitMs + 1);
  let view = await f.act(a => a.view('alice'));
  assert.equal(view.challenges[0].sides[0].agent.status, 'failed');
  await f.act(a => a.failJob(job, 'late provider error'));
  view = await f.act(a => a.view('alice'));
  assert.equal(view.challenges[0].status, 'active');
});

test('late visit settles already completed plans before applying the 24 hour expiry', async () => {
  const f = fixture(), { b } = await players(f), match = await f.act(a => a.challenge('alice', b.id));
  await f.act(a => a.start('alice', match.id)); await f.act(a => a.start('bob', match.id));
  await f.job(); await f.job();
  await f.act(a => a.finish('alice', match.id, { actions: solve(match.sides[0].level.rows).actions }));
  await f.act(a => a.finish('bob', match.id, { actions: solve(match.sides[1].level.rows).actions }));
  f.later(25 * 3600000);
  const view = await f.act(a => a.view('alice'));
  assert.equal(view.challenges[0].status, 'done'); assert.equal(view.mine.score, 200);
  const rows = f.db.connection.prepare('SELECT created_at FROM score_ledger').all();
  assert.ok(rows.every(row => row.created_at < match.expiresAt));
});

test('two started humans time out after leaving; an unstarted human still causes the 24 hour void', async () => {
  for (const started of [true, false]) {
    const f = fixture(), { b } = await players(f), match = await f.act(a => a.challenge('alice', b.id));
    await f.act(a => a.start('alice', match.id)); if (started) await f.act(a => a.start('bob', match.id));
    await f.job(); await f.job(); f.later(25 * 3600000);
    const view = await f.act(a => a.view('alice'));
    assert.equal(view.challenges[0].status, started ? 'done' : 'void');
    assert.equal(view.mine.score, started ? 80 : 0);
  }
});

test('Sites verified-email identity works without an optional user-id header or browser cookie', async () => {
  const env = { DB: database(), AI_MODE: 'algorithm' };
  const call = (email, path, body) => worker.fetch(new Request(`https://example.test${path}`, { method: body ? 'POST' : 'GET', headers: { 'oai-authenticated-user-email': email, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, {});
  assert.equal((await call('Owner@example.test', '/api/pets', { name: '小汤圆', species: 'xiaotangyuan', defense: true })).status, 201);
  const view = await (await call('owner@example.test', '/api/state')).json();
  assert.equal(view.mine.name, '小汤圆'); assert.equal(view.signedIn, true);
  assert.equal(JSON.stringify(view).includes('owner@example.test'), false);
  assert.equal((await (await call('other@example.test', '/api/state')).json()).mine, null);
});
