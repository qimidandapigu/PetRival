export const DIRECTIONS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
export const RULES = Object.freeze({ clear: 100, fail: -20, limitMs: 180000, stepMs: 220, maxActions: 1500 });

export function parse(rows) {
  if (!Array.isArray(rows) || rows.length !== 8 || rows.some(r => typeof r !== 'string' || r.length !== 8 || /[^# .$@*+]/.test(r))) throw new Error('地图必须是 8×8，只能包含 # 空格 . $ @ * +');
  const walls = [], goals = [], boxes = [], players = [];
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    const p = y * 8 + x;
    if ((x === 0 || y === 0 || x === 7 || y === 7) && c !== '#') throw new Error('地图边缘必须封闭');
    if (c === '#') walls.push(p);
    if ('.$*+'.includes(c) && c !== '$') goals.push(p);
    if ('$*'.includes(c)) boxes.push(p);
    if ('@+'.includes(c)) players.push(p);
  }));
  if (boxes.length !== 2 || goals.length !== 2 || players.length !== 1) throw new Error('需要两个箱子、两个目标和一个玩家');
  return { walls, goals, boxes: boxes.sort((a, b) => a - b), player: players[0] };
}

export const won = s => s.boxes.every(b => s.goals.includes(b));
export const stateKey = s => `${s.player}:${s.boxes.join(',')}`;
export function move(state, action) {
  const d = DIRECTIONS[action];
  if (!d) throw new Error('未知移动');
  const next = state.player + d[0] + d[1] * 8;
  if (next < 0 || next > 63 || Math.abs(next % 8 - state.player % 8) > 1 || state.walls.includes(next)) return { state, moved: false, pushed: false };
  const box = state.boxes.indexOf(next);
  const boxes = [...state.boxes];
  if (box >= 0) {
    const beyond = next + d[0] + d[1] * 8;
    if (beyond < 0 || beyond > 63 || Math.abs(beyond % 8 - next % 8) > 1 || state.walls.includes(beyond) || boxes.includes(beyond)) return { state, moved: false, pushed: false };
    boxes[box] = beyond;
    boxes.sort((a, b) => a - b);
  }
  return { state: { ...state, player: next, boxes }, moved: true, pushed: box >= 0 };
}

export function renderRows(s) {
  return Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => {
    const p = y * 8 + x;
    if (s.walls.includes(p)) return '#';
    if (p === s.player) return s.goals.includes(p) ? '+' : '@';
    if (s.boxes.includes(p)) return s.goals.includes(p) ? '*' : '$';
    return s.goals.includes(p) ? '.' : ' ';
  }).join(''));
}

export function replay(rows, actions) {
  if (typeof actions !== 'string' || actions.length > RULES.maxActions || /[^UDLRZX]/.test(actions)) throw new Error('操作记录不合法或过长');
  const initial = parse(rows);
  let state = initial, history = [], steps = 0, pushes = 0;
  for (const action of actions) {
    if (won(state)) throw new Error('通关后不能继续提交操作');
    if (action === 'X') { state = initial; history = []; continue; }
    if (action === 'Z') { if (history.length) state = history.pop(); continue; }
    const result = move(state, action);
    if (result.moved) { history.push(state); state = result.state; steps++; if (result.pushed) pushes++; }
  }
  return { state, steps, pushes, won: won(state) };
}

function deadlocked(s) {
  return s.boxes.some(b => !s.goals.includes(b) &&
    (s.walls.includes(b - 1) || s.walls.includes(b + 1)) &&
    (s.walls.includes(b - 8) || s.walls.includes(b + 8)));
}

// Bounded classical search. Used independently for validation and baseline agents.
export function solve(rows, maxNodes = 70000) {
  const initial = parse(rows);
  if (won(initial)) return { solved: true, actions: '', visited: 1 };
  const nodes = [{ state: initial, parent: -1, action: '' }];
  const seen = new Set([stateKey(initial)]);
  for (let head = 0; head < nodes.length && nodes.length < maxNodes; head++) {
    for (const action of Object.keys(DIRECTIONS)) {
      const result = move(nodes[head].state, action);
      if (!result.moved || deadlocked(result.state)) continue;
      const key = stateKey(result.state);
      if (seen.has(key)) continue;
      seen.add(key);
      const index = nodes.push({ state: result.state, parent: head, action }) - 1;
      if (won(result.state)) {
        let i = index, path = '';
        while (nodes[i].parent !== -1) { path = nodes[i].action + path; i = nodes[i].parent; }
        return { solved: true, actions: path, visited: nodes.length };
      }
    }
  }
  return { solved: false, actions: '', visited: nodes.length, reason: nodes.length >= maxNodes ? 'budget' : 'unsolvable' };
}

export function random(seed) {
  let a = seed >>> 0;
  return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// Reverse scrambling starts from a solved board; a separate forward solver verifies publication.
export function generate(seed = Date.now(), intent = '') {
  const rng = random(seed), choose = a => a[Math.floor(rng() * a.length)];
  const harder = /难|绕|hard/i.test(intent);
  for (let attempt = 0; attempt < 32; attempt++) {
    const walls = [];
    for (let p = 0; p < 64; p++) if (p < 8 || p >= 56 || p % 8 === 0 || p % 8 === 7) walls.push(p);
    for (let n = 0; n < (harder ? 5 : 3); n++) {
      const p = (2 + Math.floor(rng() * 4)) * 8 + 2 + Math.floor(rng() * 4);
      if (!walls.includes(p)) walls.push(p);
    }
    const floor = Array.from({ length: 64 }, (_, p) => p).filter(p => !walls.includes(p));
    const goals = [];
    while (goals.length < 2) { const p = choose(floor); if (!goals.includes(p)) goals.push(p); }
    let s = { walls, goals, boxes: [...goals].sort((a, b) => a - b), player: choose(floor.filter(p => !goals.includes(p))) };
    for (let n = 0; n < 350; n++) {
      const [dx, dy] = DIRECTIONS[choose(Object.keys(DIRECTIONS))], delta = dx + dy * 8;
      const next = s.player + delta, behind = s.player - delta;
      if (walls.includes(next) || s.boxes.includes(next)) continue;
      const boxes = [...s.boxes], bi = boxes.indexOf(behind);
      if (bi >= 0 && rng() < 0.85) boxes[bi] = s.player;
      s = { ...s, player: next, boxes: boxes.sort((a, b) => a - b) };
    }
    if (s.boxes.some(b => goals.includes(b))) continue;
    const rows = renderRows(s), proof = solve(rows);
    if (proof.solved && proof.actions.length >= (harder ? 15 : 7) && proof.actions.length <= 100) return { rows, proof: proof.actions, method: 'algorithm', seed };
  }
  // A known, independently replayed safe starter; never presented as a model result.
  const rows = ['########', '#      #', '# .  . #', '# $  $ #', '#      #', '#  @   #', '#      #', '########'];
  return { rows, proof: solve(rows).actions, method: 'algorithm-starter', seed };
}

export function runScore(success, elapsedMs) {
  return { score: success ? RULES.clear : RULES.fail, rankMs: success ? Math.min(elapsedMs, RULES.limitMs) : RULES.limitMs };
}
export function compareTeams(a, b) { return b.score - a.score || a.rankMs - b.rankMs; }
