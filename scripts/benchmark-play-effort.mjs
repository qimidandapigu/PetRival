// Explicit opt-in live experiment. Uses the same production player, prompts and game clock.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PetBrain } from '../server/provider.mjs';
import { parse, solve, replay, RULES, runScore } from '../shared/game.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, '.artifacts/effort-benchmark');
const suitePath = resolve(root, 'test/fixtures/play-effort-levels.json');
const resultPath = resolve(output, 'results.json');
const digest = value => createHash('sha256').update(value).digest('hex');
const boardHash = rows => digest(JSON.stringify(rows));
const modes = ['high', 'low', 'none'];
const atomic = (file, data) => { writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n'); renameSync(file + '.tmp', file); };
mkdirSync(output, { recursive: true });

if (process.argv.includes('--prepare')) {
  if (existsSync(suitePath)) throw new Error('Suite already frozen; reuse it instead of changing the sample after observing results.');
  const data = JSON.parse(readFileSync(resolve(root, 'data/petrival.json'), 'utf8'));
  const unique = [...new Map(Object.values(data.levels).map(l => [boardHash(l.rows), l])).values()];
  const model = unique.filter(l => l.method === 'model').sort((a, b) => a.createdAt - b.createdAt).slice(0, 8);
  const training = unique.filter(l => l.method !== 'model').sort((a, b) => a.createdAt - b.createdAt).slice(0, 2);
  const levels = [...model, ...training].map((l, index) => {
    parse(l.rows); const verification = solve(l.rows);
    if (!verification.solved || !verification.actions || !replay(l.rows, verification.actions).won) throw new Error('Unverified level');
    return { id: `L${String(index + 1).padStart(2, '0')}`, source: l.method, sourceLevelId: l.id,
      sha256: boardHash(l.rows), rows: l.rows, shortestMoves: verification.actions.length };
  });
  if (levels.length !== 10 || new Set(levels.map(l => l.sha256)).size !== 10) throw new Error('Need ten unique verified levels');
  mkdirSync(resolve(root, 'test/fixtures'), { recursive: true });
  atomic(suitePath, { version: 1, selection: 'First eight chronological unique stored model levels plus first two unique stored training levels, frozen before all mode comparisons.', levels });
  console.log(JSON.stringify({ prepared: true, count: levels.length, model: model.length, training: training.length, shortestMoves: levels.map(l => l.shortestMoves) }));
} else if (process.argv.includes('--run')) {
  if (existsSync(resultPath)) throw new Error('Results already exist; do not overwrite or silently rerun trials.');
  if (!process.env.MODEL_API_KEY) throw new Error('Load the ignored local .env; a model key is required.');
  const configuredUrl = process.env.MODEL_CHAT_URL || 'https://api.deepseek.com/chat/completions';
  if (new URL(configuredUrl).origin !== 'https://api.deepseek.com') throw new Error('This experiment requires the official DeepSeek endpoint.');
  const suiteText = readFileSync(suitePath, 'utf8'), suite = JSON.parse(suiteText);
  for (const level of suite.levels) {
    if (boardHash(level.rows) !== level.sha256 || !solve(level.rows).solved) throw new Error('Suite integrity check failed');
  }
  const report = { version: 1, startedAt: new Date().toISOString(), finishedAt: null,
    model: 'deepseek-v4-pro', suiteSha256: digest(suiteText), providerSha256: digest(readFileSync(resolve(root, 'server/provider.mjs'))),
    rules: RULES, concurrency: 2, repetitions: 1, retries: 'No infrastructure retries; production player permits up to three planning rounds.',
    order: 'Rotate high/low/none order by level; two whole trials at a time; no per-trial local queue.',
    targets: { firstMoveMs: 10000, targetIsMeasuredNotGuaranteed: true }, trials: [] };
  atomic(resultPath, report);
  const requestContext = new AsyncLocalStorage(), actualFetch = globalThis.fetch;
  // Observe only safe request configuration and numeric usage, never headers, key or reasoning text.
  globalThis.fetch = async (url, options) => {
    const trial = requestContext.getStore(); if (!trial) throw new Error('Untracked provider request');
    const input = JSON.parse(options.body), state = JSON.parse(input.messages[1].content);
    if (input.messages.length !== 2 || Object.keys(state).sort().join(',') !== 'rows,turn') throw new Error('Unexpected contestant input');
    if (input.reasoning_effort !== trial.effort || input.thinking.type !== (trial.effort === 'none' ? 'disabled' : 'enabled')) throw new Error('Effort was not applied');
    const call = { round: state.turn, boardSha256: boardHash(state.rows), effort: input.reasoning_effort,
      thinking: input.thinking.type, maxTokens: input.max_tokens, promptSha256: digest(JSON.stringify(input.messages)),
      startedMs: performance.now(), headersMs: null, responseMs: null, status: null, finishReason: null, usage: null };
    trial.calls.push(call);
    try {
      const response = await actualFetch(url, options);
      call.headersMs = performance.now() - call.startedMs; call.status = response.status;
      return { ok: response.ok, json: async () => {
        try {
          const body = await response.json(); call.responseMs = performance.now() - call.startedMs;
          call.finishReason = body.choices?.[0]?.finish_reason || null;
          const usage = body.usage || {};
          call.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'].filter(k => Number.isFinite(usage[k])).map(k => [k, usage[k]]));
          const reasoning = usage.completion_tokens_details?.reasoning_tokens;
          if (Number.isFinite(reasoning)) call.usage.reasoning_tokens = reasoning;
          return body;
        } catch (error) { call.error = options.signal.aborted ? 'aborted' : 'body-read-failed'; throw error; }
      } };
    } catch (error) { call.error = options.signal.aborted ? 'aborted' : 'network-failed'; throw error; }
  };
  const pending = suite.levels.flatMap((level, index) => modes.map((_, offset) => ({ level, effort: modes[(index + offset) % modes.length] })));
  let next = 0;
  const active = new Set();
  const run = async ({ level, effort }) => {
    const trial = { level: level.id, sha256: level.sha256, effort, startedAt: new Date().toISOString(),
      firstActionMs: null, firstMoveMs: null, elapsedMs: null, wallMs: null, success: false, timedOut: false,
      actions: '', moves: 0, actionAttempts: 0, score: null, calls: [], error: null };
    const brain = new PetBrain({ run: () => { throw new Error('A contestant must not invoke the solver'); } },
      { ...process.env, AI_MODE: 'model', MODEL_NAME: report.model, MODEL_PLAY_EFFORT: effort });
    active.add(brain); const started = performance.now();
    console.log(`START ${level.id}/${effort}`);
    try {
      const result = await requestContext.run(trial, () => brain.play(level.rows, { style: 'plan', onProgress: progress => {
        const elapsed = performance.now() - started;
        if (trial.firstActionMs === null && progress.actions.length) trial.firstActionMs = elapsed;
        if (trial.firstMoveMs === null && progress.steps > 0) trial.firstMoveMs = elapsed;
        trial.actions = progress.actions; trial.moves = progress.steps;
      } }));
      const verified = replay(level.rows, result.actions);
      Object.assign(trial, { actions: result.actions, moves: verified.steps, actionAttempts: result.actions.length,
        success: verified.won && !result.timedOut && result.elapsedMs <= RULES.limitMs, elapsedMs: result.elapsedMs,
        timedOut: !!result.timedOut, note: result.note });
      trial.score = runScore(trial.success, trial.elapsedMs).score;
    } catch {
      trial.error = 'provider-or-infrastructure-failure'; trial.actionAttempts = trial.actions.length;
      trial.elapsedMs = Math.round(performance.now() - started);
    } finally {
      brain.close(); active.delete(brain); trial.wallMs = performance.now() - started;
      trial.finishedAt = new Date().toISOString();
      report.trials.push(trial); atomic(resultPath, report);
      console.log(`DONE ${report.trials.length}/30 ${level.id}/${effort} ${trial.error || (trial.success ? 'cleared' : trial.timedOut ? 'timeout' : 'failed')} firstMove=${trial.firstMoveMs === null ? 'none' : (trial.firstMoveMs / 1000).toFixed(2)}s total=${(trial.wallMs / 1000).toFixed(2)}s calls=${trial.calls.length}`);
    }
  };
  const worker = async () => { while (next < pending.length) await run(pending[next++]); };
  process.once('SIGINT', () => { for (const brain of active) brain.close(); process.exitCode = 130; next = pending.length; });
  try { await Promise.all([worker(), worker()]); }
  finally { globalThis.fetch = actualFetch; report.finishedAt = new Date().toISOString(); atomic(resultPath, report); }
  console.log(`Saved ${report.trials.length} trials to .artifacts/effort-benchmark/results.json`);
} else {
  console.log('Freeze local boards: node scripts/benchmark-play-effort.mjs --prepare\nRun 30 paid model trials: node --env-file=.env scripts/benchmark-play-effort.mjs --run');
}
