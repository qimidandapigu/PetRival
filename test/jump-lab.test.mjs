import test from 'node:test';
import assert from 'node:assert/strict';
import { PHYSICS, actor, progress, replayActions, step, validateActions, verifyLevel } from '../public/jump-world.mjs';
import { CHANNELS, ROLES, RANGES, labLevel, labWorld, hiddenTruth, channelInput, roleInputToChannels, validateChannelActions,
  validatePhysics, runExperiment, experimentBattery, verifyLabWorld, reduceNotebook, summarizeNotebook,
  scorePrediction, validatePrediction, scorePriorGuesses, labEvidence, labObservation } from '../public/jump-lab.mjs';

test('a world hides a permutation of roles and in-range physics', () => {
  const world = labWorld(54321), truth = hiddenTruth(world);
  assert.deepEqual(Object.keys(world.mapping).sort(), [...CHANNELS].sort());
  assert.deepEqual(CHANNELS.map(c => world.mapping[c]).sort(), [...ROLES].sort());
  for (const [key, [min, max]] of Object.entries(RANGES)) { assert.ok(world.physics[key] >= min && world.physics[key] <= max, key); }
  assert.deepEqual(labWorld(54321).mapping, world.mapping);
  const worlds = Array.from({ length: 12 }, (_, i) => labWorld(i + 1));
  const shapes = new Set(worlds.map(w => JSON.stringify(w.mapping)));
  assert.ok(shapes.size >= 3, `expected varied channel layouts, got ${shapes.size}`);
  assert.equal(new Set(worlds.map(w => JSON.stringify(w.physics))).size, 12);
  assert.throws(() => validatePhysics({ ...world.physics, gravity: 9 }));
  assert.throws(() => validatePhysics({ ...world.physics, gravity: undefined }));
  assert.equal(truth.physics.gravity, world.physics.gravity);
});

test('the drawn world is solvable for every parameter draw in the advertised range', () => {
  const world = labWorld(11), proof = verifyLabWorld(world, { samples: 5 });
  assert.equal(proof.verified, true, JSON.stringify(proof.results));
  const physics = validatePhysics(Object.fromEntries(Object.keys(RANGES).map(k => [k, RANGES[k][0]])));
  const weakest = verifyLevel(labLevel(), { physics });
  assert.equal(weakest.verified, true);
  assert.equal(replayActions(labLevel(), actor(labLevel().spawn), progress(), weakest.actions, 'pet', physics).progress.won, true);
});

test('channels are opaque: the same mask means different things in different worlds', () => {
  const first = labWorld(1), second = labWorld(2);
  const mask = { a: true, b: false, c: false, frames: 1 };
  const seen = new Set([first, second, labWorld(3), labWorld(4)].map(w => JSON.stringify(channelInput(w, mask))));
  assert.ok(seen.size > 1);
  assert.deepEqual(validateChannelActions([{ a: true, b: false, c: false, frames: 5 }]), [{ a: true, b: false, c: false, frames: 5 }]);
  assert.throws(() => validateChannelActions([{ a: true, b: false, frames: 5 }]));
  assert.throws(() => validateChannelActions([{ a: true, b: false, c: false, frames: 900 }]));
  assert.throws(() => validateActions([{ move: 1, jump: false, frames: 3 }], 0));
  const world = labWorld(9);
  assert.deepEqual(roleInputToChannels(world, { move: 1 }), Object.fromEntries(CHANNELS.map(c => [c, world.mapping[c] === 'right'])));
  assert.deepEqual(roleInputToChannels(world, { move: 0, jump: true }), Object.fromEntries(CHANNELS.map(c => [c, world.mapping[c] === 'jump'])));
});

test('the free battery measures every channel without a model call', () => {
  const world = labWorld(5), traces = experimentBattery(world);
  assert.equal(traces.length, 9);
  assert.ok(traces.every(t => t.origin === 'engine' && t.samples.length > 2 && t.frames > 40));
  const alone = traces.filter(t => /^eng-[abc]-(tap|hold)$/.test(t.id));
  assert.equal(alone.length, 6);
  const informative = alone.filter(t => t.samples.some(s => Math.abs(s.x - t.samples[0].x) > 2 || s.y < t.samples[0].y - 2));
  assert.equal(informative.length, 6, 'every channel must visibly do something on its own');
  const jump = CHANNELS.find(c => world.mapping[c] === 'jump');
  const tap = traces.find(t => t.id === `eng-${jump}-tap`), hold = traces.find(t => t.id === `eng-${jump}-hold`);
  assert.ok(tap.samples.some(s => s.y < 399), 'a tapped jump still leaves the ground');
  assert.ok(Math.min(...hold.samples.map(s => s.y)) < Math.min(...tap.samples.map(s => s.y)), 'holding must jump higher than tapping');
});

test('the engine never hands the model the hidden facts', () => {
  const world = labWorld(54321), traces = experimentBattery(world), a = actor(world.level.spawn), p = progress();
  const text = JSON.stringify([labEvidence({ world, label: '世界 1', traces }), labObservation({ world, label: '世界 1', actor: a, progress: p })]);
  for (const leak of ['speed', 'gravity', 'mapping', 'physics', '"cut"', String(world.seed), 'jump":', 'left', 'right']) assert.equal(text.includes(leak), false, leak);
  assert.equal(JSON.stringify(labObservation({ world, label: '世界 1', actor: a, progress: p }).world.level.mapping), undefined);
  const start = { ...a };
  const trace = runExperiment(world, { id: 'human-1', origin: 'human', start, segments: [{ a: true, b: false, c: false, frames: 20 }], note: '你的示范' });
  assert.equal(trace.origin, 'human');
  assert.equal(start.x, a.x);
  assert.equal(Math.abs(trace.delta.x) > 2 || trace.delta.y !== 0, true);
});
