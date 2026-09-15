// Shared deterministic physics. Model controls the pet; search is generation QA only.
export const PHYSICS = Object.freeze({ speed: 3.2, gravity: .55, jump: -12.2, radius: 10, height: 24, fps: 60 });
const n = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export function validateLevel(raw) {
  const fail = text => { throw new Error(`关卡格式：${text}`); };
  if (!raw || raw.version !== 2 || !n(raw.width, 800, 1600)) fail('version=2，宽度 800–1600');
  const point = p => p && n(p.x, 16, raw.width - 16) && n(p.y, 80, 400);
  if (!Array.isArray(raw.platforms) || raw.platforms.length < 2 || raw.platforms.length > 14 || raw.platforms.some(p => !p || !n(p.x, 0, raw.width) || !n(p.y, 128, 400) || !n(p.w, 48, raw.width) || p.x + p.w > raw.width)) fail('平台需要合法 x/y/w，最多 14 个');
  if (!point(raw.spawn) || !point(raw.goal) || !point(raw.key) || !point(raw.switch)) fail('出生点、终点、钥匙和开关坐标无效');
  if (!Array.isArray(raw.coins) || raw.coins.length < 1 || raw.coins.length > 5 || raw.coins.some(p => !point(p))) fail('金币需要 1–5 个合法坐标');
  if (!raw.door || !point(raw.door) || !n(raw.door.h, 48, 320) || raw.door.y + raw.door.h > 420) fail('门需要 x/y/h');
  const p = raw.platforms.find(p => Math.abs(p.y - raw.spawn.y) < .1 && raw.spawn.x >= p.x + 12 && raw.spawn.x <= p.x + p.w - 12);
  if (!p) fail('出生点必须在安全平台上');
  return { version: 2, title: String(raw.title || '小精灵的新冒险').slice(0, 40), width: raw.width,
    platforms: raw.platforms.map(({ x, y, w }) => ({ x, y, w })), coins: raw.coins.map(({ x, y }) => ({ x, y })),
    ...Object.fromEntries(['spawn', 'goal', 'key', 'switch'].map(k => [k, { x: raw[k].x, y: raw[k].y }])),
    door: { x: raw.door.x, y: raw.door.y, h: raw.door.h } };
}
export function starterLevel() {
  return validateLevel({ version: 2, title: '高台上的钥匙', width: 1152, spawn: { x: 64, y: 400 }, goal: { x: 1088, y: 400 },
    platforms: [{ x: 0, y: 400, w: 560 }, { x: 624, y: 400, w: 528 }, { x: 128, y: 336, w: 112 }, { x: 272, y: 272, w: 128 }, { x: 432, y: 336, w: 80 }, { x: 720, y: 336, w: 96 }],
    coins: [{ x: 80, y: 388 }, { x: 368, y: 260 }, { x: 816, y: 388 }], key: { x: 320, y: 260 }, switch: { x: 176, y: 388 }, door: { x: 928, y: 144, h: 256 } });
}
export function actor(spawn) { return { x: spawn.x, y: spawn.y, vx: 0, vy: 0, grounded: true, held: false, dead: false }; }
export function progress() { return { coins: [], key: false, switchOn: false, won: false }; }
export function copyProgress(p) { return { coins: [...p.coins], key: !!p.key, switchOn: !!p.switchOn, won: !!p.won }; }
export function step(a, input, level, p, role = 'pet') {
  if (a.dead || (role === 'pet' && p.won)) return;
  const oldX = a.x, oldY = a.y;
  a.vx = [-1, 0, 1].includes(input.move) ? input.move * PHYSICS.speed : 0;
  if (input.jump && !a.held && a.grounded) { a.vy = PHYSICS.jump; a.grounded = false; }
  a.held = !!input.jump;
  if (!input.jump && a.vy < -4) a.vy = -4;
  a.x = Math.max(12, Math.min(level.width - 12, a.x + a.vx));
  const d = level.door;
  if (role === 'pet' && !p.switchOn && a.y > d.y && a.y - PHYSICS.height < d.y + d.h && Math.abs(a.x - d.x) < 14) a.x = oldX < d.x ? d.x - 14 : d.x + 14;
  if (a.grounded && !level.platforms.some(s => Math.abs(s.y - a.y) < .1 && a.x >= s.x && a.x <= s.x + s.w)) a.grounded = false;
  if (!a.grounded) { a.vy += PHYSICS.gravity; a.y += a.vy; }
  if (a.vy >= 0) {
    const surfaces = level.platforms.filter(s => a.x >= s.x && a.x <= s.x + s.w && oldY <= s.y + .01 && a.y >= s.y).sort((a, b) => a.y - b.y);
    if (surfaces.length) { a.y = surfaces[0].y; a.vy = 0; a.grounded = true; }
  }
  if (a.y > 470) a.dead = true;
  touch(a, role, level, p);
}
export function touch(a, role, level, p) {
  if (role !== 'pet' || a.dead) return;
  const near = o => Math.abs(a.x - o.x) < 22 && Math.abs(a.y - 12 - o.y) < 26;
  level.coins.forEach((o, i) => { if (!p.coins.includes(i) && near(o)) p.coins.push(i); });
  if (near(level.key)) p.key = true;
  if (p.key && near(level.switch) && a.grounded) p.switchOn = true;
  if (p.key && p.switchOn && p.coins.length === level.coins.length && Math.abs(a.x - level.goal.x) < 24 && Math.abs(a.y - level.goal.y) < 28) p.won = true;
}
export function validateActions(raw, maxFrames = 240) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 12) throw new Error('动作应为 1–12 段');
  let total = 0;
  const actions = raw.map(a => {
    if (!a || ![-1, 0, 1].includes(a.move) || typeof a.jump !== 'boolean' || !Number.isInteger(a.frames) || a.frames < 1 || a.frames > 90) throw new Error('动作需要 move=-1/0/1、jump=true/false、frames=1–90');
    total += a.frames; return { move: a.move, jump: a.jump, frames: a.frames };
  });
  if (total > maxFrames) throw new Error(`动作总长度超过 ${maxFrames} 帧`);
  return actions;
}
export function replayActions(level, start, initial, actions, role = 'pet') {
  const a = { ...start }, p = copyProgress(initial);
  for (const action of actions) for (let i = 0; i < action.frames && !a.dead && !p.won; i++) step(a, action, level, p, role);
  return { actor: a, progress: p };
}
export function observation(level, a, p) {
  return { level, actor: { x: +a.x.toFixed(1), y: +a.y.toFixed(1), vx: a.vx, vy: +a.vy.toFixed(2), grounded: a.grounded, held: a.held },
    progress: copyProgress(p), physics: PHYSICS };
}

