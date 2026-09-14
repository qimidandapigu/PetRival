// Deterministic 60 Hz platform physics and example-based imitation. No model API.
export const PHYSICS = Object.freeze({ speed: 3.2, gravity: 0.55, jump: -12.2, size: 24, floor: 330 });
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
export function makeLevel(index = 0) {
  const plans = [
    { title: '第一课 · 跨过小溪', width: 1050, gaps: [[360, 432]], coins: [210, 570, 790] },
    { title: '换个位置 · 还会跳吗？', width: 1350, gaps: [[470, 542], [880, 952]], coins: [270, 680, 1120] },
    { title: '再教一次 · 更宽的小溪', width: 1530, gaps: [[380, 472], [970, 1082]], coins: [200, 700, 1280] },
  ];
  const p = plans[clamp(Math.trunc(index), 0, 2)] || plans[0];
  return { ...p, gaps: p.gaps.map(g => [...g]), coins: p.coins.map(x => ({ x, y: PHYSICS.floor - 12 })), switchX: p.width - 155, goalX: p.width - 65 };
}
export function actor(x = 80) { return { x, y: PHYSICS.floor, vx: 0, vy: 0, grounded: true, held: false, dead: false }; }
export function gapAhead(a, level) { return level.gaps.find(([start, end]) => a.x < end - 4) || null; }
export function onGround(x, level) { return !level.gaps.some(([s, e]) => x > s && x < e); }
export function stepActor(a, input, level) {
  if (a.dead) return;
  a.vx = clamp(Number(input.move) || 0, -1, 1) * PHYSICS.speed;
  if (input.jump && !a.held && a.grounded) { a.vy = PHYSICS.jump; a.grounded = false; }
  a.held = !!input.jump;
  if (!input.jump && a.vy < -4) a.vy = -4; // Let go for a shorter jump.
  const oldY = a.y;
  a.x = clamp(a.x + a.vx, 12, level.width - 12);
  if (a.grounded && !onGround(a.x, level)) a.grounded = false;
  if (!a.grounded) { a.vy += PHYSICS.gravity; a.y += a.vy; }
  if (a.vy >= 0 && oldY <= PHYSICS.floor && a.y >= PHYSICS.floor && onGround(a.x, level)) {
    a.y = PHYSICS.floor; a.vy = 0; a.grounded = true;
  }
  if (a.y > 490) a.dead = true;
}
export function freshProgress() { return { coins: [], switchOn: false, won: false }; }
export function touchObjects(a, role, level, progress) {
  // Human demonstrations cannot collect coins, switch mechanisms or finish for the pet.
  if (role !== 'pet' || a.dead) return;
  level.coins.forEach((coin, i) => {
    if (Math.abs(a.x - coin.x) < 25 && Math.abs(a.y - 12 - coin.y) < 30 && !progress.coins.includes(i)) progress.coins.push(i);
  });
  if (Math.abs(a.x - level.switchX) < 24 && a.grounded) progress.switchOn = true;
  if (a.x >= level.goalX && progress.switchOn && progress.coins.length === level.coins.length) progress.won = true;
}
export function checkpoint(a, level) {
  let x = 80;
  for (const [, end] of level.gaps) if (a.x >= end + 35 && a.grounded) x = end + 50;
  return x;
}

// A memory contains only successful, actually executed human jump clips. Each clip
// is indexed by local gap geometry and takeoff distance, not an absolute level X.
export class JumpMemory {
  constructor(data) {
    this.clips = []; this.demonstrations = 0;
    if (data?.version === 1 && Array.isArray(data.clips)) {
      this.clips = data.clips.filter(validClip).slice(-80).map(c => ({ ...c, actions: c.actions.map(a => ({ ...a })) }));
      this.demonstrations = this.clips.length;
    }
  }
  add(clip) {
    if (!validClip(clip)) return false;
    this.clips.push({ ...clip, actions: clip.actions.map(a => ({ ...a })) });
    this.clips = this.clips.slice(-80); this.demonstrations++;
    return true;
  }
  best(gap) {
    const width = gap[1] - gap[0];
    // Geometry must be similar. Wider unseen gaps ask for a fresh demonstration.
    return this.clips.map((clip, i) => ({ clip, score: Math.abs(clip.width - width) - i * 0.0001 }))
      .filter(c => Math.abs(c.clip.width - width) <= 12).sort((a, b) => a.score - b.score)[0]?.clip || null;
  }
  json() { return { version: 1, clips: this.clips }; }
}
function validClip(c) {
  return c && Number.isFinite(c.width) && c.width >= 24 && c.width <= 180 && Number.isFinite(c.distance) && c.distance >= 0 && c.distance <= 160 &&
    Array.isArray(c.actions) && c.actions.length >= 2 && c.actions.length <= 180 && c.actions[0]?.jump === true &&
    c.actions.every(a => a && [-1, 0, 1].includes(a.move) && typeof a.jump === 'boolean');
}
export class DemonstrationRecorder {
  constructor(memory) { this.memory = memory; this.pending = null; }
  before(a, input, level) {
    const gap = gapAhead(a, level);
    if (a.grounded && input.jump && !a.held && gap && gap[0] >= a.x && gap[0] - a.x <= 160) {
      this.pending = { gap, width: gap[1] - gap[0], distance: gap[0] - a.x, actions: [] };
    }
    if (this.pending) this.pending.actions.push({ move: clamp(input.move || 0, -1, 1), jump: !!input.jump });
  }
  after(a) {
    if (!this.pending) return false;
    if (a.dead || this.pending.actions.length > 180) { this.pending = null; return false; }
    if (a.grounded && this.pending.actions.length > 1) {
      const p = this.pending; this.pending = null;
      if (a.x >= p.gap[1]) return this.memory.add({ width: p.width, distance: p.distance, actions: p.actions });
    }
    return false;
  }
}
export class PetController {
  constructor(memory) { this.memory = memory; this.reset(); }
  reset() { this.clip = null; this.frame = 0; this.lastGap = null; this.mode = '初学走路'; }
  action(a, level) {
    if (this.clip) {
      const action = this.clip.actions[this.frame++];
      if (action) { this.mode = '试着用你教的跳法'; return action; }
      this.clip = null;
    }
    const gap = gapAhead(a, level);
    const example = gap && this.memory.best(gap);
    if (gap && example && a.grounded && this.lastGap !== gap[0] && a.x >= gap[0] - example.distance) {
      this.lastGap = gap[0]; this.clip = example; this.frame = 1; this.mode = '试着用你教的跳法';
      return example.actions[0];
    }
    this.mode = example ? '走向你示范过的小溪' : gap ? '这段还没学会，先试试看' : '去拿金币、打开终点';
    return { move: 1, jump: false }; // Only basic walking is built in; no innate jump solver.
  }
}
