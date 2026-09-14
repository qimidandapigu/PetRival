import { move, renderRows, stateKey, DIRECTIONS } from '../shared/game.mjs';


// Local rule observations only: no path search, solution proof or chosen move.
export function stepObservation(state, { turn, remainingMs, recent = [], visits = 1, canUndo = false, feedback = null }) {
  const w = state.width || 8, point = p => ({ x: p % w, y: Math.floor(p / w) });
  const legalMoves = Object.keys({ U: 0, D: 0, L: 0, R: 0 }).flatMap(action => {
    const result = move(state, action);
    if (!result.moved) return [];
    const pushedTo = result.pushed ? result.state.boxes.find(p => !state.boxes.includes(p)) : null;
    return [{ action, playerTo: point(result.state.player), ...(pushedTo === null ? {} : { boxTo: point(pushedTo), boxOnGoal: state.goals.includes(pushedTo) }) }];
  });
  const cornered = state.boxes.filter(b => !state.goals.includes(b) &&
    (state.walls.includes(b - 1) || state.walls.includes(b + 1)) &&
    (state.walls.includes(b - w) || state.walls.includes(b + w)));
  return { turn, remainingSeconds: Math.max(0, Math.ceil(remainingMs / 1000)),
    coordinates: 'x increases right, y increases down; top-left is (0,0)', rows: renderRows(state),
    player: point(state.player), boxes: state.boxes.map(p => ({ ...point(p), onGoal: state.goals.includes(p) })),
    goals: state.goals.map(point), legalMoves, canUndo, corneredBoxes: cornered.map(point),
    visitsToThisPosition: visits, recent, feedback };
}

export { stateKey };

// Walk-only pathfinding with boxes fixed. Enumerate available single pushes; never solve the puzzle.
function walkingPaths(state) {
  const w = state.width || 8, point = p => ({ x: p % w, y: Math.floor(p / w) });
  const paths = new Map([[state.player, '']]), queue = [state.player];
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index];
    for (const [action, [dx, dy]] of Object.entries(DIRECTIONS)) {
      const to = from + dx + dy * w;
      if (to < 0 || to >= w * w || Math.abs(to % w - from % w) > 1 || state.walls.includes(to) || state.boxes.includes(to) || paths.has(to)) continue;
      paths.set(to, paths.get(from) + action); queue.push(to);
    }
  }
  return paths;
}

// Walking inside one connected area leaves the same push decisions available.
export function pushPositionKey(state) {
  return `${[...state.boxes].sort((a, b) => a - b).join(',')}:${Math.min(...walkingPaths(state).keys())}`;
}

// Geometry of a single box on an otherwise empty board, not a multi-box solver.
// A reachable goal is only a possibility; an unreachable one proves a dead square.
function goalReachability(state) {
  const w = state.width || 8, point = p => ({ x: p % w, y: Math.floor(p / w) });
  return state.goals.map(goal => {
    const seen = new Set([goal]), queue = [goal];
    for (let n = 0; n < queue.length; n++) {
      for (const [dx, dy] of Object.values(DIRECTIONS)) {
        const previous = queue[n] - dx - dy * w, standing = previous - dx - dy * w;
        if ([previous, standing].some(p => p < 0 || p >= w * w || state.walls.includes(p)) ||
            Math.abs(previous % w - queue[n] % w) > 1 || Math.abs(standing % w - previous % w) > 1 || seen.has(previous)) continue;
        seen.add(previous); queue.push(previous);
      }
    }
    return seen;
  });
}

export function reachablePushes(state) {
  const w = state.width || 8, point = p => ({ x: p % w, y: Math.floor(p / w) });
  const paths = walkingPaths(state), reachable = goalReachability(state);
  return state.boxes.flatMap(box => Object.entries(DIRECTIONS).flatMap(([direction, [dx, dy]]) => {
    const delta = dx + dy * w, behind = box - delta, to = box + delta;
    if (!paths.has(behind) || state.walls.includes(to) || state.boxes.includes(to)) return [];
    const onGoal = state.goals.includes(to);
    const others = state.boxes.filter(p => p !== box);
    const assign = (i, used) => i === others.length || reachable.some((set, goal) => !used.has(goal) && set.has(others[i]) && assign(i + 1, new Set([...used, goal])));
    const goalOptions = reachable.flatMap((s, index) => s.has(to) ? [index] : []);
    const compatibleGoals = goalOptions.filter(index => assign(0, new Set([index])));
    const assignmentPossible = compatibleGoals.length > 0;
    return [{ id: `push-${box}-${direction}`, box: point(box), direction, boxTo: point(to),
      wasOnGoal: state.goals.includes(box), onGoal,
      reachableGoalsIgnoringOtherBox: goalOptions.map(i => point(state.goals[i])),
      compatibleGoalsForThisBox: compatibleGoals.map(i => point(state.goals[i])),
      deadlock: !assignmentPossible,
      ...(assignmentPossible ? {} : { warning: 'After this push the boxes cannot reach distinct goals even with the other box ignored. Undo or choose another push.' }),
      corner: !onGoal && (state.walls.includes(to - 1) || state.walls.includes(to + 1)) && (state.walls.includes(to - w) || state.walls.includes(to + w)),
      walkSteps: paths.get(behind).length, actions: paths.get(behind) + direction }];
  }));
}
