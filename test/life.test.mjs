import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLife, advanceLife, requestLifeAction, lifeView, lifePosition } from '../shared/life.mjs';
import { createApp } from '../server/http.mjs';

const epoch = 1800000000000;
function pet() { const p = {}; ensureLife(p, epoch); return p; }

test('revision orders same-millisecond actions and simulation updates while old saves keep their existing clock', () => {
  const p = pet(), firstSnapshot = lifeView(p, epoch);
  assert.equal(firstSnapshot.revision, 0);
  requestLifeAction(p, 'feed', epoch);
  const feedSnapshot = lifeView(p, epoch);
  requestLifeAction(p, 'water', epoch);
  const waterSnapshot = lifeView(p, epoch);
  assert.equal(feedSnapshot.updatedAt, waterSnapshot.updatedAt, 'timestamps alone cannot order these two commands');
  assert.ok(feedSnapshot.revision > firstSnapshot.revision);
  assert.ok(waterSnapshot.revision > feedSnapshot.revision, 'a delayed feed response can now be rejected after water was accepted');
  requestLifeAction(p, 'water', epoch);
  assert.equal(lifeView(p, epoch).revision, waterSnapshot.revision, 'duplicate action leaves the same version');
  advanceLife(p, epoch + 18000);
  const completed = lifeView(p, epoch + 18000);
  assert.ok(completed.revision > waterSnapshot.revision);
  assert.equal(completed.updatedAt, epoch + 18000);
  advanceLife(p, epoch + 18000);
  assert.equal(lifeView(p, epoch + 18000).revision, completed.revision, 'unchanged polls leave the same version');

  delete p.life.revision;
  const beforeMigration = { ...p.life };
  assert.equal(ensureLife(p, epoch + 86400000), true);
  assert.deepEqual(p.life, { ...beforeMigration, revision: 0 }, 'migration adds ordering without resetting an old activity or inventing events');
  assert.equal(ensureLife(p, epoch + 86400000), false);
});

test('village advances without chat and saves only when server time advances enough', () => {
  const p = pet();
  assert.equal(advanceLife(p, epoch), false);
  assert.equal(advanceLife(p, epoch + 1000), false);
  assert.equal(p.life.events.length, 0);
  assert.equal(advanceLife(p, epoch + 16000), true);
  assert.equal(p.life.events.length, 1);
  assert.equal(p.life.events[0].at, epoch + 16000);
  assert.equal(p.life.activity, 'water');
  assert.equal(p.life.source, 'routine');
  assert.equal(advanceLife(p, epoch + 16000), false);
  advanceLife(p, epoch + 34000);
  assert.equal(p.life.crops.wateredAt, epoch + 34000);
  advanceLife(p, epoch + 60000);
  assert.ok(p.life.crops.growth > 0);
  assert.ok(p.life.events.length >= 3);
});

test('actions require completion, repeated commands do not inflate stats, interrupted actions give no reward', () => {
  const p = pet();
  assert.throws(() => requestLifeAction(p, 'harvest', epoch), /请选择/);
  requestLifeAction(p, 'feed', epoch);
  const deadline = p.life.endsAt, hunger = p.life.hunger;
  assert.equal(requestLifeAction(p, 'feed', epoch + 1000), false);
  assert.equal(p.life.endsAt, deadline);
  assert.equal(p.life.hunger, hunger);
  assert.equal(p.life.events.length, 0);
  requestLifeAction(p, 'water', epoch + 3000);
  advanceLife(p, epoch + 14000);
  assert.ok(p.life.hunger >= hunger, 'cancelled snack must not fill the pet');
  assert.equal(p.life.crops.wateredAt, null);
  advanceLife(p, epoch + 21000);
  assert.equal(p.life.crops.wateredAt, epoch + 21000);
  assert.equal(p.life.events.length, 1);
  assert.match(p.life.events[0].text, /浇好/);
  const after = JSON.stringify(p.life);
  advanceLife(p, epoch + 21000);
  assert.equal(JSON.stringify(p.life), after);
  requestLifeAction(p, 'rest', epoch + 22000);
  const tired = p.life.energy;
  advanceLife(p, epoch + 42000);
  assert.ok(p.life.energy > tired);
});

