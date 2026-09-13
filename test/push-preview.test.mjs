import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, replay, RULES } from '../shared/game.mjs';
import { previewCandidates, validateStage, advanceStage } from '../server/push-preview.mjs';
import { reachablePushes } from '../server/step-observation.mjs';
import { PetBrain } from '../server/provider.mjs';
const rows = ['########', '#      #', '# .  . #', '# $  $ #', '# @    #', '#      #', '#      #', '########'];
const makeBrain = options => new PetBrain({ run() { throw new Error('A solver must never select a contestant push'); } },
  { AI_MODE: 'model', MODEL_API_KEY: 'fixture-only', MODEL_PLAY_EFFORT: 'none', MODEL_PUSH_POLICY: 'preview' }, { stepMs: 0, ...options });

test('bounded previews use changing box coordinates and leave the real board untouched', () => {
  const state = parse(rows), before = structuredClone(state);
  const results = previewCandidates(state, [
    { pushes: ['push-26-U', 'push-29-U'] },
    { pushes: ['push-26-R', 'push-26-U'] },
    { pushes: ['push-26-R', 'push-27-L', 'push-26-R', 'push-27-L', 'push-29-U'] },
    { pushes: ['push-29-U'] },
  ]);
  assert.deepEqual(state, before); assert.equal(results.length, 3);
  assert.equal(results[0].trajectory.at(-1).won, true);
  assert.equal(results[1].simulatedPushes, 1); assert.match(results[1].error, /not reachable/);
  assert.equal(results[2].simulatedPushes, 4); assert.equal(results[2].trajectory[1].repeatsInPreview, true);
  assert.ok(results[0].finalAvailablePushes.every(p => !Object.hasOwn(p, 'actions')));
});

test('stage tracks the same box, survives other pushes and clears on completion or undo', () => {
  const stage = { box: { x: 2, y: 3 }, target: { x: 2, y: 2 } };
  const state = parse(rows), left = reachablePushes(state).find(p => p.id === 'push-26-L');
  const moved = replay(rows, left.actions).state;
  assert.deepEqual(advanceStage(stage, left, moved), { box: { x: 1, y: 3 }, target: stage.target });
  const other = reachablePushes(state).find(p => p.id === 'push-29-U');
  assert.deepEqual(advanceStage(stage, other, replay(rows, other.actions).state), stage);
  const done = reachablePushes(state).find(p => p.id === 'push-26-U');
  assert.equal(advanceStage(stage, done, replay(rows, done.actions).state), null);
  assert.equal(advanceStage(stage, null, state, 'undo'), null);
  assert.equal(validateStage({ ...stage, target: { x: 4, y: 4 } }, state), null);
});

test('selected branch executes one push per observed turn and reuses only verified continuations', async t => {
  const progress = [], proposals = []; let comparison = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body), input = JSON.parse(body.messages[1].content);
    assert.equal(body.thinking.type, 'disabled'); assert.equal(body.reasoning_effort, 'none');
    let answer;
    if (input.previews) {
      comparison++;
      if (comparison === 1) {
        assert.equal(progress.at(-1).actions, '', 'both simulated pushes are still invisible');
        assert.equal(input.previews[1].trajectory.at(-1).won, true);
      }
      answer = { candidate: comparison === 1 ? 1 : 0 };
    } else {
      proposals.push(input);
      if (proposals.length === 1) answer = { stage: { box: { x: 2, y: 3 }, target: { x: 2, y: 2 } }, candidates: [
        { pushes: ['push-26-L'] }, { pushes: ['push-29-U', 'push-26-U'] },
      ] };
      else {
        assert.deepEqual(input.activeStage, { box: { x: 2, y: 3 }, target: { x: 2, y: 2 } });
        assert.equal(input.boxes.filter(b => b.onGoal).length, 1);
        answer = { candidates: [{ pushes: ['push-26-U'] }] };
      }
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) };
  });
  const brain = makeBrain();
  try {
    const result = await brain.play(rows, { onProgress: p => progress.push(p) });
    assert.equal(replay(rows, result.actions).won, true); assert.equal(result.turn, 2);
    assert.equal(proposals.length, 1); assert.equal(comparison, 1);
    assert.ok(progress.some(p => p.turn === 2 && p.phase === 'deciding' && p.stageGoal?.box.x === 2));
    for (const p of progress) assert.equal(replay(rows, p.actions).steps, p.steps);
    assert.equal(result.stageGoal, null);
  } finally { brain.close(); }
});

test('comparison cannot execute a fabricated index and uses the same total deadline', async t => {
  let now = 0, compares = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    if (input.previews) { compares++; now = RULES.limitMs + 1; }
    const answer = input.previews ? { candidate: 99 } : { candidates: [{ pushes: ['push-26-U'] }, { pushes: ['push-29-U'] }] };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) };
  });
  const brain = makeBrain({ now: () => now });
  try {
    const result = await brain.play(rows);
    assert.equal(compares, 1); assert.equal(result.actions, ''); assert.equal(result.timedOut, true);
  } finally { brain.close(); }
});

test('invalid selections fail without executing a simulated win or a geometric deadlock', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    const answer = input.previews ? { candidate: 99 } : { candidates: [{ pushes: ['push-26-U', 'push-29-U'] }, { pushes: ['push-29-U'] }] };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) };
  });
  const brain = makeBrain();
  try {
    const result = await brain.play(rows);
    assert.equal(calls, 6); assert.equal(result.actions, ''); assert.match(result.note, /连续三次/);
    const dead = previewCandidates(parse(rows), [{ pushes: ['push-26-L'] }])[0];
    assert.equal(dead.trajectory[0].push.deadlock, true); assert.match(dead.error, /deadlock/);
  } finally { brain.close(); }
});

test('stable A/B references survive board sorting and a sole verified branch needs one model call', async t => {
  const state = parse(rows);
  const result = previewCandidates(state, [{ pushes: [
    { box: 'B', direction: 'U' }, { box: 'A', direction: 'R' }, { box: 'A', direction: 'U' },
  ] }])[0];
  assert.equal(result.error, null);
  assert.deepEqual(result.trajectory.map(p => p.push.id), ['push-29-U', 'push-26-R', 'push-27-U']);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    const body = JSON.parse(options.body), input = JSON.parse(body.messages[1].content);
    assert.equal(body.thinking.type, 'disabled'); assert.equal(body.reasoning_effort, 'none');
    assert.deepEqual(input.boxLabels, { A: { x: 2, y: 3 }, B: { x: 5, y: 3 } });
    const answer = { candidates: [{ pushes: [{ box: 'A', direction: 'U' }, { box: 'B', direction: 'U' }] }] };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) };
  });
  const brain = makeBrain();
  try { const run = await brain.play(rows); assert.equal(replay(rows, run.actions).won, true); assert.equal(calls, 1); assert.equal(run.turn, 2); }
  finally { brain.close(); }
});
