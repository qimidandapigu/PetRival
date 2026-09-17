// Shared deterministic physics. Model controls the pet; search is generation QA only.
// `physics` is a parameter so a world can hide its own numbers from the model. PHYSICS
// stays the reference profile used by the built-in level and the level generator.
export const PHYSICS = Object.freeze({ speed: 3.2, gravity: .55, jump: -12.2, cut: -4, radius: 10, height: 24, fps: 60 });
const n = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export function validateLevel(raw) {
  const fail = text => { throw new Error(`关卡格式：${text}`); };
  if (!raw || raw.version !== 2 || !n(raw.width, 800, 1600)) fail('version=2，宽度 800–1600');
  const point = p => p && n(p.x, 16, raw.width - 16) && n(p.y, 80, 400);
  if (!Array.isArray(raw.platforms) || raw.platforms.length < 2 || raw.platforms.length > 14 || raw.platforms.some(p => !p || !n(p.x, 0, raw.width) || !n(p.y, 128, 400) || !n(p.w, 48, raw.width) || p.x + p.w > raw.width)) fail('平台需要合法 x/y/w，最多 14 个');
  if (!point(raw.spawn) || !point(raw.goal) || !point(raw.key) || !point(raw.switch)) fail('出生点、终点、钥匙和开关坐标无效');
  if (!Array.isArray(raw.coins) || raw.coins.length < 1 || raw.coins.length > 5 || raw.coins.some(p => !point(p))) fail('金币需要 1–5 个合法坐标');
  if (!raw.door || !point(raw.door) || !n(raw.door.h, 48, 320) || raw.door.y + raw.door.h > 420) fail('门需要 x/y/h');
  if (raw.coop !== undefined) {
    if (!raw.coop || !Array.isArray(raw.coop.plates) || raw.coop.plates.length !== 2 || raw.coop.plates.some(p => !point(p))) fail('配合关需要恰好两块合法坐标压力板');
    if (Math.abs(raw.coop.plates[0].x - raw.coop.plates[1].x) < 96) fail('两块压力板必须相距至少 96 像素，否则一个人能同时踩住');
  }
  const p = raw.platforms.find(p => Math.abs(p.y - raw.spawn.y) < .1 && raw.spawn.x >= p.x + 12 && raw.spawn.x <= p.x + p.w - 12);
  if (!p) fail('出生点必须在安全平台上');
  return { version: 2, title: String(raw.title || '小精灵的新冒险').slice(0, 40), width: raw.width,
    platforms: raw.platforms.map(({ x, y, w }) => ({ x, y, w })), coins: raw.coins.map(({ x, y }) => ({ x, y })),
    ...Object.fromEntries(['spawn', 'goal', 'key', 'switch'].map(k => [k, { x: raw[k].x, y: raw[k].y }])),
    door: { x: raw.door.x, y: raw.door.y, h: raw.door.h },
    ...(raw.coop ? { coop: { plates: raw.coop.plates.map(({ x, y }) => ({ x, y })) } } : {}) };
}
export function starterLevel() {
  return validateLevel({ version: 2, title: '高台上的钥匙', width: 1152, spawn: { x: 64, y: 400 }, goal: { x: 1088, y: 400 },
    platforms: [{ x: 0, y: 400, w: 560 }, { x: 624, y: 400, w: 528 }, { x: 128, y: 336, w: 112 }, { x: 272, y: 272, w: 128 }, { x: 432, y: 336, w: 80 }, { x: 720, y: 336, w: 96 }],
    coins: [{ x: 80, y: 388 }, { x: 368, y: 260 }, { x: 816, y: 388 }], key: { x: 320, y: 260 }, switch: { x: 176, y: 388 }, door: { x: 928, y: 144, h: 256 } });
}
export function actor(spawn) { return { x: spawn.x, y: spawn.y, vx: 0, vy: 0, grounded: true, held: false, dead: false }; }
export function progress() { return { coins: [], key: false, switchOn: false, won: false }; }
export function copyProgress(p) { return { coins: [...p.coins], key: !!p.key, switchOn: !!p.switchOn, won: !!p.won }; }
// Co-op levels (level.coop): pickups live in a shared `world` object both sides write to; the
// door latches open only while BOTH pressure plates are occupied at the same moment (one actor
// can never do that alone); each side wins individually by reaching the goal afterwards.
export function worldProgress() { return { coins: [], key: false, switchOn: false }; }
export function copyWorld(w) { return { coins: [...w.coins], key: !!w.key, switchOn: !!w.switchOn }; }
export function latchPlates(level, world, ...actors) {
  if (!level.coop || world.switchOn) return false;
  const on = plate => actors.some(a => a && !a.dead && !a.won && Math.abs(a.x - plate.x) < 22 && Math.abs(a.y - 12 - plate.y) < 26);
  if (level.coop.plates.every(on)) return world.switchOn = true;
  return false;
}
// Both players run the same rules on their own progress object: whoever you pass as `p`
// collects the coins, carries the key, opens the door and can win. The page keeps one
// progress object per side, so the human and the pet no longer share a score.
export function step(a, input, level, p, role = 'pet', physics = PHYSICS, world = null) {
  if (a.dead || p.won) return;
  const oldX = a.x, oldY = a.y;
  a.vx = [-1, 0, 1].includes(input.move) ? input.move * physics.speed : 0;
  if (input.jump && !a.held && a.grounded) { a.vy = physics.jump; a.grounded = false; }
  a.held = !!input.jump;
  if (!input.jump && a.vy < physics.cut) a.vy = physics.cut;
  a.x = Math.max(12, Math.min(level.width - 12, a.x + a.vx));
  const d = level.door, doorOpen = world ? world.switchOn : p.switchOn;
  if (!doorOpen && a.y > d.y && a.y - physics.height < d.y + d.h && Math.abs(a.x - d.x) < 14) a.x = oldX < d.x ? d.x - 14 : d.x + 14;
  if (a.grounded && !level.platforms.some(s => Math.abs(s.y - a.y) < .1 && a.x >= s.x && a.x <= s.x + s.w)) a.grounded = false;
  if (!a.grounded) { a.vy += physics.gravity; a.y += a.vy; }
  if (a.vy >= 0) {
    const surfaces = level.platforms.filter(s => a.x >= s.x && a.x <= s.x + s.w && oldY <= s.y + .01 && a.y >= s.y).sort((a, b) => a.y - b.y);
    if (surfaces.length) { a.y = surfaces[0].y; a.vy = 0; a.grounded = true; }
  }
  if (a.y > 470) a.dead = true;
  touch(a, role, level, p, world);
}
export function touch(a, role, level, p, world = null) {
  if (a.dead || p.won) return;
  const near = o => Math.abs(a.x - o.x) < 22 && Math.abs(a.y - 12 - o.y) < 26;
  const bag = world || p;
  level.coins.forEach((o, i) => { if (!bag.coins.includes(i) && near(o)) bag.coins.push(i); });
  if (near(level.key)) bag.key = true;
  // Co-op doors are latched by the two pressure plates (latchPlates), not by the floor switch.
  if (!world && bag.key && near(level.switch) && a.grounded) bag.switchOn = true;
  if (bag.key && bag.switchOn && bag.coins.length === level.coins.length && Math.abs(a.x - level.goal.x) < 24 && Math.abs(a.y - level.goal.y) < 28) p.won = true;
}
// Every interactable object is one declarative row: a region, the preconditions for its
// effect, and what the effect is. Attribution is then ONE generic rule — "the actor entered
// the region but the effect did not fire; list the missing preconditions" — instead of a
// hand-written event per object type. New mechanics become new rows, not new event code.
export function interactables(level) {
  const items = level.coins.map((c, i) => ({
    id: `coin-${i}`, label: `金币@x=${Math.round(c.x)}`, effect: '吃到金币',
    hint: '金币要身体碰到才算，从它上方跳过吃不到',
    inside: a => Math.abs(a.x - c.x) < 22 && Math.abs(a.y - 12 - c.y) < 26,
    near: a => !a.grounded && Math.abs(a.x - c.x) < 20 && (a.y - 12) < c.y - 14 && (a.y - 12) > c.y - 96,
    done: bag => bag.coins.includes(i), needs: () => [],
  }));
  if (level.coop) {
    for (const [i, plate] of level.coop.plates.entries()) items.push({
      id: `plate-${i}`, label: `压力板@x=${Math.round(plate.x)}`, effect: '开门',
      hint: '门只有在两块压力板被同时踩住的那一刻才永久打开，一块踩住不够',
      inside: a => Math.abs(a.x - plate.x) < 22 && Math.abs(a.y - 12 - plate.y) < 26,
      near: a => !a.grounded && Math.abs(a.x - plate.x) < 20 && (a.y - 12) < plate.y - 14 && (a.y - 12) > plate.y - 96,
      done: () => false, needs: () => [],
    });
  } else {
    items.push({
      id: 'switch', label: `机关@x=${Math.round(level.switch.x)}`, effect: '踩开机关（门才会开）',
      hint: '机关要带着钥匙、落在上面的地面上才踩得开，从上方飞过不算',
      inside: a => Math.abs(a.x - level.switch.x) < 22 && Math.abs(a.y - 12 - level.switch.y) < 26,
      near: a => !a.grounded && Math.abs(a.x - level.switch.x) < 20 && (a.y - 12) < level.switch.y - 14 && (a.y - 12) > level.switch.y - 96,
      done: bag => bag.switchOn, needs: bag => bag.key ? [] : ['先取得钥匙'],
    });
    items.push({
      id: 'door', label: `关着的门@x=${Math.round(level.door.x)}`, effect: '通过',
      hint: '被门挡住是机关没开的问题，不是跳的问题——回头踩机关',
      inside: () => false,
      near: () => false,
      done: bag => bag.switchOn, needs: () => ['先踩开机关'],
      blocked: (a, ctx) => ctx.move !== 0 && Math.abs(a.x - ctx.prevX) < 1 && Math.abs(a.x - level.door.x) < 20,
    });
  }
  items.push({
    id: 'goal', label: `终点@x=${Math.round(level.goal.x)}`, effect: '通关',
    hint: '',
    inside: a => Math.abs(a.x - level.goal.x) < 24 && Math.abs(a.y - level.goal.y) < 28,
    near: () => false,
    done: (bag, a, p) => p.won === true,
    needs: bag => [
      ...(bag.key ? [] : ['取得钥匙']),
      ...(bag.switchOn ? [] : [level.coop ? '两块压力板同时踩住开门' : '踩开机关']),
      ...(bag.coins.length >= level.coins.length ? [] : [`吃齐金币（还差 ${level.coins.length - bag.coins.length} 枚）`]),
    ],
  });
  return items;
}
// Generic near-miss attribution: for every interactable whose effect has NOT fired,
// explain why when the actor is inside its region (missing preconditions) or passing by
// without triggering it (near-miss). ctx = { prevX, move } for blocked-movement detection.
// Returns [{ id, msg }] — the caller dedupes per attempt by id.
export function attributeAttempt(a, level, bag, p, ctx = {}) {
  const out = [];
  for (const it of interactables(level)) {
    if (it.done(bag, a, p)) continue;
    const missing = it.needs(bag);
    if (it.blocked ? it.blocked(a, ctx) : it.inside(a)) {
      // Inside the region with all preconditions met means the effect fires this very
      // frame — that is a success in progress, not a near-miss. Only unmet preconditions
      // are worth an event.
      if (missing.length) out.push({ id: it.id, msg: `到了${it.label}但没能${it.effect}：还缺 ${missing.join('、')}` });
    } else if (it.near(a)) {
      out.push({ id: it.id, msg: `从${it.label}附近经过但${it.effect}没发生（${it.hint}）` });
    }
  }
  return out;
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
export function replayActions(level, start, initial, actions, role = 'pet', physics = PHYSICS, world = null, bystander = null) {
  const a = { ...start }, p = copyProgress(initial), w = world ? copyWorld(world) : null;
  for (const action of actions) for (let i = 0; i < action.frames && !a.dead && !p.won; i++) {
    step(a, action, level, p, role, physics, w);
    if (w) latchPlates(level, w, a, bystander);
  }
  return { actor: a, progress: p, ...(w ? { world: w } : {}) };
}
export function observation(level, a, p) {
  return { level, actor: { x: +a.x.toFixed(1), y: +a.y.toFixed(1), vx: a.vx, vy: +a.vy.toFixed(2), grounded: a.grounded, held: a.held },
    progress: copyProgress(p), physics: PHYSICS };
}

// Bounded search over executed walking/jumping edges. A witness is always replayed
// by the same physics. Failure to find a witness means unverified, not impossible.
export function verifyLevel(level, { maxNodes = 9000, physics = PHYSICS } = {}) {
  const initial = { a: actor(level.spawn), p: progress(), cost: 0, parent: null, action: null };
  const heap = [], seen = new Map(); let visited = 0;
  const score = s => {
    const target = !s.p.key ? level.key : !s.p.switchOn ? level.switch : level.coins.find((_, i) => !s.p.coins.includes(i)) || { x: level.goal.x, y: level.goal.y - 12 };
    return s.cost * .12 + Math.abs(s.a.x - target.x) / physics.speed + Math.abs(s.a.y - 12 - target.y) * .5;
  };
  const push = s => { const id = key(s); if ((seen.get(id) ?? Infinity) <= s.cost) return; seen.set(id, s.cost); s.priority = score(s); heap.push(s); let i = heap.length - 1; while (i > 0) { const j = (i - 1) >> 1; if (heap[j].priority <= s.priority) break; heap[i] = heap[j]; i = j; } heap[i] = s; };
  const pop = () => { const s = heap[0], end = heap.pop(); if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let j = i * 2 + 1; if (j + 1 < heap.length && heap[j + 1].priority < heap[j].priority) j++; if (end.priority <= heap[j].priority) break; heap[i] = heap[j]; i = j; } heap[i] = end; } return s; };
  const key = s => `${Math.round(s.a.x / 8)},${s.a.y},${s.p.key ? 1 : 0}${s.p.switchOn ? 1 : 0},${s.p.coins.reduce((v, i) => v | 1 << i, 0)}`;
  push(initial);
  while (heap.length && visited++ < maxNodes) {
    const s = pop(), id = key(s); if (seen.get(id) < s.cost) continue;
    if (s.p.won) {
      const actions = []; for (let n = s; n.parent; n = n.parent) actions.push(...[...n.action].reverse()); actions.reverse();
      const check = replayActions(level, initial.a, initial.p, actions, 'pet', physics);
      return { verified: check.progress.won, visited, frames: s.cost, actions };
    }
    for (const move of [-1, 1]) for (const hold of [0, 8, 20, 48]) {
      const a = { ...s.a }, p = copyProgress(s.p), actions = []; let frames = 0;
      if (hold && a.held) { const release = { move: 0, jump: false, frames: 1 }; step(a, release, level, p, 'pet', physics); actions.push(release); frames++; }
      for (let i = 0; i < (hold ? 95 : 5); i++) {
        const input = { move, jump: i < hold };
        step(a, input, level, p, 'pet', physics); frames++;
        const last = actions.at(-1); if (last && last.jump === input.jump) last.frames++; else actions.push({ ...input, frames: 1 });
        if (a.dead || p.won || (hold && i > 0 && a.grounded)) break;
      }
      if (!a.dead && a.grounded) push({ a, p, cost: s.cost + frames, parent: s, action: actions });
    }
  }
  return { verified: false, visited, reason: '有界物理搜索未找到完整通关路线，请缩短跳跃距离、降低平台或调整钥匙/开关/门的连接。' };
}

