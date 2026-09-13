import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCloudBase, signInAccount, signOutAccount, accountSession } from '../cloud/auth.mjs';
import { transaction, CloudStore } from '../cloud/store.mjs';
import { CloudArena } from '../cloud/arena.mjs';
import { makeBrain } from '../cloud/brain.mjs';
import { database } from './support.mjs';
import worker from '../cloud/worker.mjs';
const envId = 'test-shanghai-env', verified = { owner: `cloudbase:${envId}:user123`, maskedPhone: '138****1234' };
const request = cookie => new Request('https://pet.example/api/auth/cloudbase', { headers: { cookie: cookie || '' } });
function fixture() {
  const db = database(), brain = makeBrain({ AI_MODE: 'algorithm' }); let now = Date.now();
  return { db, act: fn => transaction(db, store => fn(new CloudArena(store, brain, { now: () => now }))), later: ms => { now += ms; } };
}
test('CloudBase verifies server-side against the configured environment and rejects malformed/disabled/non-phone identities', async () => {
  const config = { CLOUDBASE_ENV_ID: envId }, token = 'test-access-token-123456'; let called = 0;
  const fetcher = async (url, options) => {
    called++; assert.equal(url, `https://${envId}.api.tcloudbasegateway.com/auth/v1/user/me`);
    assert.equal(options.headers.Authorization, `Bearer ${token}`); assert.equal(options.redirect, 'manual');
    return Response.json({ sub: 'user123', status: 'ACTIVE', phone_number: '+86 13800001234' });
  };
  assert.deepEqual(await verifyCloudBase(config, token, fetcher), verified);
  await assert.rejects(verifyCloudBase(config, 'bad', fetcher), { status: 401 }); assert.equal(called, 1);
  await assert.rejects(verifyCloudBase({}, token, fetcher), { status: 503 });
  for (const profile of [{ sub: 'user123', status: 'DISABLED', phone_number: '+86 13800001234' }, { sub: 'user123', status: 'ACTIVE' }, { sub: '../x', status: 'ACTIVE', phone_number: '+86 13800001234' }]) {
    await assert.rejects(verifyCloudBase(config, token, async () => Response.json(profile)), { status: 401 });
  }
  await assert.rejects(verifyCloudBase(config, token, async () => new Response('', { status: 400 })), { status: 401 });
  await assert.rejects(verifyCloudBase(config, token, async () => new Response('', { status: 302 })), { status: 503 });
});
test('guest save binds atomically, retains pet data, persists across devices, and logout revokes only that session', async () => {
  const f = fixture(); const guest = await f.act(a => a.session());
  const pet = await f.act(a => a.createPet(guest.owner, { name: '汤圆', species: 'xiaotangyuan' }));
  const before = await f.act(a => structuredClone(a.s.pets[pet.id]));
  const login = await f.act(a => signInAccount(request(`petrival=${guest.token}`), a, verified));
  assert.equal(login.migrated, true); assert.match(login.setCookie, /HttpOnly.*SameSite=Lax.*Secure/);
  const cookie = login.setCookie.split(';')[0];
  await f.act(a => {
    assert.equal(a.mine(guest.owner), undefined);
    assert.deepEqual(a.s.pets[pet.id], { ...before, owner: verified.owner });
    assert.equal(accountSession(request(cookie), a).owner, verified.owner);
    assert.equal(JSON.stringify(a.s.sessions).includes(cookie.split('=')[1]), false);
  });
  const other = await f.act(a => signInAccount(request(), a, verified));
  await f.act(a => signOutAccount(request(cookie), a));
  await f.act(a => {
    assert.equal(accountSession(request(cookie), a), null);
    assert.equal(a.mine(accountSession(request(other.setCookie.split(';')[0]), a).owner).id, pet.id);
  });
  f.later(31 * 86400000);
  await f.act(a => assert.equal(accountSession(request(other.setCookie.split(';')[0]), a), null));
});
test('existing account conflict preserves both saves and switching phones cannot transfer another phone pet', async () => {
  const f = fixture(), guest = await f.act(a => a.session());
  const g = await f.act(a => a.createPet(guest.owner, { name: '游客', species: 'fox' }));
  const existing = await f.act(a => a.createPet(verified.owner, { name: '账号', species: 'ghost' }));
  const req = request(`petrival=${guest.token}`);
  assert.equal((await f.act(a => signInAccount(req, a, verified))).conflict, true);
  const login = await f.act(a => signInAccount(req, a, verified, { useExisting: true }));
  assert.equal(login.migrated, false);
  await f.act(a => { assert.equal(a.mine(guest.owner).id, g.id); assert.equal(a.mine(verified.owner).id, existing.id); });
  const second = { owner: `cloudbase:${envId}:second`, maskedPhone: '139****5678' };
  const switchResult = await f.act(a => signInAccount(request(login.setCookie.split(';')[0]), a, second, { sourceOwner: verified.owner }));
  assert.equal(switchResult.migrated, false);
  await f.act(a => { assert.equal(a.mine(verified.owner).id, existing.id); assert.equal(a.mine(second.owner), undefined); });
});
test('Sites-authenticated current save can bind and capacity failure cannot orphan a pet', async () => {
  const f = fixture(); const pet = await f.act(a => a.createPet('site:user', { name: '站点', species: 'fox' }));
  await f.act(a => { for (let i = 0; i < 10000; i++) a.s.sessions[`full-${i}`] = { owner: `full-${i}` }; });
  await assert.rejects(f.act(a => signInAccount(request(), a, verified, { sourceOwner: 'site:user' })), { status: 503 });
  await f.act(a => { assert.equal(a.mine('site:user').id, pet.id); a.s.sessions = {}; });
  assert.equal((await f.act(a => signInAccount(request(), a, verified, { sourceOwner: 'site:user' }))).migrated, true);
});
test('Worker phone cookie overrides Sites headers, rejects cross-origin login, and exposes no raw identity', async () => {
  const f = fixture(), config = { DB: f.db, AI_MODE: 'algorithm', CLOUDBASE_ENV_ID: envId };
  const login = await f.act(a => { a.createPet(verified.owner, { name: '手机宠物', species: 'fox' }); return signInAccount(request(), a, verified); });
  const headers = { cookie: login.setCookie.split(';')[0], 'oai-authenticated-user-id': 'different' };
  const state = await (await worker.fetch(new Request('https://pet.example/api/state', { headers }), config, {})).json();
  assert.equal(state.mine.name, '手机宠物'); assert.equal(state.auth.provider, 'cloudbase');
  assert.equal(JSON.stringify(state).includes(verified.owner), false);
  const denied = await worker.fetch(new Request('https://pet.example/api/auth/cloudbase', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' }), config, {});
  assert.equal(denied.status, 403);
  const invalid = await worker.fetch(new Request('https://pet.example/api/auth/cloudbase', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"accessToken":"bad","owner":"site:victim"}' }), config, {});
  assert.equal(invalid.status, 401);
  assert.equal(Object.values((await CloudStore.load(f.db)).state.pets).some(p => p.owner === 'site:victim'), false);
});
