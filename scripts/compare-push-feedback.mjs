import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { replay } from '../shared/game.mjs';
const phase = process.argv[2];
if (!['baseline', 'candidate', 'candidate-v2'].includes(phase)) throw new Error('Choose baseline or candidate');
const source = phase === 'baseline' ? '../.artifacts/before-push-feedback/server/provider.mjs' : '../server/provider.mjs';
const { PetBrain } = await import(source);
const levels = JSON.parse(readFileSync(new URL('../test/fixtures/play-effort-levels.json', import.meta.url))).levels.filter(l => ['L01', 'L03'].includes(l.id));
const directory = new URL('../.artifacts/push-feedback-comparison/', import.meta.url); mkdirSync(directory, { recursive: true });
const path = new URL(`${phase}.json`, directory); if (existsSync(path)) throw new Error('Retain previous results; report already exists');
const report = { phase, at: new Date().toISOString(), effort: 'none', providerSha256: createHash('sha256').update(readFileSync(new URL(source, import.meta.url))).digest('hex'), trials: [] };
writeFileSync(path, JSON.stringify(report));
await Promise.all(levels.map(async level => {
  const brain = new PetBrain({ run() { throw new Error('Solver forbidden'); } }, { ...process.env, MODEL_PLAY_EFFORT: 'none' });
  const trial = { level: level.id, rows: level.rows, decisions: [], firstMoveMs: null };
  const call = brain.json.bind(brain); brain.json = async (messages, options) => {
    const observation = JSON.parse(messages[1].content), answer = await call(messages, options);
    trial.decisions.push({ observation, answer }); return answer;
  };
  console.log(`START ${phase} ${level.id}`);
  try {
    const result = await brain.play(level.rows, { onProgress(p) { if (p.steps && trial.firstMoveMs === null) { trial.firstMoveMs = p.elapsedMs; console.log(`FIRST ${level.id} ${p.elapsedMs}ms`); } } });
    Object.assign(trial, result, { won: replay(level.rows, result.actions).won });
  } catch (e) { trial.error = e.name; }
  finally { brain.close(); report.trials.push(trial); writeFileSync(path, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ level: trial.level, won: trial.won, steps: trial.steps, turns: trial.turn, elapsedMs: trial.elapsedMs, error: trial.error })); }
}));
