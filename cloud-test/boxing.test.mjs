import test from 'node:test';
import assert from 'node:assert/strict';
import { transaction } from '../cloud/store.mjs';
import { CloudArena } from '../cloud/arena.mjs';
import { CloudBoxing } from '../cloud/boxing.mjs';
import { makeBrain } from '../cloud/brain.mjs';
import { database } from './support.mjs';
import worker from '../cloud/worker.mjs';

async function fixture(mode = 'algorithm') {
  const db = database(), brain = makeBrain({ AI_MODE: mode, MODEL_API_KEY: 'test-only' }); let now = Date.now();
  const act = fn => transaction(db, store => { const arena = new CloudArena(store, brain, { now: () => now }); return fn(new CloudBoxing(arena, brain, { now: () => now }), arena); });
  const ids = await act((b, a) => ['alice', 'bob'].map(owner => a.createPet(owner, { name: owner, species: 'xiaotangyuan', defense: true }).id));
  return { db, brain, act, ids, later(ms) { now += ms; } };
}
test('cloud boxing reloads persistent independent lanes, validates identity and never backdates new human input', async t => {
  const f = await fixture('model'); t.after(() => f.brain.close());
  const game = await f.act(b => b.create('alice', f.ids[1]));
  assert.equal(game.petBout.fighters[0].maxHp, 30); assert.equal(game.human.fighters[1].maxHp, 150);
  f.later(3200); const before = await f.act(b => b.get('alice', game.id));
  assert.equal(before.petBout.frame, 20); assert.equal(before.status, 'active');
  await f.act(b => b.input('alice', game.id, { action: 'advance', seq: 1 }));
  assert.equal((await f.act(b => b.get('alice', game.id))).human.fighters[0].x, before.human.fighters[0].x);
  f.later(500); const moved = await f.act(b => b.get('alice', game.id));
  assert.ok(moved.human.fighters[0].x > before.human.fighters[0].x);
  assert.deepEqual(moved.petBout.fighters, before.petBout.fighters);
  await f.act(b => b.input('alice', game.id, { action: 'guard', seq: 1 }));
  f.later(100); assert.notEqual((await f.act(b => b.get('alice', game.id))).human.fighters[0].action, 'guard');
  await assert.rejects(f.act(b => b.get('intruder', game.id)), /无权/);
  assert.ok(!JSON.stringify(moved).includes('_controls')); assert.ok(!JSON.stringify(moved).includes('_skills'));
});
test('cloud boxing claims are fair, bounded and stale results cannot replay a model command', async t => {
  const f = await fixture('model'); t.after(() => f.brain.close());
  const game = await f.act(b => b.create('alice', f.ids[1]));
  assert.equal(await f.act(b => b.claim('intruder')), null);
  const first = await f.act(b => b.claim('alice')), second = await f.act(b => b.claim('bob'));
  assert.notEqual(first.fighter, second.fighter); assert.equal(await f.act(b => b.claim('alice')), null);
  await f.act(b => b.finish(first, { actions: ['advance'] }));
  await f.act(b => b.finish(first, { actions: ['heavy', 'heavy'] }));
  const third = await f.act(b => b.claim('alice')); assert.equal(third.label, 'human0');
  const queue = await f.act(b => b.control(first).control.queue); assert.deepEqual(queue, ['advance']);
  f.later(51000); await f.act(b => b.get('alice', game.id));
  await f.act(b => b.fail(second)); assert.equal((await f.act(b => b.get('alice', game.id))).status, 'active');
});
test('cloud boxing settlement commits once under concurrency and keeps Sokoban ranking unchanged', async t => {
  const f = await fixture(); t.after(() => f.brain.close());
  const game = await f.act(b => b.create('alice', f.ids[1])); await f.act(b => b.start('bob', game.id));
  f.later(50000);
  await Promise.all(Array.from({ length: 4 }, () => f.act(b => b.get('alice', game.id))));
  const state = await f.act((b, a) => ({ match: b.get('alice', game.id), pets: f.ids.map(id => a.s.pets[id]) }));
  assert.equal(state.match.status, 'done');
  for (const pet of state.pets) { assert.equal(pet.boxingRank.played, 1); assert.equal(pet.score, 0); }
});
test('three persistent model failures void cloud boxing without charging either rank', async t => {
  const f = await fixture('model'); t.after(() => f.brain.close());
  const game = await f.act(b => b.create('alice', f.ids[1]));
  for (let i = 0; i < 3; i++) {
    await f.act(b => { const c = b.s.boxingMatches[game.id].petBout._controls[0]; c.lastRequest = 0; });
    const claim = await f.act(b => b.claim('alice')); await f.act(b => b.fail(claim));
  }
  assert.equal((await f.act(b => b.get('alice', game.id))).status, 'void');
  assert.equal((await f.act((b, a) => a.s.pets[f.ids[0]])).boxingRank, undefined);
});
test('Sites boxing routes share existing phone/guest identity and protect cross-owner input', async () => {
  const db = database(), env = { DB: db, AI_MODE: 'algorithm' };
  const call = (path, who, body) => worker.fetch(new Request('https://example.test' + path, { method: body ? 'POST' : 'GET', headers: { 'oai-authenticated-user-id': who, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, {});
  await call('/api/pets', 'a', { name: 'A', species: 'fox', defense: true });
  const state = await (await call('/api/boxing', 'a')).json();
  const game = await (await call('/api/boxing', 'a', { opponentId: state.pets.find(p => p.bot).id })).json();
  assert.equal(game.status, 'active'); assert.equal(state.storage, 'D1');
  assert.equal((await call(`/api/boxing/${game.id}/input`, 'b', { seq: 1, action: 'jab' })).status, 404);
  assert.equal((await call(`/api/boxing/${game.id}`, 'a')).status, 200);
});

test('boxing skill is snapshotted at start, executes only for AI fighters and suppresses their model requests', async t => {
  const f = await fixture('model'); t.after(() => f.brain.close());
  await f.act((b, a) => { a.s.pets[f.ids[0]].competitionSkill = { name: '站立', gameId: 'boxing', description: '站立', code: 'ctx => "idle"' }; });
  const game = await f.act(b => b.create('alice', f.ids[1]));
  await f.act((b, a) => { a.s.pets[f.ids[0]].competitionSkill.code = 'ctx => "jab"'; });
  f.later(3000); const view = await f.act(b => b.get('alice', game.id));
  assert.equal(view.petBout.decisions[0].source, 'skill'); assert.equal(view.petBout.fighters[0].action, 'idle');
  assert.equal(view.human.decisions[0], null);
  const claim = await f.act(b => b.claim('alice')); assert.equal(claim.fighter, 1);
});

test('D1 preserves new rules and a quick throw tap after release; visible history survives reload', async t => {
 const f=await fixture('model');t.after(()=>f.brain.close());
 const game=await f.act(b=>b.create('alice',f.ids[1]));
 await f.act(b=>{const bout=b.s.boxingMatches[game.id].humans[0];bout.fighters[0].x=350;bout.fighters[1].x=440;bout._controls[1].queue=['guard'];});
 f.later(2200);await f.act(b=>b.input('alice',game.id,{action:'throw',seq:1}));await f.act(b=>b.input('alice',game.id,{action:'idle',seq:2}));
 f.later(300);const view=await f.act(b=>b.get('alice',game.id));
 assert.equal(view.human.rulesVersion,2);assert.equal(view.human.fighters[1].hp,146);
 assert.ok(view.human.history.some(e=>e.type==='guardbreak'));assert.ok(!JSON.stringify(view).includes('_controls'));
});
