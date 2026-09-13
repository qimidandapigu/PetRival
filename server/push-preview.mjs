import { parse, replay, renderRows, stateKey } from '../shared/game.mjs';
import { reachablePushes, pushPositionKey } from './step-observation.mjs';

const point = p => ({ x: p % 8, y: Math.floor(p / 8) });
const cell = p => p && Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.x < 8 && p.y >= 0 && p.y < 8 ? p.y * 8 + p.x : -1;
const publicPush = ({ actions, ...push }) => push;

export function validateStage(stage, state) {
  const box = cell(stage?.box), target = cell(stage?.target);
  if (!state.boxes.includes(box) || !state.goals.includes(target) || box === target) return null;
  return { box: point(box), target: point(target) };
}

export function advanceStage(stage, push, state, control) {
  if (!stage || control === 'undo' || control === 'restart') return null;
  const box = push && cell(push.box) === cell(stage.box) ? push.boxTo : stage.box;
  return validateStage({ box, target: stage.target }, state);
}

// Only simulate model-proposed branches. No search, ranking, or solution oracle.
// These states never enter the authoritative action history.
export function previewCandidates(state, proposals, visits = new Map()) {
  if (!Array.isArray(proposals)) return [];
  return proposals.slice(0, 3).map((proposal, index) => {
    const ids = Array.isArray(proposal?.pushes) ? proposal.pushes.slice(0, 4) : [];
    let current = state;
    const labeledBoxes = { A: state.boxes[0], B: state.boxes[1] };
    const trajectory = [], localVisits = new Set([pushPositionKey(state)]);
    let error = ids.length ? null : 'No proposed pushes';
    for (const instruction of ids) {
      const id = typeof instruction === 'string' ? instruction :
        instruction && ['A', 'B'].includes(instruction.box) && ['U', 'D', 'L', 'R'].includes(instruction.direction)
          ? `push-${labeledBoxes[instruction.box]}-${instruction.direction}` : null;
      const push = reachablePushes(current).find(p => p.id === id);
      if (!push) { error = `Push ${String(id).slice(0, 30)} is not reachable in this simulated position`; break; }
      const outcome = replay(renderRows(current), push.actions);
      for (const label of ['A', 'B']) if (labeledBoxes[label] === cell(push.box)) labeledBoxes[label] = cell(push.boxTo);
      current = outcome.state;
      const key = pushPositionKey(current);
      trajectory.push({ push: publicPush(push), rows: renderRows(current), boxes: current.boxes.map(point),
        goalsFilled: current.boxes.filter(p => current.goals.includes(p)).length,
        revisitsRealPosition: visits.get(key) || 0, repeatsInPreview: localVisits.has(key), won: outcome.won });
      localVisits.add(key);
      if (push.deadlock) { error = 'Geometric deadlock: boxes cannot reach distinct goals'; break; }
      if (outcome.won) break;
    }
    return { index, firstChoice: trajectory[0]?.push.id ?? null, simulatedPushes: trajectory.length,
      trajectory, error, finalAvailablePushes: reachablePushes(current).map(publicPush) };
  });
}

export async function chooseWithPreview(brain, state, observation, { signal, stage, visits, onComparing }) {
  const activeStage = validateStage(stage, state);
  const proposal = await brain.json([
    { role: 'system', content: 'Play two-box Sokoban. Return JSON {"stage":{"box":{"x":2,"y":3},"target":{"x":2,"y":2}},"replaceStage":false,"candidates":[{"pushes":[{"box":"A","direction":"U"},{"box":"A","direction":"R"}]}]}. boxLabels assigns A and B to the boxes in THIS observation. Labels follow the same box throughout each candidate, even after it moves; the engine updates coordinates. Keep activeStage until achieved; if revision is necessary explicitly set replaceStage=true. Choose a box/goal assignment leaving the other box a distinct goal. Propose up to THREE genuinely different branches of TWO to FOUR pushes; one push is enough if about to win or no useful continuation is known. First pushes must be available now; all continuations must preserve a reachable standing square behind the box. Walking is automatic with boxes fixed. You may move the other box to clear space. Do not fill a goal prematurely if it blocks another box. Never propose deadlock=true pushes. Use recentDecisions to avoid loops. No prose or full solution. To backtrack instead, return {"choice":"undo"} or {"choice":"restart"}.' },
    { role: 'user', content: JSON.stringify({ ...observation, activeStage, boxLabels: { A: point(state.boxes[0]), B: point(state.boxes[1]) } }) },
  ], { signal, playEffort: 'none' });
  if (proposal?.choice === 'undo' || proposal?.choice === 'restart') return { choice: proposal.choice, stage: null };
  const previews = previewCandidates(state, proposal?.candidates, visits);
  if (!previews.some(p => p.firstChoice)) return null;
  const nextStage = activeStage && proposal?.replaceStage !== true ? activeStage : validateStage(proposal?.stage, state);
  await onComparing();
  // A single fully valid branch is already the model's selection, not a tool ranking.
  const result = previews.length === 1 && !previews[0].error ? { candidate: 0 } : await brain.json([
    { role: 'system', content: 'Choose a short Sokoban branch using ENGINE-SIMULATED candidates. Return JSON {"candidate":0}, selecting an index, or {"choice":"undo"}/{"choice":"restart"} to backtrack. Pushes execute one at a time, checking each actual board against the preview; a mismatch invalidates the remaining branch. Compare final boards, remaining reachable pushes, stage progress, access behind each box, and distinct goal assignments. Prefer a branch that solves the board or makes useful stage progress with no deadlock and no loop. A temporarily farther move may be necessary; do not rank solely by filled goals or distance. Avoid branches ending in geometric deadlocks or returning to failed positions. An invalid future push is reported in error; only the first push may execute for such a branch, followed by replanning. Do not choose a first push flagged deadlock. You make the selection; no external solver ranks candidates.' },
    { role: 'user', content: JSON.stringify({ rows: observation.rows, remainingSeconds: observation.remainingSeconds, activeStage: nextStage,
      canUndo: observation.canUndo, remainingGoals: observation.remainingGoals, recentDecisions: observation.recentDecisions,
      previews }) },
  ], { signal, playEffort: 'none' });
  if (result?.choice === 'undo' || result?.choice === 'restart') return { choice: result.choice, stage: null };
  const selected = Number.isInteger(result?.candidate) ? previews.find(p => p.index === result.candidate) : null;
  if (!selected?.firstChoice || selected.trajectory[0].push.deadlock) return null;
  const continuation = selected.error ? [] : selected.trajectory.slice(1).map((step, index) => ({
    choice: step.push.id, beforeKey: stateKey(parse(selected.trajectory[index].rows)), afterKey: stateKey(parse(step.rows)),
  }));
  return { choice: selected.firstChoice, stage: nextStage, continuation };
}
