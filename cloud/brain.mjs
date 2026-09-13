import { PetBrain } from '../server/provider.mjs';
import { generate, solve, replay, renderRows, RULES } from '../shared/game.mjs';
export function makeBrain(env) {
  const jobs = { run: async (task, data) => task === 'generate' ? generate(data.seed, data.intent) : solve(data.rows, Math.min(data.maxNodes || 50000, 50000)) };
  return new PetBrain(jobs, env);
}
export async function executeJob(brain, job, signal) {
  if (job.kind === 'generate') return brain.generate(job.intent, job.seed);
  if (job.kind === 'chat') return brain.chat(job.context);
  const current = replay(job.rows, job.run.actions || '');
  if (brain.mode === 'algorithm') {
    const result = solve(renderRows(current.state), 50000);
    return { actions: result.actions || '' };
  }
  const remaining = Math.max(1, job.run.deadline - Date.now());
  let result;
  try {
    result = await brain.json([
      { role: 'system', content: 'Play Sokoban. Return JSON {"actions":"UDLR..."}. U/D/L/R move or push one tile; boxes cannot be pulled. # wall, space floor, . goal, $ box, @ player, * box on goal, + player on goal. Put both boxes on goals. Up to 120 actions. You only see the current board. Do not claim success; the game engine decides.' },
      { role: 'user', content: JSON.stringify({ rows: renderRows(current.state), turn: (job.run._round || 0) + 1 }) },
    ], { signal, timeoutMs: remaining });
  } catch (error) {
    if (Date.now() >= job.run.deadline) return { timedOut: true };
    // Infrastructure errors void the match; syntactically bad model answers are
    // an actual contestant failure, as in the original game's scoring rules.
    if (error.name === 'SyntaxError' || /有效的 JSON/.test(error.message)) return { invalid: true };
    throw error;
  }
  if (typeof result?.actions !== 'string' || !/^[UDLR]{1,120}$/.test(result.actions)) return { invalid: true };
  return { actions: result.actions.slice(0, RULES.maxActions - (job.run.actions?.length || 0)) };
}
