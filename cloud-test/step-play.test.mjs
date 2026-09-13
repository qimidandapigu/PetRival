import test from 'node:test';
import assert from 'node:assert/strict';
import { transaction } from '../cloud/store.mjs';
import { CloudArena } from '../cloud/arena.mjs';
import { makeBrain, executeJob } from '../cloud/brain.mjs';
import { replay, RULES } from '../shared/game.mjs';
import { database } from './support.mjs';

const rows = ['########', '#      #', '# .  . #', '# $  $ #', '# @    #', '#      #', '#      #', '########'];
async function fixture() {
  const db = database(), brain = makeBrain({ AI_MODE: 'model', MODEL_API_KEY: 'test-only' });
  let now = Date.now();
  const act = fn => transaction(db, store => fn(new CloudArena(store, brain, { now: () => now }), store));
  await act(a => { const p = a.createPet('owner', { name: '测试', species: 'xiaotangyuan' }); const pet = a.s.pets[p.id]; a.s.levels[pet.readyId].rows = rows; });
  return { brain, act, later(ms) { now += ms; } };
}

test('cloud push decisions survive requests and animate only chosen pushes without exposing private state', async t => {
  const f = await fixture(); t.after(() => f.brain.close());
  const inputs = [];
  t.mock.method(f.brain, 'json', async (messages, options) => {
    const input = JSON.parse(messages[1].content); inputs.push(input);
    assert.equal(options.playEffort, 'none');
    assert.ok(!JSON.stringify(input).includes('proof'));
    assert.ok(input.availablePushes.every(p => !('actions' in p)));
    return { choice: input.availablePushes.find(p => p.onGoal).id };
  });
  const practice = await f.act(a => a.startPractice('owner'));
  for (let i = 0; i < 2; i++) {
    const claim = await f.act(a => a.claimJob('owner', 'foreground'));
    assert.equal(claim.run.playStyle, 'push');
    const result = await executeJob(f.brain, claim);
    await f.act(a => a.finishJob(claim, result));
    const waiting = await f.act(a => a.getPractice('owner', practice.id));
    assert.equal(waiting.run.status, 'running');
    assert.ok(!JSON.stringify(waiting.run).includes('_plan'));
    if (i === 0) assert.equal(waiting.run.actions, '', 'actions appear only at their execution time');
    f.later((result.actions.length + 1) * RULES.stepMs);
    await f.act(a => a.getPractice('owner', practice.id));
  }
  const done = await f.act(a => a.getPractice('owner', practice.id));
  assert.equal(done.run.status, 'cleared'); assert.ok(replay(rows, done.run.actions).won);
  assert.equal(inputs.length, 2); assert.notDeepEqual(inputs[0].rows, inputs[1].rows);
  assert.ok(inputs[1].recent.length); assert.equal(inputs[1].feedback.goalsFilled, 1);
  assert.equal((await f.act(a => a.view('owner'))).mine.score, 0);
});

test('cloud incremental invalid decisions retry twice then fail, never resetting deadline', async t => {
  const f = await fixture(); t.after(() => f.brain.close());
  t.mock.method(f.brain, 'json', async () => ({ choice: 'unlisted' }));
  const practice = await f.act(a => a.startPractice('owner'));
  for (let i = 0; i < 3; i++) {
    const claim = await f.act(a => a.claimJob('owner', 'foreground'));
    assert.equal(claim.run.deadline, practice.run.deadline);
    await f.act(a => a.finishJob(claim, { invalid: true }));
    assert.equal((await f.act(a => a.getPractice('owner', practice.id))).run.status, i === 2 ? 'failed' : 'running');
  }
});

test('cloud preview persists its stage and verified continuation without executing simulations or repeating model calls', async t => {
  const f = await fixture(); t.after(() => f.brain.close()); f.brain.pushPolicy = 'preview'; let calls = 0;
  t.mock.method(f.brain, 'json', async () => { calls++; return { stage: { box: { x: 2, y: 3 }, target: { x: 2, y: 2 } }, candidates: [{ pushes: [{ box: 'A', direction: 'U' }, { box: 'B', direction: 'U' }] }] }; });
  const practice = await f.act(a => a.startPractice('owner'));
  for (let i = 0; i < 2; i++) {
    const claim = await f.act(a => a.claimJob('owner', 'foreground'));
    const result = await executeJob(f.brain, claim);
    assert.ok(result.actions);
    await f.act(a => a.finishJob(claim, result));
    if (!i) { const run = (await f.act(a => a.getPractice('owner', practice.id))).run; assert.equal(run.actions, ''); assert.equal(run.status, 'running'); assert.ok(!JSON.stringify(run).includes('continuation')); }
    f.later((result.actions.length + 1) * RULES.stepMs); await f.act(a => a.getPractice('owner', practice.id));
  }
  const done = await f.act(a => a.getPractice('owner', practice.id));
  assert.equal(done.run.status, 'cleared'); assert.equal(calls, 1);
});
