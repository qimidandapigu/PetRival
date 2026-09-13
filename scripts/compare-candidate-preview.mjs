import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { replay } from '../shared/game.mjs';
const phase = process.argv[2];
if (!['baseline', 'candidate'].includes(phase)) throw new Error('Choose baseline or candidate');
const source = phase === 'baseline' ? '../.artifacts/before-candidate-preview/server/' : '../server/';
const { PetBrain } = await import(`${source}provider.mjs`);
const batch = process.argv[3] || 'v1';
if (!['v1', 'v2'].includes(batch)) throw new Error('Unknown frozen batch');
const directory = new URL(`../.artifacts/${batch === 'v2' ? 'candidate-preview-v2-comparison' : 'candidate-preview-comparison'}/`, import.meta.url);
const fixture = readFileSync(new URL('levels.json', directory), 'utf8').replace(/^\uFEFF/, '');
const { levels } = JSON.parse(fixture);
const path = new URL(`${phase}.json`, directory);
if (existsSync(path)) throw new Error('Report exists; retain every prior run');
const hash = data => createHash('sha256').update(data).digest('hex');
const files = ['provider.mjs', 'step-observation.mjs', ...(phase === 'candidate' ? ['push-preview.mjs'] : [])];
const report = { phase, at: new Date().toISOString(), model: process.env.MODEL_NAME || 'deepseek-v4-pro', effort: 'none', fixtureSha256: hash(fixture),
  code: Object.fromEntries(files.map(file => [file, hash(readFileSync(new URL(`${source}${file}`, import.meta.url)))])), trials: [] };
writeFileSync(path, JSON.stringify(report));
async function run(level) {
  const brain = new PetBrain({ run() { throw new Error('Solver forbidden during play'); } }, { ...process.env, MODEL_PLAY_EFFORT: 'none', MODEL_PUSH_POLICY: phase === 'candidate' ? 'preview' : 'feedback' });
  const trial = { level: level.id, rows: level.rows, decisions: [], firstMoveMs: null };
  const call = brain.json.bind(brain);
  brain.json = async (messages, options) => {
    const started = Date.now();
    const record = { observation: JSON.parse(messages[1].content), effort: options?.playEffort };
    trial.decisions.push(record);
    try { const answer = await call(messages, options); record.answer = answer; return answer; }
    catch (e) { record.error = e.constructor.name; record.message = String(e.message).slice(0, 200); throw e; }
    finally { record.elapsedMs = Date.now() - started; }
  };
  console.log(`START ${phase} ${level.id}`);
  try {
    const result = await brain.play(level.rows, { onProgress(p) { trial.lastProgress = p; if (p.steps && trial.firstMoveMs === null) trial.firstMoveMs = p.elapsedMs; } });
    Object.assign(trial, result, { won: replay(level.rows, result.actions).won });
  } catch (e) { trial.error = e.constructor.name; trial.message = String(e.message).slice(0, 200); }
  finally {
    brain.close(); report.trials.push(trial); writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ level: level.id, won: trial.won, steps: trial.steps, turns: trial.turn, calls: trial.decisions.length, elapsedMs: trial.elapsedMs, error: trial.error }));
  }
}
// Same two simultaneous contestants and normal movement/deadline settings in both runs.
for (let i = 0; i < levels.length; i += 2) await Promise.all(levels.slice(i, i + 2).map(run));
