import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PetBrain } from '../server/provider.mjs';
import { replay } from '../shared/game.mjs';
const root = resolve(import.meta.dirname, '..'), style = process.argv.includes('--push') ? 'push' : 'step';
const directory = resolve(root, `.artifacts/${style}-trial`), path = resolve(directory, 'results.json');
if (!process.argv.includes('--run')) throw new Error('Use --run to authorize two live model trials with the loaded local key.');
if (existsSync(path)) throw new Error('Results already exist; do not overwrite prior trials.');
const suite = JSON.parse(readFileSync(resolve(root, 'test/fixtures/play-effort-levels.json'), 'utf8'));
const levels = ['L08', 'L01'].map(id => suite.levels.find(l => l.id === id));
const report = { startedAt: new Date().toISOString(), finishedAt: null, model: 'deepseek-v4-pro', style, effort: 'none',
  providerSha256: createHash('sha256').update(readFileSync(resolve(root, 'server/provider.mjs'))).digest('hex'),
  protocol: style === 'push' ? 'Model chooses one next box push from legal push options; fixed-box walking pathfinder executes the approach plus one push. Fresh outcomes each turn; max 60 turns / 180s. No puzzle solver or solution supplied.' : 'One action then fresh coordinates, legal move previews, outcome and recent history; max 60 rounds / 180s. No solver or solution supplied.', trials: [] };
mkdirSync(directory, { recursive: true });
const save = () => writeFileSync(path, JSON.stringify(report, null, 2)); save();
await Promise.all(levels.map(async level => {
  const brain = new PetBrain({ run() { throw new Error('Contestant must not use solver'); } }, { ...process.env, AI_MODE: 'model', MODEL_NAME: report.model });
  const trial = { level: level.id, sha256: level.sha256, startedAt: new Date().toISOString(), firstMoveMs: null, transitions: [], error: null };
  const started = performance.now(); let last = '';
  console.log(`START ${level.id}`);
  try {
    const result = await brain.play(level.rows, { style, onProgress: p => {
      if (p.steps > 0 && trial.firstMoveMs === null) { trial.firstMoveMs = performance.now() - started; console.log(`FIRST ${level.id} ${(trial.firstMoveMs / 1000).toFixed(2)}s`); }
      if (p.actions !== last) {
        last = p.actions;
        trial.transitions.push({ elapsedMs: p.elapsedMs, action: p.actions.at(-1), turn: p.turn, moves: p.steps });
        if (p.turn % 10 === 0) console.log(`PROGRESS ${level.id} turn=${p.turn} moves=${p.steps}`);
      }
    } });
    Object.assign(trial, result, { success: replay(level.rows, result.actions).won && !result.timedOut });
  } catch { trial.error = 'provider-or-infrastructure-error'; trial.success = false; }
  finally { brain.close(); trial.wallMs = performance.now() - started; report.trials.push(trial); save();
    console.log(`DONE ${level.id} success=${trial.success} first=${trial.firstMoveMs} total=${trial.wallMs} turns=${trial.turn} actions=${trial.actions}`); }
}));
report.finishedAt = new Date().toISOString(); save();
