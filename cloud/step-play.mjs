import { replay, RULES } from '../shared/game.mjs';
import { stepObservation, reachablePushes, stateKey } from '../server/step-observation.mjs';

// One durable job chooses one move/push. The arena animates it and queues the next
// decision from the actual board, so a Worker restart never loses the played prefix.
export async function decideStep(brain, job, signal) {
  const run = job.run, current = replay(job.rows, run.actions || '');
  const undo = replay(job.rows, (run.actions || '') + 'Z');
  const observation = stepObservation(current.state, {
    turn: (run._round || 0) + 1, remainingMs: run.deadline - Date.now(),
    recent: run._recent || [], visits: run._visits?.[stateKey(current.state)] || 1,
    canUndo: stateKey(undo.state) !== stateKey(current.state), feedback: run._feedback || null,
  });
  const choices = run.playStyle === 'push' ? reachablePushes(current.state) : null;
  if (choices) observation.availablePushes = choices.map(({ actions, ...choice }) => choice);
  let result;
  try {
    result = await brain.json([
      { role: 'system', content: choices
        ? 'Play Sokoban. Choose ONE push from availablePushes and return JSON {"choice":"push-id"}. A walking tool walks to the box, then pushes it one tile. You decide which box and direction; no tool solves the puzzle. Compare box and goal coordinates. Avoid corner=true and repeated loops. You may choose "undo" (last tile move) or "restart"; time continues. The engine decides success.'
        : 'Play Sokoban. Return JSON {"action":"U"} for ONE U/D/L/R move, Z undo, or X restart. Observe legalMoves, goals and recent outcomes. Avoid non-goal corners and loops. The engine decides success; the clock continues on undo/restart.' },
      { role: 'user', content: JSON.stringify(observation) },
    ], { signal, timeoutMs: Math.max(1, run.deadline - Date.now()), playEffort: 'none' });
  } catch (error) {
    if (Date.now() >= run.deadline) return { timedOut: true };
    if (error.name === 'SyntaxError' || /有效的 JSON/.test(error.message)) return { invalid: true };
    throw error;
  }
  const actions = choices ? result?.choice === 'undo' ? 'Z' : result?.choice === 'restart' ? 'X' : choices.find(c => c.id === result?.choice)?.actions : result?.action;
  if (typeof actions !== 'string' || !(choices ? /^[UDLRZX]+$/ : /^[UDLRZX]$/).test(actions)) return { invalid: true };
  return { actions: actions.slice(0, RULES.maxActions - (run.actions?.length || 0)) };
}
