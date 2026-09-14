import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { checkSkill, compileSkill, runSkill, skillDecision, boxingSkillDecision } from '../server/competition-skill.mjs';
import { Arena } from '../server/arena.mjs';
import { Store } from '../server/store.mjs';
import { PetBrain } from '../server/provider.mjs';
import { BoxingArena } from '../server/boxing-arena.mjs';
import { parse, solve, replay } from '../shared/game.mjs';
import { reachablePushes } from '../server/step-observation.mjs';

const rows = ['########', '#      #', '# .  . #', '# $  $ #', '# @    #', '#      #', '#      #', '########'];
const sample = { gameId: 'sokoban', name: '优先归位', description: '优先将未归位的箱子推入目标，避开死角。',
  code: '(ctx: SkillContext) =>\n  ctx.availablePushes.find(p => p.onGoal && !p.wasOnGoal && !p.corner)?.id ?? null' };

test('exact tokenizer counts description AND unmodified code, accepts 100, rejects 101 including comments', () => {
  const result = checkSkill(sample);
  assert.equal(result.valid, true);
  assert.equal(result.tokens, encode(sample.description).length + encode(sample.code).length);
  const code = '(ctx: SkillContext) => null';
  const used = encode(code).length;
  assert.equal(checkSkill({ ...sample, code, description: ' a'.repeat(100 - used) }).tokens, 100);
  assert.equal(checkSkill({ ...sample, code, description: ' a'.repeat(100 - used) }).valid, true);
  assert.equal(checkSkill({ ...sample, code, description: ' a'.repeat(101 - used) }).valid, false);
  assert.equal(checkSkill({ ...sample, code: `${code} /*${' a'.repeat(100)}*/` }).valid, false);
  assert.equal(checkSkill({ ...sample, tokens: 0 }).valid, false, 'client cannot forge token count');
});

test('restricted TS supports conditionals/const/queries, skips irrelevant skills and rejects capabilities', () => {
  const ctx = { availablePushes: [{ id: 'yes', corner: false, onGoal: true }] };
  assert.equal(runSkill(compileSkill('(ctx: SkillContext) => { const p = ctx.availablePushes.find(p => !p.corner); if (p) return p.id; return null; }'), ctx), 'yes');
  assert.equal(runSkill(compileSkill('(ctx: SkillContext) => ctx.availablePushes.find(p => p.corner)?.id ?? null'), ctx), null);
  for (const code of ['ctx => process.env', 'ctx => fetch("x")', 'ctx => ctx.constructor', 'ctx => { while(true) {} }', 'ctx => { ctx.score = 999; return null; }', 'ctx => new Function("return 1")()', 'async ctx => null', 'ctx => { throw 1; }', 'ctx => globalThis', 'ctx => ctx.availablePushes.map(x => x)']) {
    assert.equal(checkSkill({ ...sample, code }).valid, false, code);
  }
  assert.throws(() => runSkill(compileSkill('ctx => ctx["con" + "structor"]'), ctx), /原型/);
  assert.equal(skillDecision({ ...sample, code: 'ctx => "illegal"' }, ctx).status.state, 'error');
  assert.equal(skillDecision({ ...sample, code: 'ctx => "undo"' }, { ...ctx, canUndo: false }).choice, null);
  assert.equal(skillDecision({ ...sample, gameId: 'boxing' }, ctx).status, null);
  const expensive = compileSkill('ctx => ctx.availablePushes.every(p => ctx.availablePushes.every(q => ctx.availablePushes.every(r => true)))');
  assert.throws(() => runSkill(expensive, { availablePushes: Array.from({ length: 64 }, () => ({})) }), /预算/);
});

function fixture(t, mode = 'algorithm') {
  const dir = mkdtempSync(join(tmpdir(), 'petrival-skill-'));
  const brain = new PetBrain({ run: async (task, data) => task === 'solve' ? solve(data.rows) : { rows, proof: solve(rows).actions } },
    mode === 'model' ? { AI_MODE: 'model', MODEL_API_KEY: 'fixture-only' } : { AI_MODE: 'algorithm' }, { stepMs: 0 });
  const store = new Store(dir), arena = new Arena(store, brain);
  const pet = arena.makePet('owner', { name: '技能测试', species: 'xiaotangyuan', defense: true });
  arena.attachLevel(pet, { rows, proof: solve(rows).actions }); store.save();
  t.after(async () => { await arena.idle(); brain.close(); rmSync(dir, { recursive: true, force: true }); });
  return { arena, brain, store, pet, dir };
}

