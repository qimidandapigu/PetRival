// Headless reproduction of the classic lesson loop with the real model, mirroring the
// browser's auto-reflection: stall detection, engine experiment, and tryNext execution.
// The pet KEEPS ITS POSITION between calls exactly like the browser; death respawns it.
// Run: node --env-file-if-exists=.env scripts/repro-lesson.mjs [stageId]
import { PetBrain } from '../server/provider.mjs';
import { planJump, learnJumpLesson } from '../server/jump-model.mjs';
import { actor, progress as freshProgress, replayActions } from '../public/jump-world.mjs';
import { stageLevel } from '../public/jump-stages.mjs';
import { sameSpotStreak, stallStreak, scoreLessonPrediction, summarizeNotebook } from '../public/jump-lab.mjs';

const stageId = Number(process.argv[2]) || 1;
const level = stageLevel(stageId);
const jobs = { run: async () => { throw new Error('no jobs'); } };
const brain = new PetBrain(jobs, process.env);
if (brain.mode !== 'model') { console.error('AI_MODE is not model'); process.exit(1); }

const cloneProgress = p => ({ coins: [...p.coins], key: p.key, switchOn: p.switchOn, won: p.won });
let pet = actor(level.spawn), prog = freshProgress();
let attempts = [], knowledge = [], autoReflects = 0, wins = 0, tryNext = null;
const MAX_CALLS = 16;

for (let call = 1; call <= MAX_CALLS; call++) {
  let actions, prediction = null;
  if (tryNext) { actions = tryNext; tryNext = null; console.log(`\nCALL ${call}: 执行反思提出的变体 ${JSON.stringify(actions)}`); }
  else {
    let result;
    try { result = await planJump(brain, { level, actor: pet, progress: prog, attempts, knowledge, demonstrations: [] }); }
    catch (e) { console.log(`CALL ${call}: ERROR ${e.message}`); continue; }
    ({ actions, prediction } = result);
    console.log(`\nCALL ${call} (${(result.latencyMs / 1000).toFixed(1)}s) from x=${Math.round(pet.x)}: goal=「${result.goal}」`);
    console.log(`  actions=${JSON.stringify(actions)}`);
  }
  const start = { x: pet.x, y: pet.y, vy: pet.vy, grounded: pet.grounded };
  const r = replayActions(level, actor({ ...pet }), cloneProgress(prog), actions);
  pet = r.actor; prog = r.progress;
  const dead = pet.dead, won = prog.won;
  const outcome = dead ? 'fell' : won ? 'won' : 'alive';
  attempts = [...attempts, { from: start, to: { x: pet.x, y: pet.y, vy: pet.vy, grounded: pet.grounded }, outcome, actions }].slice(-8);
  const scored = prediction ? scoreLessonPrediction(prediction, pet, dead) : null;
  console.log(`  → actual x=${Math.round(pet.x)} dead=${dead} won=${won}${prediction ? ` pred=${JSON.stringify(prediction)} ${scored.hit ? 'HIT' : `MISS(${scored.missed.join(',')})`}` : ''}`);
  if (won) { wins++; console.log('  *** WON ***'); break; }
  if (dead) { pet = actor(level.spawn); prog = freshProgress(); }
  const { streak, x } = sameSpotStreak(attempts), stall = stallStreak(attempts);
  if ((streak >= 2 || stall.streak >= 2) && autoReflects < 4) {
    autoReflects++;
    const trigger = streak >= 2 ? `在 x≈${Math.round(x)} 附近连续摔了 ${streak} 次，同一做法反复失败`
      : `连续 ${stall.streak} 次尝试都没能把最远距离推进过 x≈${Math.round(stall.best ?? 0)}，一直卡在原地`;
    console.log(`  >> AUTO-REFLECT: ${trigger}`);
    try {
      const learned = await learnJumpLesson(brain, { level, attempts, knowledge, demonstrations: [], trigger });
      knowledge = learned.knowledge;
      if (learned.experiment) console.log(`  >> engine experiment: ${learned.experiment.map(r2 => `hold${r2.holdFrames}→${r2.dead ? 'DEAD' : `+${r2.traveled}px`}`).join(' ')}`);
      if (learned.tryActions) { tryNext = learned.tryActions; console.log(`  >> tryNext=${JSON.stringify(tryNext)}`); }
      for (const n of summarizeNotebook(knowledge).slice(-3)) console.log(`     [${n.state}] ${n.claim} (evidence ${n.evidence.length})`);
    } catch (e) { console.log(`  >> REFLECT ERROR ${e.message}`); }
  }
}
console.log(`\nDONE stage=${stageId} wins=${wins} attempts=${attempts.length} rules=${knowledge.length}`);
process.exit(0);
