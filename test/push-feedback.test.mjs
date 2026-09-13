import test from 'node:test';
import assert from 'node:assert/strict';
import { PetBrain } from '../server/provider.mjs';
import { parse, replay } from '../shared/game.mjs';
import { reachablePushes, pushPositionKey } from '../server/step-observation.mjs';

const rows = ['########', '#      #', '# .  . #', '# $  $ #', '# @    #', '#      #', '#      #', '########'];
test('walking within the same region retains push-position identity', () => {
  const initial = parse(rows);
  assert.equal(pushPositionKey(initial), pushPositionKey(replay(rows, 'RR').state));
  assert.notEqual(pushPositionKey(initial), pushPositionKey(replay(rows, 'U').state));
});
test('geometry flags a dead wall square that is not a corner; a goal push remains possible', () => {
  const state = parse(['########', '#      #', '#  $ . #', '#  @   #', '# .    #', '# $    #', '#      #', '########']);
  const bad = reachablePushes(state).find(p => p.box.x === 3 && p.direction === 'U');
  assert.equal(bad.corner, false); assert.equal(bad.deadlock, true);
  assert.deepEqual(bad.reachableGoalsIgnoringOtherBox, []);
  assert.ok(reachablePushes(parse(rows)).filter(p => p.onGoal).every(p => !p.deadlock));
});
test('goal compatibility reserves a trapped completed goal for its box', () => {
  const state = parse(['########', '#*     #', '# ###  #', '#    $ #', '#      #', '#   @ .#', '#      #', '########']);
  const choice = reachablePushes(state).find(p => p.direction === 'D');
  assert.equal(choice.deadlock, false);
  assert.deepEqual(choice.compatibleGoalsForThisBox, [{ x: 6, y: 5 }]);
});
test('undo reverses an entire model-selected push and preserves branch memory without choosing a replacement', async t => {
  const inputs = []; let chosen;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body), input = JSON.parse(body.messages[1].content); inputs.push(input);
    assert.equal(body.thinking.type, 'disabled'); assert.equal(body.reasoning_effort, 'none');
    assert.ok(input.availablePushes.every(p => !Object.hasOwn(p, 'actions')));
    let choice;
    if (inputs.length === 1) { chosen = input.availablePushes.find(p => p.box.x === 5 && p.direction === 'U'); choice = chosen.id; assert.ok(chosen.walkSteps > 1); }
    else if (inputs.length === 2) choice = 'undo';
    else {
      if (inputs.length === 3) {
        assert.deepEqual(input.rows, rows); assert.equal(input.canUndo, false);
        assert.equal(input.availablePushes.find(p => p.id === chosen.id).triedFromThisPosition, 1);
        assert.equal(input.recentDecisions.at(-1).choice, 'undo');
        assert.equal(input.recentDecisions.at(-1).revisitedPosition, true);
      }
      choice = input.availablePushes.find(p => p.onGoal && !p.wasOnGoal).id;
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ choice }) } }] }) };
  });
  const brain = new PetBrain({ run() { throw new Error('No solver is allowed'); } }, { AI_MODE: 'model', MODEL_API_KEY: 'test-only', MODEL_PLAY_EFFORT: 'none' }, { stepMs: 0 });
  try {
    const result = await brain.play(rows, { onProgress() {} });
    assert.match(result.actions, /ZZZ/); assert.equal(replay(rows, result.actions).won, true);
    assert.equal(result.effort, 'none');
  } finally { brain.close(); }
});