test('slot is owner scoped, versioned, persisted, private; invalid replacement preserves old skill', async t => {
  const { arena, brain, pet, dir } = fixture(t);
  assert.equal(arena.view('owner').mine.competition.equipped, null);
  const saved = arena.updateCompetitionSkill('owner', { revision: 0, skill: sample });
  assert.equal(saved.revision, 1); assert.equal(saved.slots, 1);
  assert.throws(() => arena.updateCompetitionSkill('owner', { revision: 0, skill: null }), /其他页面/);
  assert.throws(() => arena.updateCompetitionSkill('intruder', { revision: 1, skill: null }), /领养/);
  assert.throws(() => arena.updateCompetitionSkill('owner', { revision: 1, skill: { ...sample, code: 'ctx => "wrong"' } }), /不可用/);
  assert.equal(pet.competitionSkill.code, sample.code);
  assert.ok(!JSON.stringify(arena.view('intruder')).includes(sample.code));
  const restored = new Arena(new Store(dir), brain);
  assert.equal(restored.view('owner').mine.competition.equipped.code, sample.code);
  restored.updateCompetitionSkill('owner', { revision: 1, skill: null });
  assert.equal(new Store(dir).state.pets[pet.id].competitionSkill, null);
});

test('equipped TS actually solves two pushes without model or solver calls, and freezes practice/challenge source', async t => {
  const { arena, brain, pet } = fixture(t, 'model');
  t.mock.method(brain, 'json', async () => { throw new Error('Skill should choose both pushes'); });
  t.mock.method(brain.jobs, 'run', async () => { throw new Error('Skill must not call solver'); });
  arena.updateCompetitionSkill('owner', { revision: 0, skill: sample });
  const p = arena.startPractice('owner');
  arena.updateCompetitionSkill('owner', { revision: 1, skill: null });
  await arena.idle();
  const done = arena.getPractice('owner', p.id);
  assert.equal(done.run.status, 'cleared'); assert.equal(done.run.skillUses, 2);
  assert.ok(replay(rows, done.run.actions).won); assert.equal(done.run.skillStatus.state, 'used');
  assert.ok(!JSON.stringify(done).includes(sample.code));
  arena.updateCompetitionSkill('owner', { revision: 2, skill: sample });
  const rival = Object.values(arena.s.pets).find(p => p.bot);
  arena.attachLevel(rival, { rows, proof: solve(rows).actions });
  const match = arena.challenge('owner', rival.id);
  assert.equal(arena.s.challenges[match.id].sides[0].agent._skill.code, sample.code);
  arena.updateCompetitionSkill('owner', { revision: 3, skill: null });
  assert.equal(arena.s.challenges[match.id].sides[0].agent._skill.code, sample.code);
  assert.ok(!JSON.stringify(match).includes(sample.code));
});

test('null/error skills fall back to the original algorithm without consuming capacity', async t => {
  const { brain } = fixture(t);
  for (const code of ['ctx => null', 'ctx => "bad"']) {
    const skill = { ...sample, code }, result = await brain.play(rows, { skill });
    assert.ok(replay(rows, result.actions).won);
    assert.equal(result.skillUses, 0);
    assert.equal(result.skillStatus.state, code.includes('bad') ? 'error' : 'fallback');
  }
});

test('boxing skill uses visible fight state, freezes at creation, and applies only to AI fighters', async t => {
  const { arena, brain } = fixture(t);
  const skill = { gameId: 'boxing', name: '近身快拳', description: '远处接近，近处刺拳。', code: '(ctx: SkillContext) => ctx.distance > 114 ? "advance" : "jab"' };
  assert.equal(boxingSkillDecision(skill, { distance: 200 }).choice, 'advance');
  assert.equal(boxingSkillDecision(skill, { distance: 100 }).choice, 'jab');
  assert.equal(boxingSkillDecision({ ...skill, code: 'ctx => "throw"' }, {}).choice, 'throw');
  assert.equal(boxingSkillDecision({ ...skill, code: 'ctx => "win"' }, {}).status.state, 'error');
  arena.updateCompetitionSkill('owner', { revision: 0, skill });
  const boxing = new BoxingArena(arena, brain, { autoTick: false });
  const rival = Object.values(arena.s.pets).find(p => p.bot);
  const match = boxing.create('owner', rival.id);
  arena.updateCompetitionSkill('owner', { revision: 1, skill: null });
  const controller = boxing.controllers.get(`${match.id}:pet:0`);
  assert.equal(boxing.command(controller), 'advance');
  assert.equal(controller.bout.decisions[0].source, 'skill');
  controller.bout.frame += 10; controller.bout.fighters[1].x = controller.bout.fighters[0].x + 100;
  assert.equal(boxing.command(controller), 'jab');
  assert.equal(boxing.controllers.has(`${match.id}:human0:0`), false);
  assert.ok(!JSON.stringify(boxing.get('owner', match.id)).includes(skill.code));
  await boxing.close();
});
