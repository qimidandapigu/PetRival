import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLevel, attributeAttempt, actor } from '../public/jump-world.mjs';

// A minimal level: solid start platform, a real gap, solid far platform.
const level = validateLevel({
  version: 2, width: 800, spawn: { x: 48, y: 400 },
  platforms: [{ x: 0, y: 400, w: 208 }, { x: 400, y: 400, w: 400 }],
  coins: [{ x: 80, y: 388 }], key: { x: 120, y: 388 }, switch: { x: 150, y: 388 },
  door: { x: 600, y: 320, h: 96 }, goal: { x: 700, y: 388 },
});
const bag = (over = {}) => ({ coins: [], key: false, switchOn: false, ...over });
const at = (x, y, over = {}) => ({ x, y, vy: 0, grounded: true, dead: false, won: false, ...over });

test('goal rejection names exactly the missing preconditions', () => {
  const evs = attributeAttempt(at(700, 388), level, bag({ key: true, switchOn: true }), { won: false });
  const goal = evs.find(e => e.id === 'goal');
  assert.ok(goal, 'standing at the goal without winning must say so');
  assert.match(goal.msg, /终点/);
  assert.match(goal.msg, /金币（还差 1 枚）/);
  assert.ok(!/取得钥匙|踩开机关/.test(goal.msg), 'met preconditions are not listed');
});

test('goal with everything missing lists key, switch and coins together', () => {
  const evs = attributeAttempt(at(700, 388), level, bag(), { won: false });
  const goal = evs.find(e => e.id === 'goal');
  assert.match(goal.msg, /取得钥匙/);
  assert.match(goal.msg, /踩开机关/);
  assert.match(goal.msg, /金币（还差 1 枚）/);
});

test('won progress silences the goal event', () => {
  const full = bag({ key: true, switchOn: true, coins: [0] });
  const evs = attributeAttempt(at(700, 388), level, full, { won: true });
  assert.ok(!evs.some(e => e.id === 'goal'));
});

test('flying over a coin is attributed as a near-miss, walking into it is not', () => {
  const flyover = attributeAttempt(at(80, 340, { grounded: false, vy: -2 }), level, bag(), { won: false });
  assert.ok(flyover.some(e => e.id === 'coin-0' && /碰到/.test(e.msg)), 'airborne above the coin');
  const walking = attributeAttempt(at(80, 400), level, bag(), { won: false });
  assert.ok(!walking.some(e => e.id === 'coin-0'), 'inside the touch radius the effect fires — no near-miss');
});

test('switch without the key explains the precondition, with the key it stays silent', () => {
  const noKey = attributeAttempt(at(150, 400), level, bag(), { won: false });
  assert.ok(noKey.some(e => e.id === 'switch' && /先取得钥匙/.test(e.msg)));
  const withKey = attributeAttempt(at(150, 400), level, bag({ key: true }), { won: false });
  assert.ok(!withKey.some(e => e.id === 'switch' && /先取得钥匙/.test(e.msg)));
});

test('pressing into a closed door is attributed to the switch, not the jump', () => {
  const evs = attributeAttempt(at(582, 400), level, bag(), { won: false }, { prevX: 582, move: 1 });
  const door = evs.find(e => e.id === 'door');
  assert.ok(door, 'blocked at the door');
  assert.match(door.msg, /先踩开机关/);
  const open = attributeAttempt(at(582, 400), level, bag({ switchOn: true }), { won: false }, { prevX: 582, move: 1 });
  assert.ok(!open.some(e => e.id === 'door'), 'an open door is not an obstacle');
});

test('done interactables produce no events at all', () => {
  const full = bag({ key: true, switchOn: true, coins: [0] });
  const evs = attributeAttempt(at(150, 400), level, full, { won: true });
  assert.deepEqual(evs, []);
});
