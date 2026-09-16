import test from 'node:test';
import assert from 'node:assert/strict';
import { labWorld, experimentBattery, hiddenTruth } from '../public/jump-lab.mjs';
import { writeJumpWorldModel } from '../server/jump-world-api.mjs';

const world = labWorld(4477);
const truth = hiddenTruth(world);
const channels = role => Object.keys(truth.mapping).find(c => truth.mapping[c] === role);
const model = gravity => `function step(s, a, level) {
  const move = (a.${channels('right')} ? 1 : 0) - (a.${channels('left')} ? 1 : 0);
  const jumping = !!a.${channels('jump')};
  const next = { x: s.x, y: s.y, vy: s.vy, grounded: s.grounded, held: s.held };
  if (jumping && !s.held && s.grounded) { next.vy = ${truth.physics.jump}; next.grounded = false; }
  next.held = jumping;
  if (!jumping && next.vy < ${truth.physics.cut}) next.vy = ${truth.physics.cut};
  next.x = Math.max(12, Math.min(level.width - 12, s.x + move * ${truth.physics.speed}));
  if (next.grounded && !level.platforms.some(q => Math.abs(q.y - next.y) < .1 && next.x >= q.x && next.x <= q.x + q.w)) next.grounded = false;
  if (!next.grounded) { next.vy += ${gravity}; next.y += next.vy; }
  if (next.vy >= 0) {
    const surfaces = level.platforms.filter(q => next.x >= q.x && next.x <= q.x + q.w && s.y <= q.y + .01 && next.y >= q.y).sort((m, n) => m.y - n.y);
    if (surfaces.length) { next.y = surfaces[0].y; next.vy = 0; next.grounded = true; }
  }
  return next;
}`;
const actor = { x: 64, y: 400, vy: 0, grounded: true };
const fixture = replies => { const calls = []; let i = 0;
  return { calls, brain: { mode: 'model', info: () => ({ model: 'fixture-model' }), json: async messages => { calls.push([...messages]); return replies[Math.min(i++, replies.length - 1)]; } } }; };

test('a wrong code model is repaired by the engine diff until it replays everything', async () => {
  const traces = experimentBattery(world);
  const { brain, calls } = fixture([{ code: model(Math.round(truth.physics.gravity * 1.6 * 100) / 100), notes: ['重力先按常识猜'], confidence: .3 },
    { code: model(truth.physics.gravity), notes: ['重力 0.56'], confidence: .9 }]);
  const result = await writeJumpWorldModel(brain, { world: { name: '世界 1', level: world.level }, traces, actor });
  assert.equal(result.verified, true);
  assert.equal(result.error, 0);
  assert.equal(result.attempts, 2);
  assert.ok(result.frames > 100);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].length, 4, 'repair turn must carry the previous code and the diff');
  assert.match(calls[1][3].content, /第 \d+ 帧/);
  assert.match(calls[1][3].content, /真实 x=/);
  assert.equal(calls[0].length, 2);
  for (const leak of ['gravity', 'mapping', 'speed', '"cut"', 'physics'])
    assert.equal(JSON.stringify(calls[0]).includes(leak), false, `prompt leaked ${leak}`);
  assert.equal(calls[0][1].content.includes('"segments"'), true, 'the traces carry the experiment inputs');
  assert.equal(calls[0][1].content.includes('"samples"'), true);
  assert.equal(result.plan.length > 0, true, 'a verified model must be able to plan');
  assert.ok(result.predicted.x >= result.planTo);
  assert.equal(result.mismatches.length, 0);
  assert.equal(result.rounds.length, 2, 'every repair round is reported, not just the last');
  assert.deepEqual(result.rounds.map(r => r.round), [1, 2]);
  assert.ok(result.rounds[0].matched < result.rounds[1].matched, 'the rounds must show the improvement');
  assert.equal(result.rounds[1].error, 0);
  assert.equal(result.rounds[0].frames, result.rounds[1].frames);
});

test('a model that never matches is reported honestly and never plans', async () => {
  const second = labWorld(90210), traces = experimentBattery(second);
  const { brain, calls } = fixture([{ code: 'function step() { return null; }', notes: [] }]);
  const result = await writeJumpWorldModel(brain, { world: { name: '世界 2', level: second.level }, traces, actor });
  assert.equal(result.verified, false);
  assert.equal(result.attempts, 4);
  assert.equal(result.plan.length, 0);
  assert.equal(result.predicted, null);
  assert.equal(result.frames, 0, 'a model that never returns a state compares zero frames');
  assert.match(result.failure, /没能返回合法状态|没有返回合法状态/);
  assert.equal(calls.length, 4);
  assert.match(calls[3][3].content, /一帧都没跑通/);
  const crashed = fixture([{ code: 'function step( { return 1; }' }]);
  const looped = await writeJumpWorldModel(crashed.brain, { world: { name: '世界 2', level: second.level }, traces, actor });
  assert.equal(looped.verified, false);
  assert.ok(looped.failure.length > 0, 'a code that cannot even load must be reported');
  assert.match(looped.code, /function step\(/);
  assert.match(crashed.calls[1][3].content, /没法运行/);
  const empty = fixture([{ notes: ['没有代码'] }]);
  const none = await writeJumpWorldModel(empty.brain, { world: { name: '世界 2', level: second.level }, traces, actor });
  assert.equal(none.verified, false);
  assert.equal(none.code, '');
  assert.match(none.failure, /没有给出 code/);
  assert.equal(empty.calls.length, 1);
  await assert.rejects(writeJumpWorldModel(empty.brain, { world: { name: '世界 2', level: second.level }, traces: [] }), /没有可用来校准世界模型/);
  await assert.rejects(writeJumpWorldModel({ ...empty.brain, mode: 'algorithm' }, { world: { name: '世界 2', level: second.level }, traces }), /未连接真实大模型/);
});
