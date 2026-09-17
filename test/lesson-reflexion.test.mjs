import test from 'node:test';
import assert from 'node:assert/strict';
import { starterLevel, actor, progress } from '../public/jump-world.mjs';
import { stageLevel } from '../public/jump-stages.mjs';
import { lessonPrediction, scoreLessonPrediction, sameSpotStreak, stallStreak } from '../public/jump-lab.mjs';
import { planJump, learnJumpLesson, holdExperiment } from '../server/jump-model.mjs';

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

test('stall streak counts attempts that never push the frontier, wins reset it', () => {
  const at = (x, outcome = 'alive') => ({ outcome, to: { x } });
  assert.deepEqual(stallStreak([]), { streak: 0, best: null });
  assert.equal(stallStreak([at(100), at(200), at(205)]).streak, 1, '5px is not real progress');
  assert.equal(stallStreak([at(100), at(368), at(368), { outcome: 'fell', to: { x: 380 } }]).streak, 2, 'hopping in place then falling short');
  assert.equal(stallStreak([at(368), at(368), at(400)]).streak, 0, 'a real gain resets');
  assert.equal(stallStreak([at(368), at(368), { outcome: 'won', to: { x: 368 } }]).streak, 0, 'winning resets');
  assert.equal(stallStreak([at(100), at(200)], 16).best, 200);
});

test('hold experiment measures real jump physics from the take-off spot, zero tokens', () => {
  const level = stageLevel(1);
  const rows = holdExperiment(level, { x: level.spawn.x, y: level.spawn.y, vy: 0, grounded: true });
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.slice(0, 6).map(r => r.holdFrames), [1, 10, 20, 30, 45, 60]);
  const tap = rows[0], held = rows.find(r => r.holdFrames === 45 && r.move === 1), still = rows.at(-1);
  assert.equal(tap.error, undefined);
  assert.ok(held.traveled > tap.traveled, `holding jump must carry farther than tapping (${held.traveled} vs ${tap.traveled})`);
  assert.ok(still.traveled < held.traveled / 2, `the no-direction contrast row barely moves (${still.traveled} vs ${held.traveled})`);
  assert.ok(rows.every(r => r.dead === false), 'stage 1 has solid ground all the way');
});

test('triggered reflection runs the engine experiment and asks for a never-tried variant', async () => {
  const level = starterLevel(), a = actor(level.spawn);
  let system = '', user = {};
  const brain = fake(async messages => {
    system = messages[0].content; user = JSON.parse(messages[1].content);
    return { ops: [], note: '好', tryNext: [{ move: 1, jump: true, frames: 45 }, { move: 1, jump: false, frames: 30 }] };
  });
  const result = await learnJumpLesson(brain, { level, trigger: '连续 2 次尝试都没能推进，卡在原地',
    attempts: [{ from: a, to: { ...a, x: 470 }, outcome: 'fell', actions: [{ move: 1, jump: true, frames: 1 }] }] });
  assert.ok(system.includes('tryNext'), 'the prompt demands a novel variant');
  assert.ok(system.includes('真实物理数据'), 'the prompt marks the experiment as ground truth');
  assert.ok(Array.isArray(user.engineExperiment?.rows), 'the experiment table is in the context');
  assert.equal(user.engineExperiment.rows.length, 7);
  assert.deepEqual(result.tryActions, [{ move: 1, jump: true, frames: 45 }, { move: 1, jump: false, frames: 30 }]);
  assert.equal(result.experiment.length, 7);
  const manual = await learnJumpLesson(fake(async m => { user = JSON.parse(m[1].content); return { ops: [] }; }),
    { level, attempts: [{ from: a, to: { ...a, x: 60 }, outcome: 'alive', actions: [{ move: 1, jump: false, frames: 20 }] }] });
  assert.equal(manual.tryActions, undefined, 'manual summarising runs no experiment');
  assert.equal(user.engineExperiment, undefined);
});
test('attempts recorded under the 360-frame budget are kept, not silently dropped', async () => {
  const level = starterLevel(), a = actor(level.spawn);
  const longRun = [{ move: 1, jump: false, frames: 90 }, { move: 1, jump: false, frames: 90 }, { move: 1, jump: false, frames: 90 }, { move: 1, jump: false, frames: 60 }];
  let user = {};
  const brain = fake(async messages => { user = JSON.parse(messages[1].content); return { actions: [{ move: 1, jump: false, frames: 20 }] }; });
  await planJump(brain, { level, actor: a, progress: progress(),
    attempts: [{ from: a, to: { ...a, x: 700 }, outcome: 'alive', actions: longRun }] });
  assert.equal(user.attempts.length, 1, 'a 330-frame attempt stays in the context');
  assert.equal(user.attempts[0].actions.reduce((n, x) => n + x.frames, 0), 330);
});

test('the engine experiment runs under the real progress: an opened door is open in the probe', () => {
  const level = starterLevel();
  const doorX = level.door.x, from = { x: doorX - 20, y: level.door.y + level.door.h, vy: 0, grounded: true };
  const closed = holdExperiment(level, from, { coins: [], key: false, switchOn: false, won: false });
  const opened = holdExperiment(level, from, { coins: [], key: true, switchOn: true, won: false });
  const closedMax = Math.max(...closed.map(r => r.traveled)), openedMax = Math.max(...opened.map(r => r.traveled));
  assert.ok(openedMax > closedMax, `with the door opened the probe must get further (${openedMax} vs ${closedMax})`);
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
test('the engine experiment anchors on the measured take-off spot, not the segment start', async () => {
  const level = starterLevel(), a = actor(level.spawn);
  let user = {};
  const brain = fake(async messages => { user = JSON.parse(messages[1].content); return { ops: [], note: '', tryNext: [{ move: 1, jump: true, frames: 45 }] }; });
  await learnJumpLesson(brain, { level, trigger: '同一区域连续跌落 2 次',
    attempts: [{ from: a, to: { ...a, x: 470 }, outcome: 'fell', takeOff: { x: 400, y: 400 }, fellAt: 470, actions: [{ move: 1, jump: true, frames: 20 }] }] });
  assert.equal(user.engineExperiment.from.x, 400, 'the probe runs from the real take-off spot, not from x=48');
  assert.equal(user.attempts[0].takeOff.x, 400, 'the take-off anchor is in the episodic card');
  assert.equal(user.attempts[0].fellAt, 470, 'the fall position is in the episodic card');
});
