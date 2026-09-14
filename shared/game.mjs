export const DIRECTIONS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
export const RULES = Object.freeze({ clear: 100, fail: -20, limitMs: 180000, stepMs: 220, maxActions: 1500 });

export function parse(rows) {
  if (!Array.isArray(rows) || ![8, 9, 10].includes(rows.length) || rows.some(r => typeof r !== 'string' || r.length !== rows.length || /[^# .$@*+]/.test(r))) throw new Error('地图必须是 8×8、9×9 或 10×10，只能包含 # 空格 . $ @ * +');
  const width = rows.length, height = width;
  const walls = [], goals = [], boxes = [], players = [];
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    const p = y * width + x;
    if ((x === 0 || y === 0 || x === width - 1 || y === height - 1) && c !== '#') throw new Error('地图边缘必须封闭');
    if (c === '#') walls.push(p);
    if ('.$*+'.includes(c) && c !== '$') goals.push(p);
    if ('$*'.includes(c)) boxes.push(p);
    if ('@+'.includes(c)) players.push(p);
  }));
  if (boxes.length < 2 || boxes.length > 4 || goals.length !== boxes.length || players.length !== 1) throw new Error('需要 2–4 个箱子、相同数量的目标和一个玩家');
  return { width, height, walls, goals, boxes: boxes.sort((a, b) => a - b), player: players[0] };
}

export const won = s => s.boxes.every(b => s.goals.includes(b));
export const stateKey = s => `${s.player}:${s.boxes.join(',')}`;
export function move(state, action) {
  const width = state.width || 8, height = state.height || 8;
  const d = DIRECTIONS[action];
  if (!d) throw new Error('未知移动');
  const next = state.player + d[0] + d[1] * width;
  if (next < 0 || next >= width * height || Math.abs(next % width - state.player % width) > 1 || state.walls.includes(next)) return { state, moved: false, pushed: false };
  const box = state.boxes.indexOf(next);
  const boxes = [...state.boxes];
  if (box >= 0) {
    const beyond = next + d[0] + d[1] * width;
    if (beyond < 0 || beyond >= width * height || Math.abs(beyond % width - next % width) > 1 || state.walls.includes(beyond) || boxes.includes(beyond)) return { state, moved: false, pushed: false };
    boxes[box] = beyond;
    boxes.sort((a, b) => a - b);
  }
  return { state: { ...state, player: next, boxes }, moved: true, pushed: box >= 0 };
}

