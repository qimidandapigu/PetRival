import { replay, RULES, solve, renderRows } from '../shared/game.mjs';
import { stepObservation, reachablePushes, stateKey, pushPositionKey } from '../server/step-observation.mjs';
import { chooseWithPreview, advanceStage } from '../server/push-preview.mjs';
import { skillDecision } from '../server/competition-skill.mjs';

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
  const position = pushPositionKey(current.state), pushVisits = new Map(Object.entries(run._pushVisits || { [position]: 1 }));
  if (choices) {
    observation.availablePushes = choices.map(({ actions, ...choice }) => ({ ...choice, triedFromThisPosition: run._tried?.[`${position}/${choice.id}`] || 0, returnsToVisitedPosition: pushVisits.get(pushPositionKey(replay(renderRows(current.state), actions).state)) || 0 }));
    observation.recentDecisions = run._decisions || [];
    observation.remainingGoals = current.state.goals.filter(p => !current.state.boxes.includes(p)).map(p => ({ x: p % 8, y: Math.floor(p / 8) }));
    observation.canUndo = !!run._undo?.length;
    observation.undoMeaning = 'Undo the entire last push and its walking approach; time and memory are retained.';
    observation.assignmentGuidance = 'Boxes need distinct goals. Compatible goals account for the other box needing a different goal. Geometry warnings are not a solution.';
  }
  let result;
  const decision = skillDecision(run._skill, observation);
  if (decision.choice !== null) result = { choice: decision.choice };
  else if (brain.mode === 'algorithm') {
    const solved = solve(renderRows(current.state), 50000);
    result = { choice: choices?.find(c => solved.actions?.startsWith(c.actions))?.id };
  }
  if (!result) {
  try {
    const pending = run._continuation?.[0], cached = choices?.find(c => c.id === pending?.choice);
    if (run.pushPolicy === 'preview' && cached && !cached.deadlock && pending.beforeKey === stateKey(current.state) && pending.afterKey === stateKey(replay(renderRows(current.state), cached.actions).state)) {
      result = { choice: cached.id, stage: run._stage, continuation: run._continuation.slice(1) };
    } else if (choices && run.pushPolicy === 'preview') {
      const boundedBrain = { json: (messages, options) => brain.json(messages, { ...options, timeoutMs: Math.max(1, run.deadline - Date.now()) }) };
      result = await chooseWithPreview(boundedBrain, current.state, observation, { signal, stage: run._stage, visits: pushVisits, onComparing: async () => {} });
    } else result = await brain.json([
      { role: 'system', content: choices
        ? 'Play Sokoban. Choose ONE push from availablePushes, JSON {"choice":"push-id"}. A walking tool approaches then pushes once. You decide; no tool solves the puzzle. Avoid deadlock=true; false is not a solution guarantee. Assign boxes distinct compatible goals, keep access behind boxes, and use recentDecisions and tried counts to avoid loops. You may choose "undo" to undo the ENTIRE last push and its walking approach, or "restart". Time and decision memory continue. The engine decides success.'
        : 'Play Sokoban. Return JSON {"action":"U"} for ONE U/D/L/R move, Z undo, or X restart. Observe legalMoves, goals and recent outcomes. Avoid non-goal corners and loops. The engine decides success; the clock continues on undo/restart.' },
      { role: 'user', content: JSON.stringify(observation) },
    ], { signal, timeoutMs: Math.max(1, run.deadline - Date.now()), playEffort: 'none' });
  } catch (error) {
    if (Date.now() >= run.deadline) return { timedOut: true };
    if (error.name === 'SyntaxError' || /有效的 JSON/.test(error.message)) return { invalid: true };
    throw error;
  }
  }
  const actions = choices ? result?.choice === 'undo' ? 'Z'.repeat(run._undo?.at(-1) || 0) : result?.choice === 'restart' ? 'X' : choices.find(c => c.id === result?.choice)?.actions : result?.action;
  if (typeof actions !== 'string' || !(choices ? /^[UDLRZX]+$/ : /^[UDLRZX]$/).test(actions)) return { invalid: true };
  return { actions: actions.slice(0, RULES.maxActions - (run.actions?.length || 0)), decision: choices ? { choice: result.choice, stage: result.stage || null, continuation: result.continuation || [] } : null, ...(decision.status ? { skillStatus: decision.status } : {}) };
}

export function finishDecision(run, rows, plan, result) {
  if (!plan.decision) return;
  const before = replay(rows, plan.prefix), d = plan.decision, position = pushPositionKey(before.state), after = pushPositionKey(result.state);
  run._undo ||= [];
  if (d.choice === 'undo') run._undo.pop();
  else if (d.choice === 'restart') run._undo = [];
  else run._undo.push(result.steps - before.steps);
  run._pushVisits ||= { [position]: 1 }; run._pushVisits[after] = (run._pushVisits[after] || 0) + 1;
  run._tried ||= {}; run._tried[`${position}/${d.choice}`] = (run._tried[`${position}/${d.choice}`] || 0) + 1;
  const decision = { choice: d.choice, beforeBoxes: before.state.boxes, afterBoxes: result.state.boxes, goalsBefore: before.state.boxes.filter(p => before.state.goals.includes(p)).length, goalsAfter: result.state.boxes.filter(p => result.state.goals.includes(p)).length, revisitedPosition: run._pushVisits[after] > 1 };
  run._decisions = [...(run._decisions || []), decision].slice(-8);
  run._feedback = { ...run._feedback, decision };
  run._stage = advanceStage(d.stage, reachablePushes(before.state).find(c => c.id === d.choice), result.state, d.choice);
  run.stageGoal = run._stage; run._continuation = d.continuation;
}
