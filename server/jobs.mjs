import { Worker } from 'node:worker_threads';

export class Jobs {
  constructor(limit = 2) { this.limit = limit; this.active = 0; this.queue = []; this.workers = new Set(); this.closed = false; }
  run(task, data) {
    if (this.closed) return Promise.reject(new Error('服务已停止'));
    if (this.queue.length >= 32) return Promise.reject(new Error('任务繁忙，请稍后重试'));
    return new Promise((resolve, reject) => { this.queue.push({ task, data, resolve, reject }); this.pump(); });
  }
  pump() {
    while (!this.closed && this.active < this.limit && this.queue.length) {
      const job = this.queue.shift(); this.active++;
      const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { task: job.task, data: job.data } });
      this.workers.add(worker);
      let finished = false;
      const finish = (error, result) => {
        if (finished) return; finished = true;
        clearTimeout(timer); this.workers.delete(worker); this.active--; worker.terminate();
        if (error) job.reject(error); else job.resolve(result);
        this.pump();
      };
      const timer = setTimeout(() => finish(new Error('搜索超时')), 15000);
      worker.on('message', m => finish(m.error ? new Error(m.error) : null, m.result));
      worker.on('error', e => finish(e));
      worker.on('exit', () => { if (!finished) finish(new Error('搜索任务已停止')); });
    }
  }
  async close() { this.closed = true; for (const job of this.queue.splice(0)) job.reject(new Error('服务已停止')); await Promise.all([...this.workers].map(w => w.terminate())); }
}
