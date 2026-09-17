// Fluency check: does playback ever starve waiting for the model? Virtual 60fps playback
// runs against REAL model latency. With prefetch on, the next plan is requested while the
// current one plays; serial mode is the old blocking loop, for contrast.
// Run: node --env-file-if-exists=.env scripts/repro-fluency.mjs [stageId] [serial|prefetch]
import { PetBrain } from '../server/provider.mjs';
import { planJump } from '../server/jump-model.mjs';
import { actor, progress as freshProgress, step, replayActions } from '../public/jump-world.mjs';
import { stageLevel } from '../public/jump-stages.mjs';

const stageId = Number(process.argv[2]) || 1, mode = process.argv[3] || 'prefetch';
const level = stageLevel(stageId);
const brain = new PetBrain({ run: async () => { throw new Error('no jobs'); } }, process.env);
if (brain.mode !== 'model') { console.error('AI_MODE is not model'); process.exit(1); }

const cloneProgress = p => ({ coins: [...p.coins], key: p.key, switchOn: p.switchOn, won: p.won });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pet = actor(level.spawn), prog = freshProgress(), queue = [], prefetched = null, pending = false;
let attempts = [], knowledge = [], calls = 0, played = 0, starved = 0, stalls = 0, won = false;
const MAX_CALLS = 12, FRAME_MS = 8, MAX_FRAMES = 60 * 120;

function requestPlan(input) {
  pending = true; calls++;
  planJump(brain, { level, demonstrations: [], attempts, knowledge, ...input })
    .then(r => { prefetched = r.actions; pending = false; console.log(`  [t=${(played / 60).toFixed(1)}s play] 计划 #${calls} 到达（${(r.latencyMs / 1000).toFixed(1)}s）：${r.goal || ''}`); })
    .catch(e => { pending = false; console.log(`  计划 #${calls} 失败：${e.message}`); });
}

console.log(`stage=${stageId} mode=${mode}`);
for (let frame = 0; frame < MAX_FRAMES && !won && calls <= MAX_CALLS; frame++) {
  if (queue.length) {
    const a = queue[0];
    step(pet, a, level, prog);
    if (--a.frames <= 0) queue.shift();
    played++;
    if (pet.dead) {
      queue = []; prefetched = null;
      attempts = [...attempts, { from: { x: 48, y: 400, vy: 0, grounded: true }, to: { x: pet.x, y: pet.y, vy: pet.vy, grounded: false }, outcome: 'fell', actions: [{ move: 1, jump: false, frames: 10 }] }].slice(-8);
      console.log(`  [t=${(played / 60).toFixed(1)}s play] 摔落 x=${Math.round(pet.x)}`);
      pet = actor(level.spawn); prog = freshProgress();
    }
    if (prog.won) { won = true; break; }
    if (mode === 'prefetch' && queue.length && !prefetched && !pending && calls < MAX_CALLS) {
      const sim = replayActions(level, actor({ ...pet }), cloneProgress(prog), queue.map(a => ({ ...a })));
      if (!sim.actor.dead && !sim.progress.won) requestPlan({ actor: sim.actor, progress: sim.progress });
    }
  } else if (prefetched) {
    queue = prefetched.map(a => ({ ...a })); prefetched = null;
  } else {
    starved++; if (starved % 60 === 1) stalls++;
    if (!pending && calls < MAX_CALLS) requestPlan({ actor: pet, progress: prog });
  }
  await sleep(FRAME_MS);
}
const coverage = played / Math.max(1, played + starved);
console.log(`\nRESULT stage=${stageId} mode=${mode}: 播放 ${played} 帧（${(played / 60).toFixed(1)}s），饥饿 ${starved} 帧，覆盖率 ${(coverage * 100).toFixed(1)}%，模型调用 ${calls} 次，won=${won}`);
process.exit(0);
