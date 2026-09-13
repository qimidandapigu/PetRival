import test from 'node:test';
import assert from 'node:assert/strict';
import { PetBrain } from '../server/provider.mjs';
import { stepObservation, reachablePushes } from '../server/step-observation.mjs';
import { parse, replay, solve, RULES } from '../shared/game.mjs';

const rows = ['########', '#      #', '# .  . #', '# $  $ #', '# @    #', '#      #', '#      #', '########'];
const brainFor = options => new PetBrain({ run() { throw new Error('Contestant called a solver'); } },
  { AI_MODE: 'model', MODEL_API_KEY: 'fixture-only', MODEL_PLAY_EFFORT: 'low' }, { stepMs: 0, ...options });

test('single-step play observes actual outcomes, recovers invalid output and undo, and continues beyond three rounds', async t => {
  const inputs = [], progress = []; let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body), input = JSON.parse(body.messages[1].content); inputs.push(input); calls++;
    assert.equal(body.thinking.type, 'disabled'); assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.messages.length, 2);
    assert.equal(Object.hasOwn(input, 'proof'), false); assert.equal(Object.hasOwn(input, 'solution'), false);
    let action = calls === 2 ? 'U' : calls === 3 ? 'Z' : solve(input.rows).actions[0];
    const content = calls === 1 ? { actions: 'bad schema' } : { action };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
  });
  const brain = brainFor();
  try {
    const result = await brain.play(rows, { style: 'step', onProgress: p => progress.push(p) });
    assert.ok(calls > 3); assert.ok(replay(rows, result.actions).won);
    assert.equal(result.playStyle, 'step'); assert.equal(result.effort, 'none');
    assert.match(inputs[1].feedback.error, /Invalid format/);
    assert.equal(inputs[2].canUndo, true);
    assert.equal(inputs[3].feedback.action, 'Z'); assert.deepEqual(inputs[3].rows, rows);
    assert.ok(inputs[3].visitsToThisPosition > 1);
    assert.ok(progress.some(p => p.phase === 'deciding' && p.actions.length > 0), 'already moved while choosing a later action');
    assert.equal(brain.playEffort, 'low', 'short practice must not mutate ranked/default effort');
    for (const p of progress) assert.equal(replay(rows, p.actions).steps, p.steps);
  } finally { brain.close(); }
});

test('step observation exposes local legal moves and corner feedback without a path or suggested solution', () => {
  const observation = stepObservation(parse(rows), { turn: 1, remainingMs: 180000 });
  assert.deepEqual(observation.player, { x: 2, y: 4 });
  assert.deepEqual(observation.legalMoves.find(m => m.action === 'U'), { action: 'U', playerTo: { x: 2, y: 3 }, boxTo: { x: 2, y: 2 }, boxOnGoal: true });
  assert.equal(observation.canUndo, false);
  assert.equal(Object.hasOwn(observation, 'bestAction'), false);
});

test('walking assistance executes only the selected push and never moves another box en route', async t => {
  let calls = 0;
  for (const choice of reachablePushes(parse(rows))) {
    const walking = replay(rows, choice.actions.slice(0, -1));
    assert.deepEqual(walking.state.boxes, parse(rows).boxes);
    assert.equal(replay(rows, choice.actions).pushes, 1);
  }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.thinking.type, 'disabled'); assert.equal(body.reasoning_effort, 'none');
    const input = JSON.parse(body.messages[1].content); calls++;
    assert.ok(input.availablePushes.every(p => !Object.hasOwn(p, 'actions')), 'model sees available operations, no supplied solution');
    const selected = input.availablePushes.find(p => p.onGoal && !p.wasOnGoal);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ choice: selected.id }) } }] }) };
  });
  const brain = new PetBrain({ run() { throw new Error('Contestant called solver'); } }, { AI_MODE: 'model', MODEL_API_KEY: 'fixture-only' }, { stepMs: 0 }), progress = [];
  try {
    const result = await brain.play(rows, { onProgress: p => progress.push(p) });
    assert.ok(replay(rows, result.actions).won); assert.equal(calls, 2); assert.equal(result.playStyle, 'push');
    assert.equal(progress.filter(p => p.phase === 'acting').length, result.actions.length, 'each walking tile remains visible');
  } finally { brain.close(); }
});

test('a blocked step is fed back to the model and does not automatically fail the run', async t => {
  let calls = 0, feedback;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content); calls++;
    if (calls === 2) feedback = input.feedback;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ action: calls === 1 ? 'D' : solve(input.rows).actions[0] }) } }] }) };
  });
  const blockedRows = [...rows]; blockedRows[5] = '# #    #';
  const brain = brainFor();
  try {
    const result = await brain.play(blockedRows, { style: 'step' });
    assert.equal(feedback.changed, false); assert.match(feedback.error, /No change/);
    assert.ok(replay(blockedRows, result.actions).won);
  } finally { brain.close(); }
});

test('step planning has the same total deadline and retains its actually executed prefix', async t => {
  let now = 0;
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"U"}' } }] }) }));
  const brain = brainFor({ now: () => now });
  try {
    const result = await brain.play(rows, { style: 'step', onProgress: p => { if (p.actions) now = RULES.limitMs + 1; } });
    assert.equal(result.actions, 'U'); assert.equal(result.timedOut, true); assert.equal(result.elapsedMs, RULES.limitMs);
  } finally { brain.close(); }
});

test('repeated malformed step actions stop as a contestant failure and do not execute fabricated moves', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"WIN"}' } }] }) }; });
  const brain = brainFor();
  try {
    const result = await brain.play(rows, { style: 'step' });
    assert.equal(calls, 3); assert.equal(result.actions, ''); assert.match(result.note, /连续三次/);
  } finally { brain.close(); }
});
