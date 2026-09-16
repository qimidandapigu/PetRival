import test from 'node:test';
import assert from 'node:assert/strict';
import { labWorld, labLevel, experimentBattery, scorePriorGuesses, reduceNotebook, hiddenTruth } from '../public/jump-lab.mjs';
import { probeJumpPrior, induceJumpMechanics, planJumpLab } from '../server/jump-model.mjs';

const fake = (fn) => ({ mode: 'model', info: () => ({ model: 'fixture-model' }), json: fn });
const seen = fn => { const calls = []; return { brain: fake(async (messages, options) => { calls.push({ messages, options }); return fn(calls.length, messages); }), calls }; };
const world = labWorld(54321);
const truth = hiddenTruth(world);
const noHidden = text => {
  for (const leak of ['speed', 'gravity', 'mapping', 'physics', '"cut"', '"jump"', 'left', 'right', String(world.seed)])
    assert.equal(text.includes(leak), false, `prompt leaked ${leak}`);
};

test('the prior probe measures what the model would guess with zero observations', async () => {
  const { brain, calls } = seen(() => ({ guesses: [{ channel: 'a', role: 'jump', confidence: .6 }, { channel: 'b', role: 'left', confidence: .4 }], note: '常识猜测' }));
  const result = await probeJumpPrior(brain, {});
  assert.equal(result.method, 'model'); assert.equal(result.guesses.length, 3);
  assert.deepEqual(result.guesses.map(g => g.channel), ['a', 'b', 'c']);
  assert.equal(result.guesses[2].role, 'unknown'); assert.equal(result.guesses[2].confidence, 0);
  const scored = scorePriorGuesses(result.guesses, world);
  assert.equal(scored.total, 3); assert.equal(typeof scored.hits, 'number');
  assert.equal(scored.rows.find(r => r.channel === 'c').hit, false);
  assert.equal(calls[0].messages[1].content.includes('experiments'), false);
  await assert.rejects(probeJumpPrior({ ...brain, mode: 'algorithm' }, {}), /未连接真实大模型/);
});

test('induction turns traces into a notebook whose states are counted, not self-declared', async () => {
  const traces = experimentBattery(world).slice(0, 4);
  const ops = [{ id: 'n1', claim: '通道 a 独自按住时 x 增加', state: '确认', evidence: [traces[0].id, traces[1].id, 'invented-id'], confidence: .95 }];
  const { brain, calls } = seen(() => ({ ops, nextExperiment: [{ a: true, b: false, c: false, frames: 20 }], note: '需要更多证据' }));
  const first = await induceJumpMechanics(brain, { world: { name: '世界 1', level: world.level }, traces });
  assert.equal(first.notebook.length, 1); assert.equal(first.notebook[0].state, '观察');
  assert.deepEqual(first.notebook[0].evidence, [traces[0].id, traces[1].id]);
  assert.equal(first.notebook[0].confidence, .8); assert.equal(first.confirmed, 0);
  assert.equal(first.adjusted.length, 1); assert.match(first.adjusted[0], /按证据记为观察/);
  assert.equal(first.nextExperiment[0].frames, 20);
  noHidden(calls[0].messages[1].content); noHidden(calls[0].messages[0].content);
  assert.equal(calls[0].messages[1].content.includes('"origin":"engine"'), true);

  const three = await induceJumpMechanics(fake(async () => ({ ops: [{ id: 'n1', claim: '通道 a 独自按住时 x 增加', state: '观察', evidence: traces.slice(0, 3).map(t => t.id) }] })),
    { world: { name: '世界 1', level: world.level }, traces });
  assert.equal(three.notebook[0].state, '确认'); assert.equal(three.confirmed, 1); assert.equal(three.learned, 1);

  const kept = await induceJumpMechanics(fake(async () => ({ ops: [{ id: 'n1', claim: '通道 a 独自按住时 x 增加', state: '观察', evidence: [traces[0].id] }] })),
    { world: { name: '世界 1', level: world.level }, traces, notebook: three.notebook });
  assert.equal(kept.notebook[0].evidence.length, 3); assert.equal(kept.notebook[0].state, '确认'); assert.equal(kept.learned, 0);

  const bad = await induceJumpMechanics(fake(async () => ({ ops: [{ claim: '没有证据的结论', state: '确认' }], nextExperiment: [{ a: true, frames: 900 }] })),
    { world: { name: '世界 1', level: world.level }, traces });
  assert.equal(bad.notebook[0].state, '猜想'); assert.equal(bad.nextExperiment, null);
  assert.equal(reduceNotebook([], [{ claim: 'x', state: '确认', evidence: [] }], []).confirmed, 0);
  await assert.rejects(induceJumpMechanics(fake(async () => ({})), { world: { name: '世界 1', level: world.level }, traces: [] }), /没有可归纳的实验记录/);
  await assert.rejects(induceJumpMechanics(fake(async () => ({})), { world: { name: '世界 1', level: world.level }, traces: [{ id: 'x', segments: [{ a: true }] }] }), /按键无效/);
  await assert.rejects(induceJumpMechanics(fake(async () => ({})), { world: { name: '世界 1', level: { version: 2 } }, traces }), /关卡格式/);
});

