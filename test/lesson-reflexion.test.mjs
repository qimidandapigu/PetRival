import test from 'node:test';
import assert from 'node:assert/strict';
import { starterLevel, actor, progress } from '../public/jump-world.mjs';
import { lessonPrediction, scoreLessonPrediction, sameSpotStreak } from '../public/jump-lab.mjs';
import { planJump, learnJumpLesson } from '../server/jump-model.mjs';

const fake = fn => ({ mode: 'model', info: () => ({ model: 'fixture-model' }), json: fn });

test('lesson prediction is validated against the level, never trusted raw', () => {
  const level = starterLevel();
  assert.deepEqual(lessonPrediction({ xMin: 100, xMax: 220, dead: false }, level), { xMin: 100, xMax: 220, dead: false });
  assert.equal(lessonPrediction({ xMin: 300, xMax: 100, dead: false }, level), null, 'inverted range rejected');
  assert.equal(lessonPrediction({ xMin: 0, xMax: 9999, dead: false }, level), null, 'range beyond the level rejected');
  assert.equal(lessonPrediction({ xMin: 0, xMax: 500, dead: false }, level), null, 'over-wide range rejected');
  assert.equal(lessonPrediction({ xMin: 'far', xMax: 100 }, level), null);
  assert.equal(lessonPrediction(null, level), null);
  assert.equal(lessonPrediction({ xMin: -40, xMax: 60, dead: 1 }, level).xMin, 0, 'clamped to the map edge');
});

test('the engine grades the prediction: landing range and dead flag', () => {
  const p = { xMin: 100, xMax: 200, dead: false };
  assert.equal(scoreLessonPrediction(p, { x: 150 }, false).hit, true);
  const missed = scoreLessonPrediction(p, { x: 260 }, false);
  assert.equal(missed.hit, false);
  assert.deepEqual(missed.missed, ['落点']);
  const died = scoreLessonPrediction(p, { x: 150 }, true);
  assert.equal(died.hit, false);
  assert.deepEqual(died.missed, ['生死'], 'death voids the landing range instead of double-counting it');
  assert.equal(scoreLessonPrediction({ xMin: 0, xMax: 50, dead: true }, { x: 30 }, true).hit, true);
  assert.equal(scoreLessonPrediction(null, { x: 1 }, false), null);
});

test('same-spot streak counts consecutive falls near one x and resets on any other outcome', () => {
  const fall = x => ({ outcome: 'fell', to: { x } });
  assert.deepEqual(sameSpotStreak([]), { streak: 0, x: null });
  assert.equal(sameSpotStreak([fall(480), fall(500), fall(470)]).streak, 3, 'three falls in one area');
  assert.equal(sameSpotStreak([fall(100), fall(700)]).streak, 1, 'different spots do not add up');
  assert.equal(sameSpotStreak([fall(480), { outcome: 'alive', to: { x: 485 } }, fall(482)]).streak, 1, 'a surviving attempt resets');
  assert.equal(sameSpotStreak([{ outcome: 'won', to: { x: 900 } }, fall(480), fall(481)]).streak, 2);
  assert.equal(sameSpotStreak([fall(480), fall(1000)], 48).x, 1000, 'reports the latest spot');
});

test('the lesson model must predict the landing, and a bad prediction never breaks a plan', async () => {
  const level = starterLevel(), a = actor(level.spawn);
  let system = '';
  const brain = fake(async messages => {
    system = messages[0].content;
    return { actions: [{ move: 1, jump: false, frames: 20 }], prediction: { xMin: 60, xMax: 140, dead: false }, goal: '往右走' };
  });
  const result = await planJump(brain, { level, actor: a, progress: progress() });
  assert.deepEqual(result.prediction, { xMin: 60, xMax: 140, dead: false });
  assert.ok(system.includes('prediction'), 'the output schema asks for a prediction');
  assert.ok(system.includes('引擎会按真实结果给预测打分'), 'it knows the engine grades it');
  assert.equal(/speed|gravity|"jump":/.test(system), false, 'still no physics constants handed over');
  const noPrediction = await planJump(fake(async () => ({ actions: [{ move: 1, jump: false, frames: 20 }], prediction: { xMin: 500, xMax: 100 } })), { level, actor: a, progress: progress() });
  assert.equal(noPrediction.prediction, null, 'an invalid prediction is dropped, the actions still stand');
});

test('automatic reflection tells the model why it is summarising', async () => {
  const level = starterLevel(), a = actor(level.spawn);
  let system = '';
  const brain = fake(async messages => { system = messages[0].content; return { ops: [], note: '好' }; });
  await learnJumpLesson(brain, { level, trigger: '在 x≈480 附近连续摔了 2 次，同一做法反复失败',
    attempts: [{ from: a, to: { ...a, x: 480 }, outcome: 'fell', actions: [{ move: 1, jump: false, frames: 20 }] }] });
  assert.ok(system.includes('自动触发'), 'the trigger reaches the reflection prompt');
  assert.ok(system.includes('x≈480'), 'the trigger carries the failing spot');
  const manual = await learnJumpLesson(fake(async m => { system = m[0].content; return { ops: [] }; }),
    { level, attempts: [{ from: a, to: { ...a, x: 60 }, outcome: 'alive', actions: [{ move: 1, jump: false, frames: 20 }] }] });
  assert.equal(manual.method, 'model');
  assert.equal(system.includes('自动触发'), false, 'manual summarising stays unchanged');
});
