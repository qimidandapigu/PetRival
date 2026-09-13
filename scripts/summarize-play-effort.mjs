import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const report = JSON.parse(readFileSync(resolve(root, '.artifacts/effort-benchmark/results.json'), 'utf8'));
const suite = JSON.parse(readFileSync(resolve(root, 'test/fixtures/play-effort-levels.json'), 'utf8'));
const median = values => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y), i = Math.floor(a.length / 2);
  return a.length ? (a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2) : null;
};
const p90 = values => { const a = values.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.ceil(a.length * .9) - 1] : null; };
const seconds = (value, missing = '无移动') => Number.isFinite(value) ? `${(value / 1000).toFixed(2)} 秒` : missing;
const names = { high: '高思考', low: '低思考', none: '关闭思考' };
const summaries = ['high', 'low', 'none'].map(effort => {
  const trials = report.trials.filter(t => t.effort === effort);
  const values = key => trials.map(t => t[key]);
  const calls = trials.flatMap(t => t.calls), usage = calls.map(c => c.usage).filter(Boolean);
  return { effort, completed: trials.length, successes: trials.filter(t => t.success).length,
    failures: trials.filter(t => !t.success && !t.error).length, errors: trials.filter(t => t.error).length,
    noFirstMove: trials.filter(t => t.firstMoveMs === null).length,
    firstMoveMedianMs: median(values('firstMoveMs')), firstMoveP90Ms: p90(values('firstMoveMs')),
    within10s: trials.filter(t => t.firstMoveMs !== null && t.firstMoveMs <= 10000).length,
    within20s: trials.filter(t => t.firstMoveMs !== null && t.firstMoveMs <= 20000).length,
    allWallMedianMs: median(values('wallMs')), successWallMedianMs: median(trials.filter(t => t.success).map(t => t.wallMs)),
    calls: calls.length, tokens: usage.reduce((s, u) => s + (u.total_tokens || 0), 0),
    completionTokens: usage.reduce((s, u) => s + (u.completion_tokens || 0), 0),
    cachedPromptTokens: usage.reduce((s, u) => s + (u.prompt_cache_hit_tokens || 0), 0),
    unreportedUsageCalls: calls.length - usage.length,
    invalidActions: trials.reduce((s, t) => s + t.actionAttempts - t.moves, 0),
  };
});
console.log(JSON.stringify({ finishedAt: report.finishedAt, completed: report.trials.length, summaries }, null, 2));
if (process.argv.includes('--write-report')) {
  const combinations = new Set(report.trials.map(t => `${t.level}:${t.effort}`));
  if (report.trials.length !== 30 || !report.finishedAt || combinations.size !== 30 ||
      !suite.levels.every(l => ['high', 'low', 'none'].every(effort => combinations.has(`${l.id}:${effort}`)))) throw new Error('Do not publish an incomplete experiment as complete');
  const cell = (level, effort) => {
    const t = report.trials.find(t => t.level === level && t.effort === effort);
    return `${t.error ? '服务错误' : t.success ? '通过' : t.timedOut ? '超时' : '失败'}；首动 ${seconds(t.firstMoveMs)}；结束 ${seconds(t.wallMs)}；${t.moves} 步`;
  };
  const lines = [
    '# DeepSeek Pro 闯关思考强度实测', '',
    `实测开始：${report.startedAt}；结束：${report.finishedAt}。`, '',
    '同一批 10 张关卡，每档各跑 1 次，共 30 场。8 张既有模型关、2 张既有训练关；在请求模型前冻结样本。每张关的最短解为 6～26 步，本批属于早期小棋盘样本，不代表复杂推箱子。', '',
    '| 模式 | 通关 | 首次移动中位数 | 首次移动 P90 | 10 秒内移动 | 全部场次结束中位数 | 服务错误 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...summaries.map(s => `| ${names[s.effort]} | ${s.successes}/10 | ${seconds(s.firstMoveMedianMs)} | ${seconds(s.firstMoveP90Ms)} | ${s.within10s}/10 | ${seconds(s.allWallMedianMs)} | ${s.errors} |`), '',
    '首次移动指生产游戏引擎执行后，玩家或箱子的棋盘状态第一次改变；仅收到响应、执行撞墙操作都不算。首动统计仅包含实际发生过移动的场次，下面单列没有移动的数量；结束统计包含成功、失败、超时和服务错误，因此需要和通关率一起看。P90 使用最近秩法。', '',
    '| 模式 | 未发生移动 | 成功场次结束中位数 | 规划请求 | 已返回输出 Token | 已返回总 Token | 缓存输入 Token | 未报告用量的请求 | 未移动的操作 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summaries.map(s => `| ${names[s.effort]} | ${s.noFirstMove} | ${seconds(s.successWallMedianMs, '无成功场次')} | ${s.calls} | ${s.completionTokens} | ${s.tokens} | ${s.cachedPromptTokens} | ${s.unreportedUsageCalls} | ${s.invalidActions} |`), '',
    '## 每题结果', '', '| 题目 | 来源 / 最短解 | 高思考 | 低思考 | 关闭思考 |', '| --- | --- | --- | --- | --- |',
    ...suite.levels.map(l => `| ${l.id} | ${l.source === 'model' ? '模型' : '训练'} / ${l.shortestMoves} 步 | ${cell(l.id, 'high')} | ${cell(l.id, 'low')} | ${cell(l.id, 'none')} |`), '',
    '## 方法和边界', '',
    '- 模型均为官方 deepseek-v4-pro，仅改变 thinking / reasoning_effort。提示词、16384 Token 上限、生产 PetBrain.play、每步 220ms 执行、最多 3 轮规划、整场 180 秒时限完全相同。出题配置仍为 high。',
    '- 每次请求只携带当前棋盘与回合编号；没有给参赛模型出题证明、其他模式解答、主人记录或求解器结果。通关由同一游戏引擎回放验证。',
    '- 同时最多启动两场完整试验，不让已开始的比赛等待本地并发槽位。模式次序按题轮换；没有网络补跑或挑选最好一次的结果。',
    '- 真实供应商缓存、服务端负载和网络波动仍然存在。Token 只统计供应商返回的数值，超时等未报告用量的请求单列，不能据此认定其费用为零；没有把缓存收益全部解释为思考强度的效果。',
    '- 每题每模式只有一次，是选择下一步试玩配置的方向性样本；不构成稳定通关率、普遍延迟或规模承载承诺。结论针对当前整段路线提示词和最多三轮规划协议，不等于其他工具或交互协议下模型的能力上限。已有游戏存档和排名未被修改。', '',
    `样本 SHA-256：\`${report.suiteSha256}\`。生产 provider 文件 SHA-256：\`${report.providerSha256}\`。`, '',
    '可复现脚本：[benchmark-play-effort.mjs](../scripts/benchmark-play-effort.mjs)；固定关卡：[play-effort-levels.json](../test/fixtures/play-effort-levels.json)；[完整实验记录](benchmarks/2026-09-13-play-effort.json)。记录包含各次调用的数值用量和实际动作，不含 Key 或模型思考正文。原始运行记录还保留在本地 `.artifacts/effort-benchmark/results.json`。', '',
    '接口依据：[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)与[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。', '',
  ];
  mkdirSync(resolve(root, 'docs/benchmarks'), { recursive: true });
  writeFileSync(resolve(root, 'docs/benchmarks/2026-09-13-play-effort.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(resolve(root, 'docs/PLAY-EFFORT-BENCHMARK-2026-09-13.md'), lines.join('\n'));
}
