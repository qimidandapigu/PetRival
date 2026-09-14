import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { Jobs } from './jobs.mjs';
import { PetBrain } from './provider.mjs';
import { BoxingArena } from './boxing-arena.mjs';
import { Arena, ApiError } from './arena.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = {
  '/boxing': ['public/boxing.html', 'text/html; charset=utf-8'],
  '/boxing.html': ['public/boxing.html', 'text/html; charset=utf-8'],
  '/boxing.mjs': ['public/boxing.mjs', 'text/javascript; charset=utf-8'],
  '/boxing.css': ['public/boxing.css', 'text/css; charset=utf-8'],
  '/ai-comparison.html': ['public/ai-comparison.html', 'text/html; charset=utf-8'],
  '/ai-comparison.mjs': ['public/ai-comparison.mjs', 'text/javascript; charset=utf-8'],
  '/ai-comparison.css': ['public/ai-comparison.css', 'text/css; charset=utf-8'],
  '/ai-comparison-data.json': ['public/ai-comparison-data.json', 'application/json'],
  '/about': ['public/about.html', 'text/html; charset=utf-8'],
  '/about.html': ['public/about.html', 'text/html; charset=utf-8'],
  '/about.css': ['public/about.css', 'text/css; charset=utf-8'],
  '/about.mjs': ['public/about.mjs', 'text/javascript; charset=utf-8'],
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['public/app.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/duel.css': ['public/duel.css', 'text/css; charset=utf-8'],
  '/shared/game.mjs': ['shared/game.mjs', 'text/javascript; charset=utf-8'],
  '/shared/pet.mjs': ['shared/pet.mjs', 'text/javascript; charset=utf-8'],
  '/shared/pet-studio.mjs': ['shared/pet-studio.mjs', 'text/javascript; charset=utf-8'],
  '/shared/life.mjs': ['shared/life.mjs', 'text/javascript; charset=utf-8'],
  '/pet-editor.mjs': ['public/pet-editor.mjs', 'text/javascript; charset=utf-8'],
  '/pet-editor.css': ['public/pet-editor.css', 'text/css; charset=utf-8'],
  '/skill-editor.mjs': ['public/skill-editor.mjs', 'text/javascript; charset=utf-8'],
  '/skill-editor.css': ['public/skill-editor.css', 'text/css; charset=utf-8'],
  '/companion.mjs': ['public/companion.mjs', 'text/javascript; charset=utf-8'],
  '/companion.css': ['public/companion.css', 'text/css; charset=utf-8'],
  '/world-scene.mjs': ['public/world-scene.mjs', 'text/javascript; charset=utf-8'],
  '/world.css': ['public/world.css', 'text/css; charset=utf-8'],
  '/cloud.css': ['public/cloud.css', 'text/css; charset=utf-8'],
  '/pet-badge.svg': ['public/pet-badge.svg', 'image/svg+xml'],
};
async function body(req) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 32768) throw new ApiError(413, '请求过大');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new ApiError(400, '需要 JSON 对象'); }
}

