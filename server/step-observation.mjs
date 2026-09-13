import { move, renderRows, stateKey, DIRECTIONS } from '../shared/game.mjs';
const point = p => ({ x: p % 8, y: Math.floor(p / 8) });

// Local rule observations only: no path search, solution proof or chosen move.
export function stepObservation(state, { turn, remainingMs, recent = [], visits = 1, canUndo = false, feedback = null }) {
  const legalMoves = Object.keys({ U: 0, D: 0, L: 0, R: 0 }).flatMap(action => {
    const result = move(state, action);
    if (!result.moved) return [];
    const pushedTo = result.pushed ? result.state.boxes.find(p => !state.boxes.includes(p)) : null;
    return [{ action, playerTo: point(result.state.player), ...(pushedTo === null ? {} : { boxTo: point(pushedTo), boxOnGoal: state.goals.includes(pushedTo) }) }];
  });
  const cornered = state.boxes.filter(b => !state.goals.includes(b) &&
    (state.walls.includes(b - 1) || state.walls.includes(b + 1)) &&
    (state.walls.includes(b - 8) || state.walls.includes(b + 8)));
  return { turn, remainingSeconds: Math.max(0, Math.ceil(remainingMs / 1000)),
    coordinates: 'x increases right, y increases down; top-left is (0,0)', rows: renderRows(state),
    player: point(state.player), boxes: state.boxes.map(p => ({ ...point(p), onGoal: state.goals.includes(p) })),
    goals: state.goals.map(point), legalMoves, canUndo, corneredBoxes: cornered.map(point),
    visitsToThisPosition: visits, recent, feedback };
}

export { stateKey };

// Walk-only pathfinding with boxes fixed. Enumerate available single pushes; never solve the puzzle.
export function reachablePushes(state) {
  const paths = new Map([[state.player, '']]), queue = [state.player];
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index];
    for (const [action, [dx, dy]] of Object.entries(DIRECTIONS)) {
      const to = from + dx + dy * 8;
      if (to < 0 || to > 63 || Math.abs(to % 8 - from % 8) > 1 || state.walls.includes(to) || state.boxes.includes(to) || paths.has(to)) continue;
      paths.set(to, paths.get(from) + action); queue.push(to);
    }
  }
  return state.boxes.flatMap(box => Object.entries(DIRECTIONS).flatMap(([direction, [dx, dy]]) => {
    const delta = dx + dy * 8, behind = box - delta, to = box + delta;
    if (!paths.has(behind) || state.walls.includes(to) || state.boxes.includes(to)) return [];
    const onGoal = state.goals.includes(to);
    return [{ id: `push-${box}-${direction}`, box: point(box), direction, boxTo: point(to),
      wasOnGoal: state.goals.includes(box), onGoal,
      corner: !onGoal && (state.walls.includes(to - 1) || state.walls.includes(to + 1)) && (state.walls.includes(to - 8) || state.walls.includes(to + 8)),
      walkSteps: paths.get(behind).length, actions: paths.get(behind) + direction }];
  }));
}