test('switching activity halfway along the shared walk route preserves position without completing either action', () => {
  const p = pet();
  requestLifeAction(p, 'water', epoch);
  const previous = lifeView(p, epoch), halfwayAt = epoch + previous.walkMs / 2;
  const expectedPosition = lifePosition(previous, halfwayAt);
  assert.notDeepEqual(expectedPosition, previous.from);
  assert.notDeepEqual(expectedPosition, { x: previous.location.x, y: previous.location.y });
  requestLifeAction(p, 'rest', halfwayAt);
  const interrupted = lifeView(p, halfwayAt);
  assert.deepEqual(interrupted.from, expectedPosition, 'the new walk starts where the scene currently draws the pet');
  assert.deepEqual(lifePosition(interrupted, halfwayAt), expectedPosition);
  assert.equal(interrupted.activity, 'rest');
  assert.equal(interrupted.startedAt, halfwayAt);
  assert.equal(interrupted.events.length, 0);
  assert.equal(interrupted.crops.wateredAt, null, 'the interrupted walk never waters the garden');
  assert.ok(p.life.energy <= previous.energy, 'starting rest does not grant its completion benefit');
});

test('long absences have bounded catchup and crops cannot gain progress from repeated views', () => {
  const p = pet();
  requestLifeAction(p, 'water', epoch);
  advanceLife(p, epoch + 18000);
  const growth = p.life.crops.growth;
  for (let i = 0; i < 100; i++) { advanceLife(p, epoch + 18000); lifeView(p, epoch + 18000); }
  assert.equal(p.life.crops.growth, growth);
  const muchLater = epoch + 365 * 86400000;
  advanceLife(p, muchLater);
  assert.ok(p.life.sequence <= 15, 'one year of offline time cannot create a year of actions');
  assert.ok(p.life.crops.harvests <= 1);
  assert.ok(p.life.endsAt > muchLater);
  assert.ok(p.life.startedAt <= muchLater);
  assert.equal(p.life.crops.wateredAt, null);
  assert.ok(p.life.events.length <= 8);
  const settled = JSON.stringify(p.life);
  assert.equal(advanceLife(p, muchLater), false);
  assert.equal(JSON.stringify(p.life), settled);
  for (const key of ['energy', 'hunger', 'mood']) assert.ok(p.life[key] >= 0 && p.life[key] <= 100);
});

test('life view copies only public facts, and old saves start a fresh clock', () => {
  const p = { createdAt: epoch - 86400000, score: 999, growth: { xp: 42 }, owner: 'private-owner', chat: { messages: ['secret'] } };
  ensureLife(p, epoch);
  assert.equal(p.life.initializedAt, epoch);
  assert.equal(p.life.events.length, 0);
  assert.equal(lifeView(p, epoch).day, 1);
  assert.equal(lifeView(p, epoch).timeOfDay, 'morning');
  const view = lifeView(p, epoch);
  view.location.x = -3; view.crops.harvests = 100; view.events.push({ text: 'invented' });
  assert.equal(p.life.location.x, .49); assert.equal(p.life.crops.harvests, 0); assert.equal(p.life.events.length, 0);
  assert.equal(JSON.stringify(view).includes('secret'), false);
  assert.equal(JSON.stringify(view).includes('private-owner'), false);
  assert.equal('sequence' in view, false);
  advanceLife(p, epoch + 720000);
  assert.equal(lifeView(p, epoch + 720000).day, 2);
  assert.equal(p.score, 999); assert.equal(p.growth.xp, 42);
});

