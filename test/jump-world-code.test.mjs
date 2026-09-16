import test from 'node:test';
import assert from 'node:assert/strict';
import { labWorld, experimentBattery, labLevel, runExperiment, hiddenTruth } from '../public/jump-lab.mjs';
import { scoreWorldModel, planWithWorldModel, MODEL_LIMIT } from '../server/jump-world-code.mjs';

const world = labWorld(4477);
const truth = hiddenTruth(world);
const channels = role => Object.keys(truth.mapping).find(c => truth.mapping[c] === role);
const oracle = `
function step(s, a, level) {
  const move = (a.${channels('right')} ? 1 : 0) - (a.${channels('left')} ? 1 : 0);
  const jumping = !!a.${channels('jump')};
  const next = { x: s.x, y: s.y, vy: s.vy, grounded: s.grounded, held: s.held };
  if (jumping && !s.held && s.grounded) { next.vy = ${truth.physics.jump}; next.grounded = false; }
  next.held = jumping;
  if (!jumping && next.vy < ${truth.physics.cut}) next.vy = ${truth.physics.cut};
  next.x = Math.max(12, Math.min(level.width - 12, s.x + move * ${truth.physics.speed}));
  if (next.grounded && !level.platforms.some(q => Math.abs(q.y - next.y) < .1 && next.x >= q.x && next.x <= q.x + q.w)) next.grounded = false;
  if (!next.grounded) { next.vy += ${truth.physics.gravity}; next.y += next.vy; }
  if (next.vy >= 0) {
    const surfaces = level.platforms.filter(q => next.x >= q.x && next.x <= q.x + q.w && s.y <= q.y + .01 && next.y >= q.y).sort((m, n) => m.y - n.y);
    if (surfaces.length) { next.y = surfaces[0].y; next.vy = 0; next.grounded = true; }
  }
  return next;
}`;

test('a model that actually matches the world replays every recorded frame', () => {
  const traces = experimentBattery(world);
  const result = scoreWorldModel(oracle, traces, world.level);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.frames > 100, `expected many compared frames, got ${result.frames}`);
  assert.equal(result.error, 0, JSON.stringify(result.mismatches));
  assert.equal(result.mismatches.length, 0);
  assert.equal(result.traces.length, traces.length);
});

test('a wrong model is caught at the first frame that diverges, with numbers', () => {
  const traces = experimentBattery(world);
  const wrong = oracle.replace(`${truth.physics.gravity}`, `${Math.round(truth.physics.gravity * 1.6 * 100) / 100}`);
  const result = scoreWorldModel(wrong, traces, world.level);
  assert.equal(result.ok, true);
  assert.ok(result.error > 0, 'a wrong gravity must not verify');
  assert.ok(result.mismatches.length > 0);
  const [first] = result.mismatches;
  assert.ok(traces.some(t => t.id === first.trace));
  assert.equal(typeof first.t, 'number');
  for (const key of ['x', 'y', 'vy']) assert.equal(typeof first.predicted[key], 'number');
  assert.notEqual(first.predicted.y, first.actual.y);
  assert.ok(result.worst > 1);
  const noStep = scoreWorldModel('const x = 1;', traces, world.level);
  assert.equal(noStep.ok, false); assert.match(noStep.problem, /没有定义 step/);
  const broken = scoreWorldModel('function step() { throw new Error("boom"); }', traces, world.level);
  assert.equal(broken.ok, false); assert.match(broken.problem, /boom/);
  const garbage = scoreWorldModel('function step() { return null; }', traces, world.level);
  assert.equal(garbage.ok, true); assert.ok(garbage.error > 0);
});

test('the sandbox cannot hang the server or reach the host', () => {
  const traces = experimentBattery(world).slice(0, 1);
  const started = Date.now();
  const loop = scoreWorldModel('function step() { while (true) {} }', traces, world.level, { timeoutMs: 300 });
  assert.equal(loop.ok, false); assert.match(loop.problem, /超时/);
  assert.ok(Date.now() - started < 5000);
  for (const escape of ['function step() { return process.env; }', 'function step() { return require("node:fs"); }',
    'const p = this.constructor.constructor("return process")(); function step() { return p.pid; }',
    'function step() { return globalThis.process.pid; }']) {
    const result = scoreWorldModel(escape, traces, world.level, { timeoutMs: 300 });
    assert.equal(result.ok, false, `${escape} must fail, not leak`);
    assert.equal(JSON.stringify(result).includes('PID'), false);
  }
  assert.ok(MODEL_LIMIT >= 4000);
});

test('a verified model plans a crossing in its head, and the real engine agrees', () => {
  const level = labLevel();
  const start = { x: level.spawn.x, y: level.spawn.y, vy: 0, grounded: true };
  const plan = planWithWorldModel(oracle, level, { start, target: { x: 520, y: 400 } });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.found, true);
  assert.ok(plan.plan.length > 0 && plan.plan.length <= 12);
  assert.equal(plan.plan.every(a => [a.a, a.b, a.c].every(v => typeof v === 'boolean') && a.frames >= 1 && a.frames <= 90), true);
  assert.ok(plan.predicted.x >= 520);
  const real = runExperiment(world, { id: 'model-plan', segments: plan.plan });
  assert.equal(real.dead, false, 'the model said it survives; the engine must agree');
  assert.ok(real.samples.at(-1).x >= 500, `engine ended at x=${real.samples.at(-1).x}`);
  assert.ok(Math.abs(real.samples.at(-1).x - plan.predicted.x) < 60, 'model and engine land close together');
});