export function createApp({ dataDir = resolve(root, 'data'), env = process.env, now = Date.now, brainOptions = {} } = {}) {
  const cookieName = env.COOKIE_NAME === undefined ? 'petrival' : env.COOKIE_NAME;
  if (typeof cookieName !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(cookieName)) throw new Error('COOKIE_NAME 需要 1–64 个字母、数字、下划线或连字符');
  const cookiePrefix = `${cookieName}=`;
  const jobs = new Jobs(2), brain = new PetBrain(jobs, env, brainOptions), store = new Store(dataDir), arena = new Arena(store, brain, { now });
  const boxing = new BoxingArena(arena, brain, { now });
  const buckets = new Map();
  const rate = (key, max) => {
    const n = now(); let b = buckets.get(key);
    if (!b || n - b.start > 60000) { b = { start: n, count: 0 }; buckets.set(key, b); }
    if (++b.count > max) throw new ApiError(429, '操作太频繁，请一分钟后再试');
  };
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && ['/boxing', '/boxing.html'].includes(path)) { res.writeHead(302, { Location: '/#boxing' }); res.end(); return; }
      if (req.method === 'GET' && files[path]) {
        const [file, type] = files[path];
        const content = await readFile(resolve(root, file));
        res.writeHead(200, { 'Content-Type': type }); res.end(content); return;
      }
      if (path === '/api/health' && req.method === 'GET') return json(200, { ok: true, game: 'PetRival', ...brain.info() });
      if (!path.startsWith('/api/')) throw new ApiError(404, '未找到页面');
      if (!['GET', 'POST'].includes(req.method)) throw new ApiError(405, '不支持此方法');
      const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookiePrefix))?.slice(cookiePrefix.length);
      const owner = arena.owner(cookie);
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, '需要 application/json');
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw new ApiError(403, '拒绝跨站请求');
        rate(`ip:${req.socket.remoteAddress}`, path.startsWith('/api/boxing') ? 1200 : 180);
      }
      if (path === '/api/session' && req.method === 'POST') {
        if (owner) return json(200, { ok: true });
        rate(`guest:${req.socket.remoteAddress}`, 15);
        const session = arena.session();
        const secure = env.COOKIE_SECURE === '1' ? '; Secure' : '';
        res.setHeader('Set-Cookie', `${cookiePrefix}${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`);
        return json(201, { ok: true });
      }
      if (!owner) throw new ApiError(401, '请先建立访客身份');
      if (path === '/api/state' && req.method === 'GET') return json(200, arena.view(owner));
      const input = req.method === 'POST' ? await body(req) : {};
      if (path === '/api/boxing' && req.method === 'GET') return json(200, boxing.view(owner));
      if (path === '/api/boxing' && req.method === 'POST') { rate(`boxing:${owner}`, 6); return json(201, boxing.create(owner, input.opponentId)); }
      const boxingRoute = path.match(/^\/api\/boxing\/([\w-]+)(?:\/(start|input|surrender))?$/);
      if (boxingRoute) {
        const [, id, action] = boxingRoute;
        if (!action && req.method === 'GET') return json(200, boxing.get(owner, id));
        if (req.method === 'POST' && action) { rate(`boxing-input:${owner}`, 600); return json(200, action === 'input' ? boxing.input(owner, id, input) : action === 'start' ? boxing.start(owner, id) : boxing.surrender(owner, id)); }
      }
      if (path === '/api/pets' && req.method === 'POST') { arena.createPet(owner, input); return json(201, arena.view(owner)); }
      if (path === '/api/pets/game' && req.method === 'POST') return json(200, arena.selectGame(owner, input));
      if (path === '/api/pets/skill/check' && req.method === 'POST') return json(200, arena.checkCompetitionSkill(owner, input));
      if (path === '/api/pets/skill' && req.method === 'POST') return json(200, arena.updateCompetitionSkill(owner, input));
      if (path === '/api/pets/chat' && req.method === 'GET') return json(200, arena.chatView(owner));
      if (path === '/api/pets/chat' && req.method === 'POST') {
        rate(`chat:${owner}`, 20);
        return json(200, await arena.chat(owner, input));
      }
      if (path === '/api/pets/appearance' && req.method === 'POST') {
        rate(`appearance:${owner}`, 20);
        arena.updateAppearance(owner, input); return json(200, arena.view(owner));
      }
      if (path === '/api/pets/prepare' && req.method === 'POST') {
        rate(`prepare:${owner}`, 2);
        const pet = arena.mine(owner); if (!pet) throw new ApiError(409, '请先领养宠物');
        arena.prepare(pet, input.intent); return json(202, arena.view(owner));
      }
      if (path === '/api/practice/agent' && req.method === 'POST') {
        rate(`practice:${owner}`, 2);
        return json(200, await arena.practice(owner));
      }
      if (path === '/api/practice/start' && req.method === 'POST') {
        rate(`practice:${owner}`, 2);
        return json(202, arena.startPractice(owner, input));
      }
      const practiceRoute = path.match(/^\/api\/practice\/([\w-]+)$/);
      if (practiceRoute && req.method === 'GET') return json(200, arena.getPractice(owner, practiceRoute[1]));
      if (path === '/api/challenges' && req.method === 'POST') {
        rate(`challenge:${owner}`, 6);
        return json(201, arena.challenge(owner, input.opponentId));
      }
      const route = path.match(/^\/api\/challenges\/([\w-]+)(?:\/(start|finish))?$/);
      if (route) {
        const [, id, action] = route;
        if (!action && req.method === 'GET') { arena.tick(); return json(200, arena.matchView(arena.matchFor(id, owner), owner)); }
        if (action === 'start' && req.method === 'POST') return json(200, arena.start(owner, id));
        if (action === 'finish' && req.method === 'POST') return json(200, arena.finish(owner, id, input));
      }
      throw new ApiError(404, '接口不存在');
    } catch (error) {
      if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : '服务暂时出错，未将异常当成挑战失败' });
      else res.end();
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  const timer = setInterval(() => {
    arena.tick();
    for (const [key, b] of buckets) if (now() - b.start > 120000) buckets.delete(key);
  }, 1000);
  timer.unref();
  arena.resume();
  return { server, arena, boxing, store, brain, jobs,
    async close() {
      clearInterval(timer); arena.closed = true; await boxing.close(); brain.close();
      await jobs.close(); await arena.idle();
      if (server.listening) await new Promise(r => { server.close(r); server.closeIdleConnections(); });
    },
  };
}