export function renderRows(s) {
  const width = s.width || 8, height = s.height || 8;
  return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => {
    const p = y * width + x;
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

// Walk regions collapse equivalent player positions; BFS edges are single pushes.
export function walkingPaths(s) {
  const w = s.width || 8, blocked = new Set([...s.walls, ...s.boxes]);
  const paths = new Map([[s.player, '']]), queue = [s.player];
  for (let n = 0; n < queue.length; n++) for (const [action, [dx,dy]] of Object.entries(DIRECTIONS)) {
    const to = queue[n] + dx + dy*w;
    if (to < 0 || to >= w*w || Math.abs(to%w-queue[n]%w)>1 || blocked.has(to) || paths.has(to)) continue;
    paths.set(to, paths.get(queue[n]) + action); queue.push(to);
  }
  return paths;
}
// Static reverse reachability plus a complete box/goal matching is a necessary condition only.
function goalGeometry(s) {
  const w = s.width, walls = new Set(s.walls);
  return s.goals.map(goal => {
    const seen = new Set([goal]), queue = [goal];
    for (let i=0;i<queue.length;i++) for (const [dx,dy] of Object.values(DIRECTIONS)) {
      const prev=queue[i]-dx-dy*w, stand=prev-dx-dy*w;
      if ([prev,stand].some(p=>p<0||p>=w*w||walls.has(p)) || Math.abs(prev%w-queue[i]%w)>1 || Math.abs(stand%w-prev%w)>1 || seen.has(prev)) continue;
      seen.add(prev);queue.push(prev);
    }
    return seen;
  });
}
function goalAssignment(boxes, geometry, i=0, mask=0) {
  return i === boxes.length || geometry.some((g,j) => !(mask & (1<<j)) && g.has(boxes[i]) && goalAssignment(boxes,geometry,i+1,mask|(1<<j)));
}
export function solve(rows, maxNodes = 70000) {
  const initial = parse(rows), w = initial.width, geometry = goalGeometry(initial);
  maxNodes = Math.max(1, Math.min(70000, Math.floor(maxNodes) || 1));
  if (won(initial)) return { solved: true, actions: '', pushes: 0, visited: 1 };
  const paths = walkingPaths(initial);
  const key = (s, p) => `${s.boxes.join(',')}:${Math.min(...p.keys())}`;
  const nodes = [{ state: initial, paths, parent: -1, action: '', pushes: 0 }];
  const seen = new Set([key(initial, paths)]);
  for (let head = 0; head < nodes.length; head++) {
    const node = nodes[head];
    for (const box of node.state.boxes) for (const [action, [dx, dy]] of Object.entries(DIRECTIONS)) {
      const behind = box - dx - dy * w;
      if (!node.paths.has(behind)) continue;
      const r = move({ ...node.state, player: behind }, action);
      if (!r.pushed || !goalAssignment(r.state.boxes, geometry)) continue;
      const nextPaths = walkingPaths(r.state), k = key(r.state, nextPaths);
      if (seen.has(k)) continue;
      if (nodes.length >= maxNodes) return { solved: false, actions: '', visited: nodes.length, reason: 'budget' };
      seen.add(k);
      const index = nodes.push({ state: r.state, paths: nextPaths, parent: head, action: node.paths.get(behind) + action, pushes: node.pushes + 1 }) - 1;
      if (won(r.state)) {
        let i = index, path = '';
        while (nodes[i].parent !== -1) { path = nodes[i].action + path; i = nodes[i].parent; }
        return { solved: true, actions: path, pushes: node.pushes + 1, visited: nodes.length };
      }
    }
    // Paths can be rebuilt but are no longer needed after this node expands.
    node.paths = null;
  }
  return { solved: false, actions: '', visited: nodes.length, reason: 'unsolvable' };
}

export function analyzeSolution(rows, actions) {
  let s = parse(rows), pushes = 0, switches = 0, offGoal = 0, lastBox = -1;
  const positions = [...s.boxes], moved = new Set();
  for (const action of actions) {
    const before = s, r = move(s, action); s = r.state;
    if (!r.pushed) continue;
    const id = positions.indexOf(s.player), to = s.boxes.find(b => !before.boxes.includes(b));
    if (lastBox !== -1 && lastBox !== id) switches++;
    if (before.goals.includes(s.player)) offGoal++;
    positions[id] = to; moved.add(id); lastBox = id; pushes++;
  }
  return { pushes, switches, offGoal, boxesMoved: moved.size, score: pushes + switches * 3 + offGoal * 5 };
}

export function random(seed) {
  let a = seed >>> 0;
  return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export function generationConfig(options = {}) {
  const size = options.size ?? 8, boxes = options.boxes ?? 2;
  if (![8, 9, 10].includes(size) || ![2, 3, 4].includes(boxes)) throw new Error('出题规格不合法');
  return { size, boxes, difficulty: options.difficulty === 'hard' ? 'hard' : 'normal' };
}
// Reverse legal pulls create candidates. Independent push-optimal search selects quality.
export function generate(seed = Date.now(), intent = '', options = {}) {
  const config = generationConfig(options), w = config.size;
  const hard = config.difficulty === 'hard' || /难|绕|hard/i.test(intent);
  const rng = random(seed), choose = a => a[Math.floor(rng() * a.length)];
  let best = null;
  for (let attempt = 0; attempt < (hard ? 40 : 16); attempt++) {
    const walls = [];
    for (let p = 0; p < w * w; p++) if (p < w || p >= w * (w - 1) || p % w === 0 || p % w === w - 1) walls.push(p);
    for (let n = 0; n < (hard ? w + Math.max(0, config.boxes - 2) * 4 : Math.floor(w / 2)); n++) {
      const p = (2 + Math.floor(rng() * (w - 4))) * w + 2 + Math.floor(rng() * (w - 4));
      if (!walls.includes(p)) walls.push(p);
    }
    const floor = Array.from({ length: w * w }, (_, p) => p).filter(p => !walls.includes(p));
    const goals = [];
    while (goals.length < config.boxes) { const p = choose(floor); if (!goals.includes(p)) goals.push(p); }
    let s = { width: w, height: w, walls, goals, boxes: [...goals].sort((a,b) => a-b), player: choose(floor.filter(p => !goals.includes(p))) };
    const seen = new Set();
    for (let n = 0; n < 70; n++) {
      const paths = walkingPaths(s), pulls = [];
      for (const box of s.boxes) for (const [dx,dy] of Object.values(DIRECTIONS)) {
        const delta = dx + dy * w, standing = box + delta, next = standing + delta;
        if (!paths.has(standing) || !paths.has(next)) continue;
        const boxes = s.boxes.map(b => b === box ? standing : b).sort((a,b) => a-b);
        const candidate = { ...s, boxes, player: next };
        if (!seen.has(stateKey(candidate))) pulls.push(candidate);
      }
      if (!pulls.length) break;
      s = choose(pulls); seen.add(stateKey(s));
    }
    if (s.boxes.some(b => goals.includes(b))) continue;
    const rows = renderRows(s), proof = solve(rows, config.boxes > 2 ? 5000 : 2000);
    if (!proof.solved || !proof.actions || proof.actions.length > 300) continue;
    const quality = analyzeSolution(rows, proof.actions);
    const eligible = quality.pushes >= config.boxes * 3 + 2, previousEligible = best && best.quality.pushes >= config.boxes * 3 + 2;
    if (!best || (hard && eligible && !previousEligible) || ((!hard || eligible === previousEligible) && quality.score > best.quality.score)) best = { rows, proof: proof.actions, quality, method: 'algorithm', seed, config };
  }
  if (best) return best;
  // Exact requested dimensions/count; explicitly marked starter, never claimed difficult.
  const cells = Array.from({ length:w }, (_,y) => Array.from({ length:w },(_,x) => !x || !y || x===w-1 || y===w-1 ? '#' : ' '));
  for(let i=0;i<config.boxes;i++){ cells[2][i+2]='.'; cells[3][i+2]='$'; }
  cells[w-2][1]='@';
  const rows=cells.map(r=>r.join('')), proof=solve(rows);
  return { rows, proof:proof.actions, quality:analyzeSolution(rows,proof.actions), method:'algorithm-starter', seed, config };
}

export function runScore(success, elapsedMs) {
  return { score: success ? RULES.clear : RULES.fail, rankMs: success ? Math.min(elapsedMs, RULES.limitMs) : RULES.limitMs };
}
export function compareTeams(a, b) { return b.score - a.score || a.rankMs - b.rankMs; }
