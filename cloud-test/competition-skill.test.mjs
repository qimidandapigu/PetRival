import test from 'node:test';
import assert from 'node:assert/strict';
import { transaction } from '../cloud/store.mjs';
import { CloudArena } from '../cloud/arena.mjs';
import { makeBrain, executeJob } from '../cloud/brain.mjs';
import { replay, solve, RULES } from '../shared/game.mjs';
import { database } from './support.mjs';

const rows = ['########', '#      #', '# .  . #', '# $  $ #', '# @    #', '#      #', '#      #', '########'];
const skill = { name: '归位', gameId: 'sokoban', description: '先把箱子推入目标。', code: '(ctx: SkillContext) => ctx.availablePushes.find(p => p.onGoal && !p.wasOnGoal)?.id ?? null' };

test('D1 persists private skill, freezes practice source and executes skill across separate Worker jobs', async t => {
  const db = database(), brain = makeBrain({ AI_MODE: 'model', MODEL_API_KEY: 'fixture-only' });
  t.after(() => brain.close());
  t.mock.method(brain, 'json', async () => { throw new Error('No model needed for these skill decisions'); });
  let now = Date.now();
  const act = fn => transaction(db, store => fn(new CloudArena(store, brain, { now: () => now }), store));
  await act(a => {
    const p = a.createPet('owner', { name: '云技能', species: 'xiaotangyuan' });
    a.attachLevel(p, { rows, proof: solve(rows).actions, method: 'algorithm' });
    a.updateCompetitionSkill('owner', { revision: 0, skill });
  });
  assert.equal((await act(a => a.view('owner'))).mine.competition.equipped.code, skill.code);
  assert.ok(!JSON.stringify(await act(a => a.view('stranger'))).includes(skill.code));
  const practice = await act(a => a.startPractice('owner'));
  await act(a => a.updateCompetitionSkill('owner', { revision: 1, skill: null }));
  for (let i = 0; i < 2; i++) {
    const claim = await act(a => a.claimJob('owner', 'foreground'));
    assert.equal(claim.run._skill.code, skill.code);
    const result = await executeJob(brain, claim);
    assert.equal(result.skillStatus.state, 'used');
    await act(a => a.finishJob(claim, result));
    now += (result.actions.length + 1) * RULES.stepMs;
    await act(a => a.getPractice('owner', practice.id));
  }
  const done = await act(a => a.getPractice('owner', practice.id));
  assert.equal(done.run.status, 'cleared'); assert.equal(done.run.skillUses, 2);
  assert.ok(replay(rows, done.run.actions).won);
  assert.ok(!JSON.stringify(done).includes(skill.code));
});

test('D1 rejects stale or oversized writes without losing the prior skill', async t => {
  const db = database(), brain = makeBrain({ AI_MODE: 'algorithm' });
  t.after(() => brain.close());
  const act = fn => transaction(db, store => fn(new CloudArena(store, brain)));
  await act(a => { a.createPet('owner', { name: '验证', species: 'xiaotangyuan' }); a.updateCompetitionSkill('owner', { revision: 0, skill }); });
  await assert.rejects(act(a => a.updateCompetitionSkill('owner', { revision: 0, skill: null })), /其他页面/);
  await assert.rejects(act(a => a.updateCompetitionSkill('owner', { revision: 1, skill: { ...skill, description: ' a'.repeat(101) } })), /超过/);
  assert.equal((await act(a => a.view('owner'))).mine.competition.equipped.code, skill.code);
});
