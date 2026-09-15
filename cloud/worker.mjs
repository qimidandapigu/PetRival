import { planJump, generateJump } from '../server/jump-model.mjs';
import { CloudArena } from './arena.mjs';
import { transaction } from './store.mjs';
import { makeBrain, executeJob } from './brain.mjs';
import { ApiError } from '../server/arena.mjs';
import { createHash } from 'node:crypto';
import { accountSession, authConfig, verifyCloudBase, signInAccount, signOutAccount } from './auth.mjs';
import { CloudBoxing, executeBoxing } from './boxing.mjs';

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });
const cookieToken = req => (req.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith('petrival='))?.slice(9);
// Sites dispatch owns these headers. Some routes currently forward the verified
// email without the optional user ID; hash it so no email enters public pet data.
const signedIdentity = req => {
  const id = req.headers.get('oai-authenticated-user-id'); if (id) return `site:${id}`;
  const email = req.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  return email ? `site-email:${createHash('sha256').update(email).digest('hex')}` : null;
};
const identity = (req, arena) => accountSession(req, arena)?.owner || signedIdentity(req) || arena.owner(cookieToken(req));
async function readBody(request) {
  const reader = request.body?.getReader(); if (!reader) return {};
  const chunks = []; let bytes = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 32768) { await reader.cancel(); throw new ApiError(413, '请求过大'); } chunks.push(value); }
  const all = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  try { const data = JSON.parse(new TextDecoder().decode(all) || '{}'); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; }
  catch { throw new ApiError(400, '需要 JSON 对象'); }
}
const runTransaction = (env, brain, callback) => transaction(env.DB, store => callback(new CloudArena(store, brain), store));
function limit(arena, owner, kind, maximum) {
  const id = `rate:${owner}`, current = arena.now();
  const session = arena.s.sessions[id] ||= { owner, createdAt: current, limits: {} };
  session.limits ||= {};
  let bucket = session.limits[kind]; if (!bucket || current - bucket.start >= 60000) bucket = session.limits[kind] = { start: current, count: 0 };
  if (++bucket.count > maximum) throw new ApiError(429, '操作太频繁，请稍后再试');
}
async function work(request, env, brain) {
  const job = await runTransaction(env, brain, arena => {
    const owner = identity(request, arena); if (!owner) throw new ApiError(401, '请先登录或建立访客身份');
    const lane = new URL(request.url).searchParams.get('lane') || 'foreground';
    if (!['foreground', 'preparation'].includes(lane)) throw new ApiError(422, '未知任务通道');
    return arena.claimJob(owner, lane);
  });
  if (!job) return json({ worked: false });
  const encoder = new TextEncoder(), abort = new AbortController();
  // Keep the job's HTTP response open while it runs. A short response followed by
  // waitUntil is insufficient for a model call. Jobs and leases survive a lost tab.
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = value => { if (!closed) try { controller.enqueue(encoder.encode(value)); } catch { closed = true; } };
      const pulse = setInterval(() => send('\n'), 10000);
      send('\n');
      (async () => {
        try {
          const result = await executeJob(brain, job, abort.signal);
          await runTransaction(env, brain, arena => arena.finishJob(job, result));
          send(JSON.stringify({ worked: true }));
        } catch (error) {
          // Keep diagnostic detail server-side; never log credentials or model content.
          console.error('PetRival job failed', job.kind, error.name, error.code || '', error.upstreamStatus || '');
          try { await runTransaction(env, brain, arena => arena.failJob(job, '任务执行中断或服务不可用')); } catch { /* persisted lease recovers */ }
          send(JSON.stringify({ worked: true, failed: true }));
        } finally { clearInterval(pulse); brain.close(); if (!closed) { closed = true; try { controller.close(); } catch {} } }
      })();
    },
    cancel() { abort.abort(); brain.close(); },
  });
  return new Response(stream, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

async function boxingWork(request, env, brain) {
  const apply = fn => runTransaction(env, brain, arena => {
    const owner = identity(request, arena); if (!owner) throw new ApiError(401, '请先建立访客身份');
    return fn(new CloudBoxing(arena, brain), owner);
  });
  const claim = await apply((boxing, owner) => boxing.claim(owner));
  if (!claim) return json({ worked: false });
  try { const result = await executeBoxing(brain, claim); await apply(boxing => boxing.finish(claim, result)); return json({ worked: true }); }
  catch { await apply(boxing => boxing.fail(claim)); return json({ worked: true, failed: true }); }
  finally { brain.close(); }
}

async function jumpWork(request, env, brain, input, generation) {
  const nonce = crypto.randomUUID();
  const lease = await runTransaction(env, brain, arena => {
    const owner = identity(request, arena); if (!owner) throw new ApiError(401, '请先登录或建立访客身份');
    const id = `jump:${owner}:${generation}`;
    limit(arena, owner, id, generation ? 2 : 20);
    if (arena.s.sessions[id]?.until > arena.now()) throw new ApiError(429, '上一段模型请求还在处理中');
    arena.s.sessions[id] = { owner, createdAt: arena.now(), until: arena.now() + (generation ? 270000 : 110000), nonce };
    return id;
  });
  const abort = new AbortController(), encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = value => { if (!closed) try { controller.enqueue(encoder.encode(value)); } catch { closed = true; } };
      const pulse = setInterval(() => send('\n'), 10000);
      send('\n');
      (async () => {
        try { send(JSON.stringify(await (generation ? generateJump : planJump)(brain, input, { signal: abort.signal }))); }
        catch (e) { send(JSON.stringify({ error: e.status ? e.message : '模型服务暂不可用，当前关卡已保留' })); }
        finally {
          clearInterval(pulse); brain.close();
          try { await runTransaction(env, brain, arena => { if (arena.s.sessions[lease]?.nonce === nonce) delete arena.s.sessions[lease]; }); } catch { /* lease expires */ }
          if (!closed) { closed = true; try { controller.close(); } catch {} }
        }
      })();
    },
    cancel() { abort.abort(); brain.close(); },
  });
  return new Response(stream, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), path = url.pathname;
    try {
      if (!path.startsWith('/api/')) {
        if (path === '/boxing' || path === '/boxing.html') return Response.redirect(new URL('/#boxing', url), 302);
        const response = await env.ASSETS.fetch(url.pathname === path ? request : new Request(url, request));
        const headers = new Headers(response.headers);
        headers.set('x-content-type-options', 'nosniff');
        headers.set('referrer-policy', 'strict-origin-when-cross-origin');
        return new Response(response.body, { status: response.status, headers });
      }
      if (!env.DB) throw new ApiError(503, '数据库尚未连接，请稍后再试');
      if (!['GET', 'POST'].includes(request.method)) throw new ApiError(405, '不支持此方法');
      if (request.method === 'POST') {
        if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ApiError(415, '需要 application/json');
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) throw new ApiError(403, '拒绝跨站请求');
      }
      const brain = makeBrain(env), input = request.method === 'POST' ? await readBody(request) : {};
      if (path === '/api/auth/config' && request.method === 'GET') return json(authConfig(env));
      if (path === '/api/auth/cloudbase' && request.method === 'POST') {
        await runTransaction(env, brain, arena => limit(arena, request.headers.get('cf-connecting-ip') || 'local', 'phone-login', 12));
        const verified = await verifyCloudBase(env, input.accessToken);
        const result = await runTransaction(env, brain, arena => signInAccount(request, arena, verified, { useExisting: input.useExisting === true, sourceOwner: signedIdentity(request) }));
        if (result.conflict) return json({ error: '这个手机号已有宠物存档，请选择要使用的存档', code: 'account_has_pet', guestName: result.guestName, accountName: result.accountName }, 409);
        return json({ ok: true, migrated: result.migrated }, 200, { 'set-cookie': result.setCookie });
      }
      if (path === '/api/auth/logout' && request.method === 'POST') {
        const cookie = await runTransaction(env, brain, arena => signOutAccount(request, arena));
        return json({ ok: true }, 200, { 'set-cookie': cookie });
      }
      if (path === '/api/health' && request.method === 'GET') { await env.DB.prepare('SELECT revision FROM arena_meta LIMIT 1').all(); return json({ ok: true, game: 'PetRival', storage: 'D1', ...brain.info() }); }
      if (['/api/jump/decision', '/api/jump/generate'].includes(path) && request.method === 'POST') return await jumpWork(request, env, brain, input, path.endsWith('generate'));
      if (path === '/api/work' && request.method === 'POST') return await work(request, env, brain);
      if (path === '/api/boxing/work' && request.method === 'POST') return await boxingWork(request, env, brain);
      let responseStatus = 200, responseHeaders = {};
      const result = await runTransaction(env, brain, (arena, store) => {
        const owner = identity(request, arena);
        if (path === '/api/session' && request.method === 'POST') {
          if (owner) return { ok: true, signedIn: !!(accountSession(request, arena) || signedIdentity(request)) };
          limit(arena, request.headers.get('cf-connecting-ip') || 'local', 'session', 15);
          const session = arena.session(); responseStatus = 201;
          responseHeaders['set-cookie'] = `petrival=${session.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${url.protocol === 'https:' ? '; Secure' : ''}`;
          return { ok: true, signedIn: false };
        }
        if (!owner) throw new ApiError(401, '请先登录或建立访客身份');
        if (request.method === 'POST') limit(arena, owner, path.startsWith('/api/boxing') ? 'boxing-writes' : 'writes', path.startsWith('/api/boxing') ? 600 : 180);
        if (path.startsWith('/api/boxing')) {
          const boxing = new CloudBoxing(arena, brain);
          if (path === '/api/boxing' && request.method === 'GET') return boxing.view(owner);
          if (path === '/api/boxing' && request.method === 'POST') { limit(arena, owner, 'boxing-create', 6); responseStatus = 201; return boxing.create(owner, input.opponentId); }
          const route = path.match(/^\/api\/boxing\/([\w-]+)(?:\/(start|input|surrender))?$/);
          if (route) {
            const [, id, action] = route;
            if (!action && request.method === 'GET') return boxing.get(owner, id);
            if (request.method === 'POST' && action) return action === 'input' ? boxing.input(owner, id, input) : action === 'start' ? boxing.start(owner, id) : boxing.surrender(owner, id);
          }
        }
        if (path === '/api/state' && request.method === 'GET') {
          const account = accountSession(request, arena);
          return { ...arena.view(owner), storage: 'D1', signedIn: !!(account || signedIdentity(request)), auth: { phoneEnabled: authConfig(env).enabled, provider: account ? 'cloudbase' : signedIdentity(request) ? 'chatgpt' : 'guest', maskedPhone: account?.maskedPhone || null } };
        }
        if (path === '/api/score-ledger' && request.method === 'GET') { const pet = arena.mine(owner); return { petId: pet?.id || null }; }
        if (path === '/api/pets' && request.method === 'POST') { if (Object.values(arena.s.pets).length >= 500) throw new ApiError(503, '本轮试玩名额已满'); arena.createPet(owner, input); responseStatus = 201; return arena.view(owner); }
        if (path === '/api/pets/appearance' && request.method === 'POST') { arena.updateAppearance(owner, input); return arena.view(owner); }
        if (path === '/api/pets/game' && request.method === 'POST') return arena.selectGame(owner, input);
        if (path === '/api/pets/skill/check' && request.method === 'POST') return arena.checkCompetitionSkill(owner, input);
        if (path === '/api/pets/skill' && request.method === 'POST') return arena.updateCompetitionSkill(owner, input);
        if (path === '/api/pets/chat' && request.method === 'GET') { arena.tick(); return arena.chatView(owner, url.searchParams.get('requestId')); }
        if (path === '/api/pets/chat' && request.method === 'POST') { limit(arena, owner, 'chat', 20); arena.tick(); const chat = arena.chat(owner, input); responseStatus = chat.request?.status === 'complete' ? 200 : 202; return chat; }
        if (path === '/api/pets/prepare' && request.method === 'POST') {
          limit(arena, owner, 'prepare', 2); const pet = arena.mine(owner); if (!pet) throw new ApiError(409, '请先领养宠物');
          arena.prepare(pet, input.intent, input.puzzleSettings); responseStatus = 202; return arena.view(owner);
        }
        if (path === '/api/practice/start' && request.method === 'POST') { limit(arena, owner, 'practice', 2); responseStatus = 202; return arena.startPractice(owner, input); }
        const practice = path.match(/^\/api\/practice\/([\w-]+)$/);
        if (practice && request.method === 'GET') return arena.getPractice(owner, practice[1]);
        if (path === '/api/challenges' && request.method === 'POST') {
          limit(arena, owner, 'challenge', 6);
          if (Object.keys(store.state.challenges).length >= 2000) throw new ApiError(503, '本轮试玩对局已满，请等待下一轮开放');
          responseStatus = 201; return arena.challenge(owner, input.opponentId);
        }
        const route = path.match(/^\/api\/challenges\/([\w-]+)(?:\/(start|finish))?$/);
        if (route) {
          const [, id, action] = route;
          if (!action && request.method === 'GET') { arena.tick(); return arena.matchView(arena.matchFor(id, owner), owner); }
          if (action === 'start' && request.method === 'POST') return arena.start(owner, id);
          if (action === 'finish' && request.method === 'POST') return arena.finish(owner, id, input);
        }
        throw new ApiError(404, '接口不存在');
      });
      if (path === '/api/score-ledger') {
        const rows = result.petId ? await env.DB.prepare('SELECT match_id, delta, total, rank_ms, outcome, created_at FROM score_ledger WHERE pet_id = ? ORDER BY created_at DESC LIMIT 50').bind(result.petId).all() : { results: [] };
        return json({ entries: rows.results });
      }
      return json(result, responseStatus, responseHeaders);
    } catch (error) {
      if (!error.status) console.error('PetRival request failed:', error.name, error.message);
      return json({ error: error.status ? error.message : '服务暂时不可用，请稍后重试；积分不会因服务异常被扣除' }, error.status || 503);
    }
  },
};
