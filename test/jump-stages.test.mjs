import test from 'node:test';
import assert from 'node:assert/strict';
import { PHYSICS, actor, progress, worldProgress, latchPlates, replayActions, step, verifyLevel } from '../public/jump-world.mjs';
import { STAGES, stageInfo, stageLevel, nextStage, unlockAfter, stagePickerState, validateStageId } from '../public/jump-stages.mjs';

test('every stage is a valid level the bounded solver can actually finish', () => {
  for (const stage of STAGES.filter(s => s.id !== 7)) {
    const level = stageLevel(stage.id);
    assert.equal(level.title, `第 ${stage.id} 关 · ${stage.name}`);
    const proof = verifyLevel(level);
    assert.equal(proof.verified, true, `stage ${stage.id} is not solvable: ${proof.reason}`);
    assert.equal(replayActions(level, actor(level.spawn), progress(), proof.actions).progress.won, true);
  }
  assert.equal(verifyLevel(stageLevel(6)).verified, true);
});

test('stage 7 is a co-op level: one actor alone cannot open the door, two coordinated actors win', () => {
  const level = stageLevel(7);
  assert.equal(level.title, '第 7 关 · 并肩作战');
  assert.ok(level.coop.plates[1].x - level.coop.plates[0].x >= 96, 'the plates are too far apart for one actor');
  assert.ok(level.coop.plates.every(p => p.x < level.door.x), 'both plates are reachable before the door');
  // Solo: walking the whole map never latches the plates, and the closed door stops the run.
  const soloW = worldProgress(), soloA = actor(level.spawn), soloP = progress();
  for (let i = 0; i < 600 && !soloP.won && !soloA.dead; i++) { step(soloA, { move: 1, jump: false }, level, soloP, 'pet', PHYSICS, soloW); latchPlates(level, soloW, soloA); }
  assert.equal(soloW.switchOn, false, 'one actor cannot occupy both plates at once');
  assert.equal(soloP.won, false, 'stage 7 is not solvable alone');
  assert.ok(soloA.x <= level.door.x, 'the closed door blocks the solo actor');
  // Co-op: the human holds the left plate, the pet crosses the map to the right plate; the door
  // latches and BOTH walk to the goal.
  const world = worldProgress(), human = actor(level.spawn), hp = progress(), pet = actor(level.spawn), pp = progress();
  const humanInput = () => !world.switchOn ? { move: human.x < 300 ? 1 : 0, jump: false } : { move: 1, jump: false };
  const petInput = () => !world.switchOn ? { move: pet.x < 700 ? 1 : 0, jump: false } : { move: 1, jump: false };
  let latched = false;
  for (let t = 0; t < 900 && !(hp.won && pp.won); t++) {
    step(human, humanInput(), level, hp, 'human', PHYSICS, world);
    step(pet, petInput(), level, pp, 'pet', PHYSICS, world);
    if (latchPlates(level, world, human, pet)) latched = true;
  }
  assert.equal(latched, true, 'the plates latched while both were occupied');
  assert.deepEqual(world.coins.sort(), [0, 1], 'coins are shared between the two sides');
  assert.equal(world.key, true, 'the key is shared');
  assert.equal(hp.won && pp.won, true, `both sides must reach the goal (human x=${Math.round(human.x)}, pet x=${Math.round(pet.x)})`);
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
  assert.equal(nextStage(1), 2); assert.equal(nextStage(6), 7); assert.equal(nextStage(7), null);
  const picker = stagePickerState([1, 2], 3);
  assert.deepEqual(picker.map(s => [s.id, s.locked, s.cleared, s.current]), [[1, false, true, false], [2, false, true, false], [3, false, false, true], [4, true, false, false], [5, true, false, false], [6, true, false, false], [7, true, false, false]]);
  const fresh = stagePickerState([], 1);
  assert.deepEqual(fresh.map(s => s.locked), [false, true, true, true, true, true, true], 'a fresh save can only play stage 1');
  assert.equal(stageInfo(3).name, '学会拿金币');
  assert.throws(() => validateStageId(0)); assert.throws(() => validateStageId(8)); assert.throws(() => validateStageId('x'));
  assert.equal(PHYSICS.speed > 0, true);
});
