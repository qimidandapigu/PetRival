import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './support.mjs';
import { transaction } from '../cloud/store.mjs';
import { CloudArena } from '../cloud/arena.mjs';
import { makeBrain } from '../cloud/brain.mjs';
import worker from '../cloud/worker.mjs';

async function fixture() {
  const db = database(), brain = makeBrain({ AI_MODE: 'algorithm' }); let now = Date.now();
  const act = fn => transaction(db, store => fn(new CloudArena(store, brain, { now: () => now })));
  await act(a => a.createPet('alice', { name: '汤圆', species: 'xiaotangyuan', defense: true }));
  return { db, brain, act, later(ms) { now += ms; } };
}

test('concurrent cloud messages persist across requests, serialize and keep paired private history', async () => {
  const f = await fixture();
  await Promise.all(['first', 'second'].map(message => f.act(a => a.chat('alice', { message, requestId: message }))));
  const one = await f.act(a => a.claimJob('alice', 'foreground'));
  assert.equal(one.kind, 'chat');
  assert.equal(await f.act(a => a.claimJob('alice', 'foreground')), null);
  assert.equal(await f.act(a => a.claimJob('bob', 'foreground')), null);
  await f.act(a => a.finishJob(one, { reply: 'reply1', method: 'algorithm' }));
  const two = await f.act(a => a.claimJob('alice', 'foreground'));
  assert.deepEqual(two.context.history.map(m => m.content), [one.message, 'reply1', two.message]);
  await f.act(a => a.finishJob(two, { reply: 'reply2', method: 'algorithm' }));
  await f.act(a => a.chat('alice', { message: 'third', requestId: 'third' }));
  const three = await f.act(a => a.claimJob('alice', 'foreground'));
  assert.deepEqual(three.context.history.map(m => m.content), [one.message, 'reply1', two.message, 'reply2', 'third']);
  const publicState = JSON.stringify(await f.act(a => a.view('bob')));
  assert.ok(!publicState.includes('reply1')); assert.ok(!publicState.includes('third'));
});

test('a late chat claim cannot act; retry preserves the user turn and only commits one action', async () => {
  const f = await fixture(), input = { message: '请回小屋休息吧', requestId: 'rest' };
  await f.act(a => a.chat('alice', input));
  const old = await f.act(a => a.claimJob('alice', 'foreground'));
  f.later(61000);
  await f.act(a => a.finishJob(old, { reply: 'late', action: 'water', method: 'algorithm' }));
  let chat = await f.act(a => a.chatView('alice', 'rest'));
  assert.equal(chat.request.status, 'failed'); assert.equal(chat.messages.length, 1);
  await f.act(a => a.chat('alice', input));
  const current = await f.act(a => a.claimJob('alice', 'foreground'));
  await f.act(a => a.finishJob(old, { reply: 'stale', action: 'water' }));
  await f.act(a => a.finishJob(current, { reply: '好，我去休息', action: 'rest', method: 'algorithm' }));
  const life = await f.act(a => structuredClone(a.mine('alice').life));
  await f.act(a => a.chat('alice', input));
  await f.act(a => a.finishJob(current, { reply: 'duplicate', action: 'water' }));
  chat = await f.act(a => a.chatView('alice', 'rest'));
  assert.equal(chat.request.status, 'complete'); assert.equal(chat.messages.length, 2);
  assert.deepEqual(await f.act(a => a.mine('alice').life), life);
  await assert.rejects(f.act(a => a.chat('alice', { ...input, message: 'different' })), /消息标识/);
});

test('invalid generation can fail cleanly and keeps the old prepared puzzle usable', async () => {
  const f = await fixture(), before = await f.act(a => a.mine('alice').readyId);
  const job = await f.act(a => a.claimJob('alice', 'preparation'));
  await assert.rejects(f.act(a => a.finishJob(job, { rows: [], proof: '' })));
  await f.act(a => a.failJob(job, 'invalid'));
  const pet = await f.act(a => a.mine('alice'));
  assert.equal(pet.preparing, false); assert.equal(pet.readyId, before);
  await f.act(a => a.prepare(a.mine('alice')));
  assert.ok(await f.act(a => a.claimJob('alice', 'preparation')));
});

test('preparation does not occupy either contestant lane across Worker requests', async () => {
  const f = await fixture();
  const bob = await f.act(a => a.createPet('bob', { name: '狐狸', species: 'fox', defense: true }));
  await f.act(a => a.challenge('alice', bob.id));
  assert.equal((await f.act(a => a.claimJob('alice', 'preparation'))).kind, 'generate');
  assert.equal((await f.act(a => a.claimJob('alice', 'foreground'))).kind, 'play');
  assert.equal((await f.act(a => a.claimJob('alice', 'foreground'))).kind, 'play');
  assert.equal(await f.act(a => a.claimJob('alice', 'foreground')), null);
  assert.equal(await f.act(a => a.claimJob('bob', 'preparation')), null);
});

test('Worker HTTP chat queues, executes and reloads the saved reply and courtyard action', async () => {
  const env = { DB: database(), AI_MODE: 'algorithm' };
  const call = async (path, body, account = 'alice') => {
    const response = await worker.fetch(new Request('https://pet.test' + path, { method: body ? 'POST' : 'GET', headers: { 'oai-authenticated-user-id': account, ...(body ? { 'content-type': 'application/json', origin: 'https://pet.test' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, {});
    return { status: response.status, data: await response.json() };
  };
  await call('/api/pets', { name: '汤圆', species: 'xiaotangyuan', defense: true });
  const queued = await call('/api/pets/chat', { message: '请回小屋休息吧', requestId: 'hello' });
  assert.equal(queued.status, 202); assert.equal(queued.data.request.status, 'pending');
  assert.equal((await call('/api/work?lane=foreground', {}, 'bob')).data.worked, false);
  assert.equal((await call('/api/work?lane=foreground', {})).data.worked, true);
  const saved = await call('/api/pets/chat?requestId=hello');
  assert.equal(saved.data.request.status, 'complete'); assert.equal(saved.data.messages.length, 2);
  assert.match(saved.data.messages[1].content, /小屋/); assert.ok(saved.data.life);
  assert.equal((await call('/api/pets/chat?requestId=hello', undefined, 'bob')).status, 409);
  assert.equal((await call('/api/score-ledger')).data.entries.length, 0);
});
