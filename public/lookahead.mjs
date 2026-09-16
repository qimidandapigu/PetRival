// 推演层 / 播放层：这套系统的标准实时方案（横版跳跃、推箱子、打拳共用）。
//
// 问题：模型一次调用要几秒，游戏一帧只要 16 毫秒；串行做就会出现"等一等、动一动"。
// 方案：模型一给出动作，立刻用**引擎**把它推演到底（引擎毫秒级），推演完马上再问下一轮，
// 于是思考与推演始终跑在播放前面；播放层只把已经算完、已经核对过的胶片放出来。
//
// 本模块是纯函数 + 一个可测的缓冲，不依赖 DOM，也不依赖具体游戏。

// 缓冲水位：低于 low 就继续思考，高于 high 就停（省 token）。
export const WATER = Object.freeze({ high: 600, low: 180, maxFrames: 6000 });

export function createBuffer({ high = WATER.high, low = WATER.low, maxFrames = WATER.maxFrames } = {}) {
  let blocks = [], frames = 0, droppedFrames = 0, pushed = 0, dropped = 0;
  const recount = () => { frames = blocks.reduce((n, b) => n + Math.max(0, b.remaining), 0); };
  const buffer = {
    get frames() { return frames; },
    get seconds() { return Math.round(frames / 60 * 10) / 10; },
    get blocks() { return blocks.length; },
    get stats() { return { pushed, dropped, droppedFrames, frames, blocks: blocks.length }; },
    needsThink() { return frames <= low && frames < maxFrames; },
    // 已经算完的胶片：每块带推演出来的逐帧预期，播放时逐帧核对。
    push(next) {
      if (!next || !next.remaining) return false;
      if (frames + next.remaining > maxFrames) { dropped++; droppedFrames += next.remaining; return false; }
      blocks.push(next); pushed++; recount(); return true;
    },
    // 取下一帧：返回该帧要按的键，以及推演预期它应该变成什么样。
    next() {
      while (blocks.length && blocks[0].remaining <= 0) blocks.shift();
      if (!blocks.length) return null;
      const current = blocks[0];
      while (current.cursor < current.actions.length && current.actions[current.cursor].frames <= 0) current.cursor++;
      if (current.cursor >= current.actions.length) { blocks.shift(); return buffer.next(); }
      const action = current.actions[current.cursor], index = current.total - current.remaining;
      action.frames--; current.remaining--; recount();
      return { action, expected: current.perFrame[index] || null, block: current, done: current.remaining <= 0 };
    },
    // 剩下没播的全部作废（推演与实际不符、关卡变了、玩家接管）。
    drop(reason = '') {
      const lost = blocks.reduce((sum, b) => sum + Math.max(0, b.remaining), 0);
      blocks = []; recount();
      if (lost) { dropped++; droppedFrames += lost; }
      return { frames: lost, reason };
    },
    reset() { blocks = []; recount(); pushed = 0; dropped = 0; droppedFrames = 0; },
  };
  return buffer;
}

// 用引擎把一个动作块推到底：每一帧之后的预期状态、块结束时的状态与进度。
// `step` 必须是播放时用的同一份实现，这样推演和实际才会逐帧一致。
export function simulate(step, { level, actor, progress, actions, physics, role = 'pet' }) {
  const a = { ...actor }, p = { ...progress, coins: [...(progress?.coins || [])] };
  const perFrame = [];
  let frames = 0;
  for (const action of actions) {
    for (let i = 0; i < action.frames; i++) {
      step(a, action, level, p, role, physics);
      frames++;
      perFrame.push({ x: a.x, y: a.y, vy: a.vy, grounded: a.grounded === true, dead: a.dead === true,
        coins: p.coins.length, key: !!p.key, switchOn: !!p.switchOn, won: !!p.won });
      if (a.dead || p.won) break;
    }
    if (a.dead || p.won) break;
  }
  return { frames, perFrame, end: { actor: { ...a }, progress: { ...p, coins: [...p.coins] } }, dead: a.dead === true, won: !!p.won };
}
export function matches(expected, actual, tolerance = { x: .01, y: .01, vy: .01 }) {
  if (!expected) return true;
  return Math.abs(expected.x - actual.x) <= tolerance.x && Math.abs(expected.y - actual.y) <= tolerance.y
    && Math.abs(expected.vy - actual.vy) <= tolerance.vy && expected.grounded === (actual.grounded === true);
}
// 把推演结果包成播放层要的块。
export function toBlock(actions, simulated) {
  return { actions: actions.map(a => ({ ...a })), perFrame: simulated.perFrame, total: simulated.frames,
    remaining: simulated.frames, cursor: 0, end: simulated.end, dead: simulated.dead, won: simulated.won };
}
