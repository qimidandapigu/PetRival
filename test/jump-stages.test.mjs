import test from 'node:test';
import assert from 'node:assert/strict';
import { PHYSICS, actor, progress, replayActions, step, verifyLevel } from '../public/jump-world.mjs';
import { STAGES, stageInfo, stageLevel, nextStage, unlockAfter, stagePickerState, validateStageId } from '../public/jump-stages.mjs';

test('every stage is a valid level the bounded solver can actually finish', () => {
  for (const stage of STAGES) {
    const level = stageLevel(stage.id);
    assert.equal(level.title, `第 ${stage.id} 关 · ${stage.name}`);
    const proof = verifyLevel(level);
    assert.equal(proof.verified, true, `stage ${stage.id} is not solvable: ${proof.reason}`);
    assert.equal(replayActions(level, actor(level.spawn), progress(), proof.actions).progress.won, true);
  }
  assert.equal(verifyLevel(stageLevel(6)).verified, true);
});

test('the ladder introduces one skill at a time', () => {
  const first = stageLevel(1);
  assert.equal(first.platforms.every(p => p.y === 400), true, 'stage 1 is flat ground: walking is enough');
  assert.equal(first.coins.every(c => first.platforms.some(p => Math.abs(p.y - 400) < .1 && p.x <= c.x && c.x <= p.x + p.w)), true);
  const second = stageLevel(2);
  const gap = second.platforms.map(p => [p.x, p.x + p.w]).sort((a, b) => a[0] - b[0]);
  assert.ok(gap[1][0] - gap[0][1] >= 60, 'stage 2 has a real creek');
  const third = stageLevel(3);
  assert.ok(third.coins.some(c => c.y < 380), 'stage 3 needs a jump up to a coin');
  const fourth = stageLevel(4);
  assert.ok(fourth.key.y < 360, 'stage 4 puts the key up high');
  assert.ok(fourth.switch.x < fourth.key.x + 200, 'stage 4 keeps the switch close, no backtracking yet');
  const fifth = stageLevel(5);
  assert.ok(fifth.switch.x < fifth.key.x - 400, 'stage 5 forces you to walk back to the switch');
  assert.equal(stageLevel(6).width >= 1000, true);
});

test('the first stage can be cleared by walking right without ever jumping', () => {
  const level = stageLevel(1), a = actor(level.spawn), p = progress();
  for (let i = 0; i < 600 && !p.won; i++) step(a, { move: 1, jump: false }, level, p);
  assert.equal(p.won, true, 'a pet that only knows how to walk can finish stage 1');
  assert.ok(Math.abs(a.x - level.goal.x) < 24, `walking ends on the goal, ended at x=${a.x}`);
});

test('the second stage punishes walking into the creek and rewards one jump', () => {
  const level = stageLevel(2), walking = actor(level.spawn), wp = progress();
  for (let i = 0; i < 300; i++) step(walking, { move: 1, jump: false }, level, wp);
  assert.equal(walking.dead, true, 'walking off the edge drops you');
  const jumper = actor({ x: 400, y: 400 }), jp = progress();
  for (let i = 0; i < 60 && !jp.won; i++) step(jumper, { move: 1, jump: i < 40 }, level, jp);
  assert.equal(jumper.dead, false);
  assert.ok(jumper.x > 500, `the jump carries you across, ended at x=${jumper.x}`);
});

test('clearing a stage unlocks the next one and never leaves a locked gap', () => {
  assert.deepEqual(unlockAfter([], 1), [1]);
  assert.deepEqual(unlockAfter([1], 2), [1, 2]);
  assert.deepEqual(unlockAfter([1, 2, 2], 1), [1, 2]);
  assert.deepEqual(unlockAfter(['3', 0, 99, 2], 2), [2, 3]);
  assert.equal(nextStage(1), 2); assert.equal(nextStage(6), null);
  const picker = stagePickerState([1, 2], 3);
  assert.deepEqual(picker.map(s => [s.id, s.locked, s.cleared, s.current]), [[1, false, true, false], [2, false, true, false], [3, false, false, true], [4, true, false, false], [5, true, false, false], [6, true, false, false]]);
  const fresh = stagePickerState([], 1);
  assert.deepEqual(fresh.map(s => s.locked), [false, true, true, true, true, true], 'a fresh save can only play stage 1');
  assert.equal(stageInfo(3).name, '学会拿金币');
  assert.throws(() => validateStageId(0)); assert.throws(() => validateStageId(7)); assert.throws(() => validateStageId('x'));
  assert.equal(PHYSICS.speed > 0, true);
});
