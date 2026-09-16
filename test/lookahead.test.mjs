import test from 'node:test';
import assert from 'node:assert/strict';
import { actor, progress, step, starterLevel } from '../public/jump-world.mjs';
import { createBuffer, simulate, matches, toBlock, WATER } from '../public/lookahead.mjs';
import { stageLevel } from '../public/jump-stages.mjs';

const run = (level, actions, from = actor(level.spawn)) => simulate(step, { level, actor: from, progress: progress(), actions });

test('the engine can roll a whole block forward before anything is played', () => {
  const level = stageLevel(1);
  const actions = [{ move: 1, jump: false, frames: 60 }];
  const rolled = run(level, actions);
  assert.equal(rolled.frames, 60, 'sixty frames rolled');
  assert.equal(rolled.perFrame.length, 60);
  assert.ok(Math.abs(rolled.end.actor.x - (level.spawn.x + 60 * 3.2)) < .01, 'the rolled state is the real physics');
  assert.equal(rolled.perFrame.at(-1).x, rolled.end.actor.x);
  assert.equal(rolled.end.progress.coins.length >= 1, true, 'progress is rolled too');
});

test('the buffer plays exactly the frames it rolled, frame by frame', () => {
  const level = stageLevel(1), buffer = createBuffer({ high: 600, low: 180 });
  const actions = [{ move: 1, jump: false, frames: 30 }, { move: 0, jump: true, frames: 20 }];
  assert.equal(buffer.push(toBlock(actions, run(level, actions))), true);
  assert.equal(buffer.frames, 50);
  const live = actor(level.spawn), p = progress();
  let played = 0, agreed = 0;
  for (;;) {
    const frame = buffer.next();
    if (!frame) break;
    step(live, frame.action, level, p, 'pet');   // play it first: expectations are post-frame
    if (!matches(frame.expected, live)) { agreed = -1; break; }
    agreed++;
    played++;
  }
  assert.equal(agreed, 50, 'every played frame matched the rolled expectation');
  assert.equal(played, 50);
  assert.equal(buffer.frames, 0);
  assert.ok(Math.abs(live.x - (level.spawn.x + 30 * 3.2)) < .01);
});

test('a divergence invalidates the rest of the film instead of playing a lie', () => {
  const level = stageLevel(1), buffer = createBuffer();
  const actions = [{ move: 1, jump: false, frames: 40 }];
  buffer.push(toBlock(actions, run(level, actions)));
  const live = actor(level.spawn), p = progress();
  const first = buffer.next(); step(live, first.action, level, p, 'pet');
  live.x += 25;                       // something moved the pet that the engine did not plan
  const second = buffer.next();
  assert.equal(matches(second.expected, live), false, 'the mismatch is detected');
  const dropped = buffer.drop('与推演不符');
  assert.equal(dropped.frames, 38);
  assert.equal(buffer.frames, 0);
  assert.equal(buffer.stats.dropped, 1);
});

test('water marks stop the thinking loop before it wastes calls', () => {
  const buffer = createBuffer({ high: 600, low: 180 });
  assert.equal(buffer.needsThink(), true, 'an empty buffer asks for thinking');
  const level = stageLevel(1), actions = [{ move: 1, jump: false, frames: 90 }];
  for (let i = 0; i < 7; i++) buffer.push(toBlock(actions, run(level, actions)));
  assert.equal(buffer.frames, 630);
  assert.equal(buffer.needsThink(), false, 'a full buffer stops the loop');
  for (;;) { const frame = buffer.next(); if (!frame) break; if (!frame.done) continue; }
  assert.ok(buffer.frames <= 180, `drained below the low mark, left ${buffer.frames}`);
  assert.equal(buffer.needsThink(), true, 'and thinking resumes when it drains');
  assert.equal(WATER.high > WATER.low, true);
});

test('blocks that would overflow the cap are refused rather than silently truncated', () => {
  const buffer = createBuffer({ maxFrames: 300, low: 60 });
  const level = stageLevel(1), actions = [{ move: -1, jump: false, frames: 240 }];
  assert.equal(buffer.push(toBlock(actions, run(level, actions))), true);
  assert.equal(buffer.push(toBlock(actions, run(level, actions))), false, 'the second block would overflow');
  assert.equal(buffer.stats.dropped, 1);
  assert.equal(buffer.frames, 240);
});