test('blank planning sees only geometry, state and its own notebook', async () => {
  const notebook = reduceNotebook([], [{ id: 'n1', claim: '按住 a 让 x 变大', state: '观察', evidence: ['eng-a-hold', 'eng-ab-hold'] }], ['eng-a-hold', 'eng-ab-hold']).notebook;
  const reply = { actions: [{ a: true, b: false, c: false, frames: 30 }], prediction: { dy: 'level', grounded: true, dead: false }, goal: '试探 a', usedNotes: ['n1', 'invented'] };
  const { brain, calls } = seen(() => reply);
  const pet = { x: 64, y: 400, vy: 0, grounded: true, held: false };
  const result = await planJumpLab(brain, { world: { name: '世界 1', level: labLevel() }, actor: pet, progress: { coins: [], key: false, switchOn: false }, notebook });
  assert.deepEqual(result.actions, [{ a: true, b: false, c: false, frames: 30 }]);
  assert.deepEqual(result.prediction, { dy: 'level', grounded: true, dead: false });
  assert.deepEqual(result.usedNotes, ['n1']); assert.equal(result.unconfirmed, 1);
  const prompt = calls[0].messages[0].content + calls[0].messages[1].content;
  noHidden(prompt);
  assert.equal(prompt.includes('先取钥匙'), false); assert.equal(prompt.includes('金币'), false);
  assert.equal(calls[0].messages[1].content.includes('"notebook":[{"id":"n1"'), true);
  assert.equal(calls[0].messages[1].content.includes('"samples"'), false, 'raw trace samples stay out of the acting prompt');
  assert.equal(calls[0].messages[1].content.includes('"experiments"'), false);

  const noPrediction = await planJumpLab(fake(async () => ({ actions: reply.actions })), { world: { name: '世界 1', level: labLevel() }, actor: pet, progress: {}, notebook });
  assert.equal(noPrediction.prediction, null);
  await assert.rejects(planJumpLab(fake(async () => ({ actions: [{ move: 1, jump: false, frames: 10 }] })), { world: { name: '世界 1', level: labLevel() }, actor: pet, progress: {}, notebook }), /无效动作/);
  await assert.rejects(planJumpLab(fake(async () => ({})), { world: { name: '世界 1', level: labLevel() }, actor: { x: 1e6, y: 0, vy: 0 }, progress: {} }), /角色状态无效/);
  await assert.rejects(planJumpLab({ ...brain, mode: 'algorithm' }, { world: { name: '世界 1', level: labLevel() }, actor: pet }), /未连接真实大模型/);
  assert.equal(truth.mapping.a, world.mapping.a);
});
