import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http.mjs';
import { generate, solve, RULES } from '../shared/game.mjs';

async function fixture(t, directory) {
  const dataDir = directory || mkdtempSync(join(tmpdir(), 'petrival-companion-'));
  const app = createApp({ dataDir, env: { AI_MODE: 'algorithm' }, brainOptions: { stepMs: 0 } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const raw = async (path, input, cookie) => {
    const response = await fetch(base + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { cookie } : {}), ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const client = async name => {
    const session = await raw('/api/session', {});
    const call = (path, input) => raw(path, input, session.cookie);
    const created = await call('/api/pets', { name, species: 'sprout', defense: true });
    assert.equal(created.status, 201); await app.arena.idle();
    return { call, cookie: session.cookie, pet: app.arena.s.pets[created.body.mine.id], owner: app.arena.owner(session.cookie.slice(9)) };
  };
  return { ...app, base, raw, client, dataDir };
}

test('game catalog and game selection are owner-scoped; old saves begin at level 1 without puzzle-proof XP', async t => {
  const f = await fixture(t), a = await f.client('芽芽');
  const view = (await a.call('/api/state')).body;
  assert.deepEqual(view.games.map(game => [game.id, game.name, game.available]), [['sokoban', '推箱子', true], ['boxing', '打拳', true]]);
  assert.equal(view.mine.selectedGame, 'sokoban');
  assert.equal(view.mine.progression.level, 1); assert.equal(view.mine.progression.xp, 0);
  assert.equal(view.mine.progression.skills.every(skill => !skill.unlocked && skill.uses === 0), true);
  assert.ok(Array.isArray(view.mine.level.rows), 'existing puzzle view remains compatible');
  assert.equal((await a.call('/api/pets/game', { gameId: 'chess' })).status, 422);
  assert.equal((await a.call('/api/pets/game', { gameId: 'boxing' })).body.mine.selectedGame, 'boxing');
  assert.equal((await a.call('/api/state')).body.mine.selectedGame, 'boxing');
  assert.equal((await a.call('/api/pets/game', { gameId: 'sokoban', owner: 'someone-else' })).status, 200);
  assert.equal((await f.raw('/api/pets/game', { gameId: 'sokoban' })).status, 401);
  delete a.pet.growth; delete a.pet.selectedGame; delete a.pet.chat; f.store.save();
  await f.close();
  const next = await fixture(t, f.dataDir);
  const migrated = (await next.raw('/api/state', undefined, a.cookie)).body.mine;
  assert.equal(migrated.progression.level, 1); assert.equal(migrated.progression.clears, 0);
  assert.equal(migrated.selectedGame, 'sokoban');
  assert.deepEqual((await next.raw('/api/pets/chat', undefined, a.cookie)).body.messages, []);
});

test('private chat validates input and exposes neither conversations nor board proofs through public state', async t => {
  const f = await fixture(t), a = await f.client('Mint'), b = await f.client('Other');
  let context;
  f.brain.chat = async input => { context = input; return { reply: '我听见啦。', method: 'model', model: 'test-chat' }; };
  for (const message of ['', '   ', 42, 'a'.repeat(1001)]) assert.equal((await a.call('/api/pets/chat', { message })).status, 422);
  assert.equal((await a.call('/api/pets/chat', { message: '你好', requestId: '../bad' })).status, 422);
  assert.equal((await f.raw('/api/pets/chat')).status, 401);
  const response = await a.call('/api/pets/chat', { message: '只属于我的聊天暗号', requestId: 'private-1', petId: b.pet.id });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(response.body.messages[1].method, 'model'); assert.equal(response.body.messages[1].model, 'test-chat');
  assert.equal(context.name, 'Mint'); assert.equal(context.gameId, 'sokoban');
  assert.deepEqual(context.history, [{ role: 'user', content: '只属于我的聊天暗号' }]);
  assert.deepEqual(Object.keys(context).sort(), ['gameId', 'history', 'life', 'name', 'progression']);
  assert.equal(JSON.stringify(context).includes('proof'), false);
  assert.deepEqual((await b.call('/api/pets/chat')).body.messages, []);
  for (const client of [a, b]) {
    const state = (await client.call('/api/state')).body;
    assert.equal(JSON.stringify(state).includes('只属于我的聊天暗号'), false);
    assert.equal(JSON.stringify(state).includes('messageHash'), false);
  }
  assert.equal((await a.call('/api/state')).body.mine.progression.xp, 0, 'conversation grants no game experience');
});

test('concurrent chat requests serialize, deduplicate request IDs, and reject conflicting reuse', async t => {
  const f = await fixture(t), a = await f.client('Queue');
  let release, announce;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { announce = resolve; });
  const contexts = [];
  f.brain.chat = async input => {
    contexts.push(input); if (contexts.length === 1) { announce(); await gate; }
    return { reply: `回复 ${input.history.at(-1).content}`, method: 'algorithm', model: null };
  };
  const first = a.call('/api/pets/chat', { message: '一', requestId: 'one' });
  await started;
  const duplicate = a.call('/api/pets/chat', { message: '一', requestId: 'one' });
  const second = a.call('/api/pets/chat', { message: '二', requestId: 'two' });
  release();
  const responses = await Promise.all([first, duplicate, second]);
  assert.equal(responses.every(response => response.status === 200), true);
  assert.equal(contexts.length, 2);
  assert.deepEqual(contexts[1].history, [
    { role: 'user', content: '一' }, { role: 'assistant', content: '回复 一' }, { role: 'user', content: '二' },
  ]);
  const stored = (await a.call('/api/pets/chat')).body.messages;
  assert.equal(stored.length, 4);
  assert.equal((await a.call('/api/pets/chat', { message: '另外一句', requestId: 'one' })).status, 409);
  assert.equal(contexts.length, 2);
});

test('chat failures preserve user text without a fabricated reply; same ID retries only once and persists across restart', async t => {
  const f = await fixture(t), a = await f.client('Retry');
  f.brain.chat = async () => { throw new Error('upstream failed'); };
  assert.equal((await a.call('/api/pets/chat', { message: '记住今天', requestId: 'retry' })).status, 503);
  assert.deepEqual((await a.call('/api/pets/chat')).body.messages.map(message => message.role), ['user']);
  f.brain.chat = async () => ({ reply: '现在可以回复了。', method: 'model', model: 'test-chat' });
  const restored = await a.call('/api/pets/chat', { message: '记住今天', requestId: 'retry' });
  assert.equal(restored.status, 200); assert.equal(restored.body.messages.length, 2);
  await f.close();
  const next = await fixture(t, f.dataDir);
  next.brain.chat = async () => { throw new Error('completed request must not call provider again'); };
  const duplicate = await next.raw('/api/pets/chat', { message: '记住今天', requestId: 'retry' }, a.cookie);
  assert.equal(duplicate.status, 200); assert.deepEqual(duplicate.body.messages, restored.body.messages);
  assert.equal((await next.raw('/api/state', undefined, a.cookie)).body.mine.progression.xp, 0);
});

test('practice growth uses engine verification, unique board hashes, and persistent skill milestones', async t => {
  const f = await fixture(t), a = await f.client('Growth');
  f.brain.play = async () => ({ actions: '', won: true, elapsedMs: 1, method: 'model' });
  const fake = await f.arena.practice(a.owner);
  assert.equal(fake.won, false); assert.equal(f.arena.publicPet(a.pet).progression.xp, 0);
  f.brain.play = async rows => ({ actions: solve(rows).actions, elapsedMs: RULES.limitMs + 1, method: 'model' });
  assert.equal((await f.arena.practice(a.owner)).won, false);
  f.brain.play = async rows => ({ actions: solve(rows).actions, elapsedMs: 1, timedOut: true, method: 'model' });
  assert.equal((await f.arena.practice(a.owner)).won, false);
  f.brain.play = async rows => ({ actions: solve(rows).actions, elapsedMs: 1, method: 'model' });
  const first = await f.arena.practice(a.owner);
  assert.equal(first.won, true); assert.equal(f.arena.publicPet(a.pet).progression.xp, 40);
  assert.equal(f.arena.publicPet(a.pet).progression.skills[0].unlocked, true);
  await f.arena.practice(a.owner);
  f.arena.attachLevel(a.pet, { ...generate(33), rows: first.level.rows, proof: solve(first.level.rows).actions });
  await f.arena.practice(a.owner);
  assert.equal(f.arena.publicPet(a.pet).progression.xp, 40, 'new level ID with identical board does not award again');
  for (let seed = 100; f.arena.publicPet(a.pet).progression.clears < 5; seed++) {
    f.arena.attachLevel(a.pet, generate(seed)); await f.arena.practice(a.owner);
    assert.ok(seed < 120, 'test boards should provide enough unique layouts');
  }
  const earned = f.arena.publicPet(a.pet).progression;
  assert.equal(earned.level, 3); assert.equal(earned.xp, 200); assert.equal(earned.xpIntoLevel, 0);
  assert.equal(earned.skills.every(skill => skill.unlocked && Number.isFinite(skill.learnedAt) && skill.uses === 0), true);
  assert.equal(a.pet.score, 0); assert.equal(a.pet.played, 0, 'pet growth does not alter ranking');
  await f.close();
  const next = await fixture(t, f.dataDir);
  assert.deepEqual((await next.raw('/api/state', undefined, a.cookie)).body.mine.progression, earned);
});

test('streamed practices and challenge AI clears award experience; human wins and starting proofs do not', async t => {
  const f = await fixture(t), a = await f.client('Player'), b = await f.client('Rival');
  f.brain.play = async rows => ({ actions: solve(rows).actions, elapsedMs: 1, method: 'algorithm' });
  const practice = await a.call('/api/practice/start', {});
  assert.equal(practice.status, 202); await f.arena.idle();
  assert.equal((await a.call(`/api/practice/${practice.body.id}`)).body.run.status, 'cleared');
  assert.equal((await a.call('/api/state')).body.mine.progression.xp, 40);
  assert.equal((await b.call(`/api/practice/${practice.body.id}`)).status, 404);
  f.arena.attachLevel(b.pet, generate(78)); f.store.save();
  const challenge = await a.call('/api/challenges', { opponentId: b.pet.id });
  assert.equal(challenge.status, 201); await f.arena.idle();
  const grown = (await a.call('/api/state')).body.mine.progression;
  assert.equal(grown.xp, 80);
  await a.call(`/api/challenges/${challenge.body.id}/start`, {});
  const own = challenge.body.sides.find(side => side.own);
  await a.call(`/api/challenges/${challenge.body.id}/finish`, { actions: solve(own.level.rows).actions });
  assert.equal((await a.call('/api/state')).body.mine.progression.xp, 80, 'human clear grants no pet XP');
});

test('saved chat interruption becomes retryable and bounded history stays private', async t => {
  const f = await fixture(t), a = await f.client('History');
  f.brain.chat = async input => ({ reply: `回应 ${input.history.at(-1).content}`, method: 'algorithm' });
  for (let i = 0; i < 35; i++) await f.arena.chat(a.owner, { message: `第 ${i} 句`, requestId: `history-${i}` });
  assert.equal(f.arena.chatView(a.owner).messages.length, 60);
  const saved = JSON.parse(readFileSync(join(f.dataDir, 'petrival.json'), 'utf8'));
  saved.pets[a.pet.id].chat.requests.at(-1).status = 'pending';
  saved.pets[a.pet.id].chat.messages.pop();
  await f.close();
  writeFileSync(join(f.dataDir, 'petrival.json'), JSON.stringify(saved));
  const next = await fixture(t, f.dataDir);
  let historyLength;
  next.brain.chat = async input => { historyLength = input.history.length; return { reply: '恢复后的回复', method: 'algorithm' }; };
  const retry = await next.raw('/api/pets/chat', { message: '第 34 句', requestId: 'history-34' }, a.cookie);
  assert.equal(retry.status, 200); assert.equal(retry.body.messages.length, 60); assert.ok(historyLength <= 20);
  assert.equal(retry.body.messages.at(-1).content, '恢复后的回复');
});