// Bounded search over executed walking/jumping edges. A witness is always replayed
// by the same physics. Failure to find a witness means unverified, not impossible.
export function verifyLevel(level, { maxNodes = 9000 } = {}) {
  const initial = { a: actor(level.spawn), p: progress(), cost: 0, parent: null, action: null };
  const heap = [], seen = new Map(); let visited = 0;
  const score = s => {
    const target = !s.p.key ? level.key : !s.p.switchOn ? level.switch : level.coins.find((_, i) => !s.p.coins.includes(i)) || { x: level.goal.x, y: level.goal.y - 12 };
    return s.cost * .12 + Math.abs(s.a.x - target.x) / 3.2 + Math.abs(s.a.y - 12 - target.y) * .5;
  };
  const push = s => { const id = key(s); if ((seen.get(id) ?? Infinity) <= s.cost) return; seen.set(id, s.cost); s.priority = score(s); heap.push(s); let i = heap.length - 1; while (i > 0) { const j = (i - 1) >> 1; if (heap[j].priority <= s.priority) break; heap[i] = heap[j]; i = j; } heap[i] = s; };
  const pop = () => { const s = heap[0], end = heap.pop(); if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let j = i * 2 + 1; if (j + 1 < heap.length && heap[j + 1].priority < heap[j].priority) j++; if (end.priority <= heap[j].priority) break; heap[i] = heap[j]; i = j; } heap[i] = end; } return s; };
  const key = s => `${Math.round(s.a.x / 8)},${s.a.y},${s.p.key ? 1 : 0}${s.p.switchOn ? 1 : 0},${s.p.coins.reduce((v, i) => v | 1 << i, 0)}`;
  push(initial);
  while (heap.length && visited++ < maxNodes) {
    const s = pop(), id = key(s); if (seen.get(id) < s.cost) continue;
    if (s.p.won) {
      const actions = []; for (let n = s; n.parent; n = n.parent) actions.push(...[...n.action].reverse()); actions.reverse();
      const check = replayActions(level, initial.a, initial.p, actions);
      return { verified: check.progress.won, visited, frames: s.cost, actions };
    }
    for (const move of [-1, 1]) for (const hold of [0, 8, 20, 48]) {
      const a = { ...s.a }, p = copyProgress(s.p), actions = []; let frames = 0;
      if (hold && a.held) { const release = { move: 0, jump: false, frames: 1 }; step(a, release, level, p); actions.push(release); frames++; }
      for (let i = 0; i < (hold ? 95 : 5); i++) {
        const input = { move, jump: i < hold };
        step(a, input, level, p); frames++;
        const last = actions.at(-1); if (last && last.jump === input.jump) last.frames++; else actions.push({ ...input, frames: 1 });
        if (a.dead || p.won || (hold && i > 0 && a.grounded)) break;
      }
      if (!a.dead && a.grounded) push({ a, p, cost: s.cost + frames, parent: s, action: actions });
    }
  }
  return { verified: false, visited, reason: '有界物理搜索未找到完整通关路线，请缩短跳跃距离、降低平台或调整钥匙/开关/门的连接。' };
}