// A screen, not a blueprint: the level as a character grid the model can read line by line,
// the way a player sees it. One cell is TILE pixels, row 0 is the top of the world.
export const TILE = 16;
export const TILE_LEGEND = '# 地面或平台 · 空格=空气 · ~ 水（掉下去会死） · c 金币 · k 钥匙 · s 机关 · D 关着的门 · d 开着的门 · G 终点 · @ 你自己';
export function tileMap(level, a, p = { coins: [], key: false, switchOn: false }, { water = 430, rows = 30, partner = null } = {}) {
  const cols = Math.ceil(level.width / TILE);
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
  const put = (x, y, ch) => {
    const col = Math.floor(x / TILE), row = Math.floor(y / TILE);
    if (row >= 0 && row < rows && col >= 0 && col < cols) grid[row][col] = ch;
  };
  const fill = (x, y, w, h, ch) => {
    for (let yy = y; yy < y + h; yy += TILE) for (let xx = x; xx < x + w; xx += TILE) put(xx + 1, yy + 1, ch);
  };
  // Ground runs to the bottom of the screen; higher ledges are thin, the way they look.
  for (const plat of level.platforms) fill(plat.x, plat.y, plat.w, plat.y >= 400 ? rows * TILE - plat.y : 24, '#');
  for (let row = Math.floor(water / TILE); row < rows; row++)
    for (let col = 0; col < cols; col++) if (grid[row][col] === ' ') grid[row][col] = '~';
  level.coins.forEach((coin, i) => { if (!(p.coins || []).includes(i)) put(coin.x, coin.y, 'c'); });
  if (!p.key) put(level.key.x, level.key.y, 'k');
  if (level.coop) level.coop.plates.forEach(plate => put(plate.x, plate.y, 'P'));
  else put(level.switch.x, level.switch.y, 's');
  fill(level.door.x, level.door.y, 16, level.door.h, p.switchOn ? 'd' : 'D');
  put(level.goal.x, level.goal.y - TILE, 'G');
  if (partner && !partner.dead) put(partner.x, partner.y - TILE, 'H');
  if (a && !a.dead) put(a.x, a.y - TILE, '@');
  const legend = level.coop
    ? '# 地面或平台 · 空格=空气 · ~ 水（掉下去会死） · c 金币 · k 钥匙 · P 压力板 · D 关着的门 · d 开着的门 · G 终点 · @ 你自己 · H 主人'
    : TILE_LEGEND;
  return { legend, tile: TILE, rows: grid.map(row => row.join('').replace(/\s+$/, '')) };
}