async function fixture(t, dataDir, clock, env = {}) {
  const app = createApp({ dataDir: dataDir || mkdtempSync(join(tmpdir(), 'petrival-life-')), env: { AI_MODE: 'algorithm', ...env },
    now: () => clock.value, brainOptions: { stepMs: 0 } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(close);
  const call = async (path, input, cookie) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
      method: input === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const client = async name => {
    const { cookie } = await call('/api/session', {});
    const created = await call('/api/pets', { name, species: 'sprout' }, cookie);
    assert.equal(created.status, 201); await app.arena.idle();
    return { cookie, id: created.body.mine.id, call: (path, input) => call(path, input, cookie) };
  };
  return { ...app, close, call, client, dataDir: app.store.file.slice(0, -'petrival.json'.length) };
}

test('an optional cookie name isolates localhost preview identity and rejects invalid names', async t => {
  for (const name of ['', 'bad name', 'bad;name', 'bad=name', 'bad\r\nname', 'a'.repeat(65)]) {
    assert.throws(() => createApp({ env: { AI_MODE: 'algorithm', COOKIE_NAME: name } }), /COOKIE_NAME/);
  }
  const f = await fixture(t, null, { value: epoch }, { COOKIE_NAME: 'petrival_world_preview' });
  const session = await f.call('/api/session', {});
  assert.match(session.cookie, /^petrival_world_preview=[a-f0-9]{64}$/);
  const token = session.cookie.slice('petrival_world_preview='.length);
  assert.equal((await f.call('/api/state', undefined, `petrival=${token}`)).status, 401, 'another app cookie name cannot authenticate this preview');
  const adopted = await f.call('/api/pets', { name: '小院居民', species: 'sprout' }, session.cookie);
  assert.equal(adopted.status, 201); await f.arena.idle();
  const bothCookies = `petrival=other-local-app; ${session.cookie}`;
  const state = await f.call('/api/state', undefined, bothCookies);
  assert.equal(state.status, 200); assert.equal(state.body.mine.id, adopted.body.mine.id);
  const resumed = await f.call('/api/session', {}, bothCookies);
  assert.equal(resumed.status, 200); assert.equal(resumed.cookie, undefined, 'an existing named session preserves its identity');
});

test('conversation actions are owner-scoped, ignore client action claims, and persist across restart', async t => {
  const clock = { value: epoch }, f = await fixture(t, null, clock), a = await f.client('小芽'), b = await f.client('小狐');
  assert.equal((await f.call('/api/pets/chat', { message: '一起去菜园吧' })).status, 401);
  const empty = await f.call('/api/session', {});
  assert.equal((await f.call('/api/pets/chat', { message: '一起去菜园吧' }, empty.cookie)).status, 409);
  assert.equal((await a.call('/api/pets/life', { action: 'water' })).status, 404, 'direct button control is no longer exposed');
  f.brain.chat = async () => ({ reply: '好呀，我去看看菜苗，给它们浇点水。', action: 'water', method: 'model', model: 'test-chat' });
  const response = await a.call('/api/pets/chat', { message: '一起去菜园吧', requestId: 'garden-chat', action: 'feed', petId: b.id, xp: 999, energy: 999, crops: { harvests: 999 } });
  assert.equal(response.status, 200); assert.equal(response.body.life.activity, 'water');
  assert.equal(response.body.life.source, 'conversation'); assert.equal(response.body.life.crops.harvests, 0);
  assert.equal(response.body.life.crops.wateredAt, null); assert.equal(response.body.life.events.length, 0, 'chat accepts a schedule, never a completed reward');
  assert.equal(f.arena.s.pets[b.id].life.activity, 'wander');
  let saves = 0;
  const save = f.store.save.bind(f.store); f.store.save = () => { saves++; save(); };
  for (let i = 0; i < 3; i++) await a.call('/api/state');
  assert.equal(saves, 0, 'polling unchanged time does not write the store');
  clock.value += 18000;
  f.arena.tick();
  assert.equal(f.arena.s.pets[a.id].life.crops.wateredAt, clock.value);
  const state = (await a.call('/api/state')).body;
  assert.equal(state.mine.progression.xp, 0); assert.equal(state.mine.score, 0);
  assert.equal(state.pets.some(p => 'life' in p), false, 'other owners do not see the private living journal');
  const savedLife = state.mine.life;
  assert.ok(savedLife.revision > response.body.life.revision);
  assert.equal(savedLife.updatedAt, clock.value);
  await f.close();
  const restored = await fixture(t, f.dataDir, clock);
  assert.deepEqual((await restored.call('/api/state', undefined, a.cookie)).body.mine.life, savedLife);
  let context;
  restored.brain.chat = async input => { context = input; return { reply: '菜园已经浇好水啦。', method: 'algorithm' }; };
  const chat = await restored.call('/api/pets/chat', { message: '你在做什么' }, a.cookie);
  assert.equal(chat.status, 200); assert.deepEqual(context.life, savedLife); assert.deepEqual(chat.body.life, savedLife);
  assert.equal(context.life.events.length, 1);
  assert.equal(JSON.stringify(context.life).includes('proof'), false);
});

test('invalid replies, invalid actions and provider failures never schedule conversation actions; retries can recover once', async t => {
  const clock = { value: epoch }, f = await fixture(t, null, clock), a = await f.client('小芽');
  const initial = (await a.call('/api/state')).body.mine.life;
  let attempts = 0;
  for (const result of [{ reply: '', action: 'water' }, { reply: 'x'.repeat(4001), action: 'rest' },
    ...['harvest', '', 1, {}, ['water']].map(action => ({ reply: '我准备出门啦。', action }))]) {
    f.brain.chat = async () => result;
    assert.equal((await a.call('/api/pets/chat', { message: '去菜园吧', requestId: `bad-${attempts++}` })).status, 503);
    assert.deepEqual((await a.call('/api/state')).body.mine.life, initial);
  }
  f.brain.chat = async () => { throw new Error('upstream failed'); };
  assert.equal((await a.call('/api/pets/chat', { message: '吃点东西吧', requestId: 'recover' })).status, 503);
  assert.deepEqual((await a.call('/api/state')).body.mine.life, initial);
  assert.equal((await a.call('/api/pets/chat')).body.messages.some(message => message.role === 'assistant'), false);
  f.brain.chat = async () => ({ reply: '好呀，刚好有点饿了。', action: 'feed', method: 'model' });
  const recovered = await a.call('/api/pets/chat', { message: '吃点东西吧', requestId: 'recover' });
  assert.equal(recovered.status, 200); assert.equal(recovered.body.life.source, 'conversation');
  assert.equal(recovered.body.life.hunger, initial.hunger);
  const deadline = recovered.body.life.endsAt;
  clock.value += 1000;
  f.brain.chat = async () => { throw new Error('duplicate must not ask the provider'); };
  const duplicate = await a.call('/api/pets/chat', { message: '吃点东西吧', requestId: 'recover' });
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.life.endsAt, deadline);
  clock.value = deadline; f.arena.tick();
  const finished = (await a.call('/api/state')).body.mine;
  assert.ok(finished.life.hunger < initial.hunger); assert.equal(finished.progression.xp, 0);
  assert.equal(finished.life.events.length, 1);
});

test('a queued duplicate and autonomous ticks during model thinking cannot replay the accepted action', async t => {
  const clock = { value: epoch }, f = await fixture(t, null, clock), a = await f.client('慢慢');
  let release, announced, calls = 0;
  const ready = new Promise(resolve => { announced = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  f.brain.chat = async () => { calls++; announced(); await pending; return { reply: '嗯，我先回小屋休息一会儿。', action: 'rest', method: 'model' }; };
  const owner = f.arena.s.pets[a.id].owner, input = { message: '今天慢慢来，歇会儿吧', requestId: 'slow-chat' };
  const first = f.arena.chat(owner, input);
  await ready;
  const duplicate = f.arena.chat(owner, input);
  clock.value += 20000; f.arena.tick();
  const duringThinking = (await a.call('/api/state')).body.mine.life;
  assert.equal(duringThinking.source, 'routine'); assert.equal(duringThinking.events.length, 1);
  const expectedPosition = lifePosition(duringThinking, clock.value);
  release();
  const [accepted, repeated] = await Promise.all([first, duplicate]);
  assert.equal(calls, 1); assert.deepEqual(repeated.life, accepted.life);
  assert.equal(accepted.life.source, 'conversation'); assert.equal(accepted.life.startedAt, clock.value);
  assert.deepEqual(accepted.life.from, expectedPosition);
  assert.equal(accepted.life.events.length, 1, 'only the earlier routine walk has completed');
  assert.ok(accepted.life.energy <= duringThinking.energy, 'the accepted rest is not yet a completed rest');
  await f.close();
  const restored = await fixture(t, f.dataDir, clock);
  restored.brain.chat = async () => { throw new Error('saved receipt must survive a restart'); };
  const resumed = await restored.call('/api/pets/chat', input, a.cookie);
  assert.equal(resumed.status, 200); assert.deepEqual(resumed.body.life, accepted.life);
  clock.value = accepted.life.endsAt; restored.arena.tick();
  const completed = (await restored.call('/api/state', undefined, a.cookie)).body.mine;
  assert.ok(completed.life.energy > accepted.life.energy); assert.equal(completed.progression.xp, 0);
  assert.equal(completed.life.events.filter(event => /休息/.test(event.text)).length, 1);
});

test('completed request receipts outlive visible history so an old successful chat cannot restart its action', async t => {
  const clock = { value: epoch }, f = await fixture(t, null, clock), a = await f.client('记得');
  const owner = f.arena.s.pets[a.id].owner;
  let calls = 0;
  f.brain.chat = async () => { calls++; return { reply: '去菜园逛逛吧。', action: 'water', method: 'model' }; };
  await f.arena.chat(owner, { message: '一起去菜园吧', requestId: 'first-action' });
  clock.value += 18000; f.arena.tick();
  f.brain.chat = async () => { calls++; return { reply: '我在听。', action: null, method: 'model' }; };
  for (let i = 0; i < 65; i++) await f.arena.chat(owner, { message: `聊聊第${i}件小事`, requestId: `later-${i}` });
  const before = f.arena.chatView(owner), previousCalls = calls;
  assert.equal(before.messages.length, 60);
  const repeated = await f.arena.chat(owner, { message: '一起去菜园吧', requestId: 'first-action' });
  assert.equal(calls, previousCalls); assert.deepEqual(repeated.life, before.life);
  assert.equal(repeated.life.source, 'routine');
  await assert.rejects(() => f.arena.chat(owner, { message: '另一句话', requestId: 'first-action' }), error => error.status === 409);
  assert.equal(f.arena.publicPet(f.arena.s.pets[a.id]).progression.xp, 0);
});

test('a failed reply-and-action save rolls back the action before allowing a retry', async t => {
  const clock = { value: epoch }, f = await fixture(t, null, clock), a = await f.client('稳稳');
  const p = f.arena.s.pets[a.id], initial = lifeView(p, clock.value);
  const save = f.store.save.bind(f.store); let failed = false;
  f.store.save = () => {
    if (!failed && p.chat.requests.some(request => request.id === 'save-retry' && request.status === 'complete')) {
      failed = true; throw new Error('simulated disk write failure');
    }
    save();
  };
  f.brain.chat = async () => ({ reply: '想回小屋歇一会儿。', action: 'rest', method: 'model' });
  const input = { message: '累了吗', requestId: 'save-retry' };
  assert.equal((await a.call('/api/pets/chat', input)).status, 503);
  assert.deepEqual(lifeView(p, clock.value), initial);
  assert.equal(p.chat.messages.some(message => message.role === 'assistant'), false);
  const recovered = await a.call('/api/pets/chat', input);
  assert.equal(recovered.status, 200); assert.equal(recovered.body.life.source, 'conversation');
  assert.equal(recovered.body.life.events.length, 0); assert.equal(recovered.body.life.energy, initial.energy);
  assert.equal(recovered.body.messages.filter(message => message.role === 'user').length, 1);
});
