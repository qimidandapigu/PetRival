import test from 'node:test';
import assert from 'node:assert/strict';
import { actor, progress, starterLevel, tileMap, TILE, TILE_LEGEND } from '../public/jump-world.mjs';
import { stageLevel } from '../public/jump-stages.mjs';

const gridOf = (level, a = actor(level.spawn), p = progress()) => tileMap(level, a, p).rows.join('\n');

test('the tile map reads like a screen: ground, air, water, items, the pet itself', () => {
  const level = stageLevel(1), map = tileMap(level, actor(level.spawn), progress());
  assert.equal(map.tile, TILE);
  assert.equal(map.legend, TILE_LEGEND);
  assert.equal(map.rows.length, 30, 'thirty rows of 16 pixels cover the world');
  const text = map.rows.join('\n');
  assert.equal(text.includes('#'), true, 'ground is drawn');
  assert.equal(text.includes('c'), true, 'the coin is drawn');
  assert.equal(text.includes('k'), true, 'the key is drawn');
  assert.equal(text.includes('s'), true, 'the switch is drawn');
  assert.equal(text.includes('@'), true, 'the pet is drawn');
  assert.equal(text.includes('G'), true, 'the goal is drawn');
  assert.equal(text.slice(text.indexOf('#')).includes('~'), false, 'stage 1 is flat: no water anywhere');
  assert.equal(map.rows[29].includes('#'), true, 'flat ground runs to the bottom of the screen');
  assert.equal(map.rows[29].includes('~'), false);
  assert.equal(map.rows.every(row => [...row].every(ch => TILE_LEGEND.includes(ch) || ch === ' ')), true, 'only legend characters appear');
});

test('a creek shows up as water the pet has to cross, and the door follows its own switch', () => {
  const level = stageLevel(2), a = actor(level.spawn);
  const text = gridOf(level, a);
  const lines = text.split('\n');
  assert.ok(lines.filter(row => row.includes('~')).length >= 3, 'the creek is several rows deep');
  assert.equal(/^#+ +#{2,}$/.test(lines[25]), true, `the ground row shows the gap: ${JSON.stringify(lines[25])}`);
  assert.equal(lines[26].includes('~'), true, 'the row under the gap is water');
  const closed = tileMap(level, a, progress()).rows.join('\n');
  const opened = tileMap(level, a, { coins: [], key: true, switchOn: true }).rows.join('\n');
  assert.equal(closed.includes('D'), true);
  assert.equal(opened.includes('D'), false);
  assert.equal(opened.includes('d'), true, 'an opened door is drawn differently');
  const collected = tileMap(level, a, { coins: [0], key: true, switchOn: false }).rows.join('\n');
  assert.equal(collected.includes('c'), false, 'a collected coin disappears from the screen');
  assert.equal(collected.includes('k'), false, 'a taken key disappears too');
});

test('the pet is drawn where it stands and a dead pet is not drawn at all', () => {
  const level = starterLevel();
  const far = { ...actor(level.spawn), x: 500 };
  const row = tileMap(level, far, progress()).rows.find(r => r.includes('@'));
  assert.ok(row, 'the pet appears somewhere');
  assert.equal(Math.floor(row.indexOf('@') * TILE), Math.floor(500 / TILE) * TILE, 'drawn in the cell that contains it');
  const dead = tileMap(level, { ...actor(level.spawn), dead: true }, progress()).rows.join('\n');
  assert.equal(dead.includes('@'), false);
});
