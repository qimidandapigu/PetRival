// A ladder of small lessons, one skill each, so the pet is never dropped straight into a
// level it cannot finish. Every stage is a normal v2 level the shared validator and the
// bounded solver accept; test/jump-stages.test.mjs proves each one is solvable.
import { validateLevel, starterLevel } from './jump-world.mjs';

export const STAGES = Object.freeze([
  { id: 1, name: '先学会走', skill: '一直往右走：路上的金币、钥匙、机关都在同一条线上。', hint: '只要按 → 就能过关，没有坑。' },
  { id: 2, name: '学会跳', skill: '跳过一个小溪。', hint: '走到边上前一点起跳，按住跳跃键久一点跳得更远。' },
  { id: 3, name: '学会拿金币', skill: '收齐金币，其中一枚在矮台上，需要跳上去。', hint: '矮台只比地面高一点点，按跳跃就能上去。' },
  { id: 4, name: '学会取钥匙开门', skill: '钥匙在高台上，拿到它才能开门。', hint: '先跳上高台取钥匙，门自然就开了。' },
  { id: 5, name: '学会回头开机关', skill: '开关在钥匙左边，拿到钥匙后要往回走。', hint: '取完钥匙回头看，开关在左边。' },
  { id: 6, name: '高台上的钥匙', skill: '高台取钥匙、回头踩机关、跨溪、收齐金币。', hint: '你已经会全部动作了，这一关只是把它们连起来。' },
]);

export function validateStageId(value) {
  const id = Math.trunc(Number(value));
  if (!Number.isInteger(id) || id < 1 || id > STAGES.length) throw new Error(`关卡编号需要 1–${STAGES.length}`);
  return id;
}
export function stageInfo(id) { return STAGES[validateStageId(id) - 1]; }
export function stageLevel(id) {
  switch (validateStageId(id)) {
    // Everything sits on one flat line, so a pet that only knows "walk right" can finish.
    // Two touching platforms, because the shared validator requires at least two.
    case 1: return validateLevel({ version: 2, title: '第 1 关 · 先学会走', width: 900, spawn: { x: 48, y: 400 }, goal: { x: 820, y: 400 },
      platforms: [{ x: 0, y: 400, w: 450 }, { x: 450, y: 400, w: 450 }], coins: [{ x: 200, y: 388 }], key: { x: 360, y: 388 },
      switch: { x: 520, y: 388 }, door: { x: 640, y: 152, h: 248 } });
    // One 80px creek: walking off the edge drops you, so the jump itself is the lesson.
    case 2: return validateLevel({ version: 2, title: '第 2 关 · 学会跳', width: 940, spawn: { x: 48, y: 400 }, goal: { x: 860, y: 400 },
      platforms: [{ x: 0, y: 400, w: 420 }, { x: 500, y: 400, w: 440 }], coins: [{ x: 240, y: 388 }], key: { x: 620, y: 388 },
      switch: { x: 700, y: 388 }, door: { x: 760, y: 152, h: 248 } });
    // A coin that can only be reached by jumping up onto a low ledge.
    case 3: return validateLevel({ version: 2, title: '第 3 关 · 学会拿金币', width: 980, spawn: { x: 48, y: 400 }, goal: { x: 900, y: 400 },
      platforms: [{ x: 0, y: 400, w: 980 }, { x: 300, y: 336, w: 120 }], coins: [{ x: 360, y: 324 }, { x: 150, y: 388 }],
      key: { x: 640, y: 388 }, switch: { x: 720, y: 388 }, door: { x: 800, y: 152, h: 248 } });
    // The key sits two ledges up; the switch waits right underneath, so no backtracking yet.
    case 4: return validateLevel({ version: 2, title: '第 4 关 · 学会取钥匙开门', width: 1000, spawn: { x: 48, y: 400 }, goal: { x: 920, y: 400 },
      platforms: [{ x: 0, y: 400, w: 1000 }, { x: 240, y: 336, w: 120 }, { x: 360, y: 272, w: 140 }], coins: [{ x: 120, y: 388 }, { x: 430, y: 260 }],
      key: { x: 300, y: 324 }, switch: { x: 420, y: 388 }, door: { x: 820, y: 152, h: 248 } });
    // Same as stage 4 but the switch moves to the far left: the key forces a trip back.
    case 5: return validateLevel({ version: 2, title: '第 5 关 · 学会回头开机关', width: 1000, spawn: { x: 48, y: 400 }, goal: { x: 920, y: 400 },
      platforms: [{ x: 0, y: 400, w: 1000 }, { x: 620, y: 336, w: 120 }], coins: [{ x: 520, y: 388 }, { x: 700, y: 324 }],
      key: { x: 680, y: 324 }, switch: { x: 120, y: 388 }, door: { x: 820, y: 152, h: 248 } });
    default: return validateLevel({ ...starterLevel(), title: `第 6 关 · ${STAGES[5].name}` });
  }
}
export function nextStage(id) { const next = validateStageId(id) + 1; return next > STAGES.length ? null : next; }
// Either side clearing a stage unlocks the next one: the pet clearing it is the goal, but a
// human clear must never leave the player stuck on a stage the pet cannot finish yet.
export function unlockAfter(cleared, id) {
  const set = new Set((Array.isArray(cleared) ? cleared : []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= STAGES.length));
  set.add(validateStageId(id));
  return [...set].sort((a, b) => a - b);
}
export function stagePickerState(cleared, id) {
  const done = new Set((Array.isArray(cleared) ? cleared : []).map(Number));
  const current = validateStageId(id), highest = done.size ? Math.max(...done) : 0;
  return STAGES.map(stage => ({ ...stage, cleared: done.has(stage.id), locked: stage.id > Math.max(highest + 1, 1), current: stage.id === current }));
}
