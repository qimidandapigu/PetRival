import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, parse, move, replay, solve, renderRows, runScore, compareTeams, RULES } from '../shared/game.mjs';

const basic = ['########', '#      #', '# .  . #', '# $  $ #', '#      #', '#  @   #', '#      #', '########'];
test('strict board contract rejects invalid borders, counts and symbols', () => {
  assert.throws(() => parse(['invalid']));
  assert.throws(() => parse(basic.map((r, i) => i === 0 ? ' #######' : r)));
  assert.throws(() => parse(basic.map(r => r.replace('@', '$'))));
  assert.deepEqual(renderRows(parse(basic)), basic);
});
test('movement, pushing, blocked moves and goals use one shared engine', () => {
  const s = parse(basic), proof = solve(basic);
  assert.equal(proof.solved, true); assert.equal(replay(basic, proof.actions).won, true);
  assert.equal(move({ ...s, player: 9 }, 'U').moved, false);
  const push = move({ ...s, player: 34 }, 'U');
  assert.equal(push.pushed, true); assert.ok(push.state.boxes.includes(18));
});
test('undo and restart replay legally; fake actions and post-clear moves are rejected', () => {
  assert.deepEqual(replay(basic, 'LZ').state, parse(basic));
  assert.deepEqual(replay(basic, 'LLX').state, parse(basic));
  assert.throws(() => replay(basic, 'WIN'));
  assert.throws(() => replay(basic, 'U'.repeat(RULES.maxActions + 1)));
  assert.throws(() => replay(basic, solve(basic).actions + 'U'));
});
test('80 generated boards have replayable proofs; same seed is deterministic', () => {
  const hashes = new Set();
  for (let seed = 0; seed < 80; seed++) {
    const g = generate(seed, seed % 2 ? '难一点有点绕' : '入门');
    assert.ok(g.proof.length > 0); assert.equal(replay(g.rows, g.proof).won, true); hashes.add(g.rows.join(''));
  }
  assert.ok(hashes.size >= 50);
  assert.deepEqual(generate(80), generate(80));
});
test('unsolvable is different from exhausted search budget', () => {
  const bad = ['########', '#$     #', '# .  . #', '#    $ #', '#      #', '#  @   #', '#      #', '########'];
  assert.equal(solve(bad).solved, false);
  assert.equal(solve(basic, 1).reason, 'budget');
});
test('score first, then time; early quit never earns a time advantage', () => {
  assert.deepEqual(runScore(false, 1), runScore(false, RULES.limitMs));
  assert.equal(runScore(false, 1).score, -20);
  assert.ok(compareTeams({ score: 200, rankMs: 2000 }, { score: 80, rankMs: 1 }) < 0);
  assert.ok(compareTeams({ score: 200, rankMs: 2000 }, { score: 200, rankMs: 3000 }) < 0);
});
