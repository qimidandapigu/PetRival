import { parentPort, workerData } from 'node:worker_threads';
import { generate, solve } from '../shared/game.mjs';
try {
  const { task, data } = workerData;
  const result = task === 'generate' ? generate(data.seed, data.intent) : solve(data.rows, data.maxNodes);
  parentPort.postMessage({ result });
} catch (error) { parentPort.postMessage({ error: error.message }); }
