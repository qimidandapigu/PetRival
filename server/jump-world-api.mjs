import { CHANNELS, LAB_PLAN_TARGET } from '../public/jump-lab.mjs';
import { validateLevel } from '../public/jump-world.mjs';
import { scoreWorldModel, planWithWorldModel, MODEL_LIMIT } from './jump-world-code.mjs';
import { ask, error, modelOnly, state, text, traceInput } from './jump-model.mjs';

// The world-model lane lives in its own module because it is the only place that runs
// model-authored code. Node owns it; the Sites Worker deliberately does not import it.
const WORLD_MODEL_SYSTEM = `你把观察到的东西写成一段**可执行的 JavaScript 世界模型**。服务端会真的逐帧运行它，把结果和真实实验记录比对，错在哪一帧、差多少都会告诉你。
规则：
1. 只定义函数 step(state, action, level)，返回**下一帧**的状态对象 {x, y, vy, grounded, held}。
2. state：{x, y, vy, grounded, held}。y 向下增大，y 是脚底位置；grounded 表示这一帧站在平台上；held 表示上一帧通道是否按住（你返回什么，下一帧就会收到什么）。
3. action：{a, b, c} 三个布尔值，表示这一帧按下了哪些通道。level：{width, platforms:[{x,y,w}], goal, key, switch, coins, door}。
4. 允许 Math、JSON；不允许 import、require、console、随机数、定时器、网络或读写文件。每帧只前进一帧，不要自己循环。
5. **这个世界是逐帧离散的，没有连续时间**：没有 dt、没有秒、没有像素/秒、没有积分。下一帧就是「y 加上 vy」「vy 加上每帧重力增量」这样直接相加；表里写的 vy 就是每帧的位移，不是速度单位。请不要再换算成 dt=1/60 或 174 px/s 这类写法。
6. 每条实验的前 10 帧是**逐帧**记录，之后每 5 帧一条。逐帧数据可以直接算出每帧位移和每帧 vy 的变化：请用相邻两帧的差值得到每帧重力和跳跃初速，不要用多帧平均去推算。
7. **不要写表里没有的机制。** 加速度、摩擦、速度上限（终端速度）、空中转向、二段跳、连续时间积分这一类，只有在表里能找到两帧直接支持时才允许写；找不到就不写。默认每一帧的位移就是「按下哪个通道」的直接结果。
8. 不要引用任何外部游戏常识，也不要用表里看不出来的规则。
9. 输出 JSON {code:"完整的 JS 代码", notes:["你从表里读出的关键数字"], confidence:0到1}。code 里不要写 markdown 代码围栏。`;
// One divergence at a time: a long list of mismatches invites a full rewrite, and the
// first wrong frame is what actually identifies the wrong rule.
function mismatchReport(score, traces) {
  const first = (score.mismatches || [])[0];
  const detail = first
    ? `最早的一处分歧在实验 ${first.trace} 第 ${first.t} 帧：你预测 x=${first.predicted.x} y=${first.predicted.y} vy=${first.predicted.vy} grounded=${first.predicted.grounded}；真实 x=${first.actual.x} y=${first.actual.y} vy=${first.actual.vy} grounded=${first.actual.grounded}。${first.inputChange ? `这一段的输入和上一段不同（${first.inputChange}）——表里出现过这种输入变化的地方都要解释清楚，不要因为「只有一次」就跳过。` : ''}`
    : '';
  const head = score.frames
    ? `上一次的代码在 ${score.frames} 帧对比里错了 ${score.frames - score.matched} 帧（最差偏差约 ${score.worst} 倍容差）。`
    : `上一次的代码一帧都没跑通${score.failed ? `：${text(score.failed, 160)}` : ''}。`;
  return `${head}\n${detail}\n只改导致这一处不同的写法，其余部分保持原样；如果表里有更早的逐帧数据能验证你的改动，先在心里对一遍再输出。重新输出完整 JSON。实验表编号：${traces.map(t => t.id).join('、')}。`;
}
export async function writeJumpWorldModel(brain, input, { signal } = {}) {
  modelOnly(brain);
  let level, traces;
  try { level = validateLevel(input?.world?.level); traces = traceInput(input?.traces, level); } catch (e) { throw error(e.message); }
  if (!traces.length) throw error('没有可用来校准世界模型的实验记录');
  const from = state(input?.actor, level);
  const planTo = Number.isFinite(input?.planTo) ? Math.min(level.width - 16, Math.max(16, input.planTo)) : Math.min(level.width - 16, LAB_PLAN_TARGET);
  const started = Date.now(), messages = [
    { role: 'system', content: WORLD_MODEL_SYSTEM },
    { role: 'user', content: JSON.stringify({ world: { name: text(input?.world?.name, 40), level }, channels: [...CHANNELS], experiments: traces }) },
  ];
  let best = null, attempt = 0, notes = '', failure = '', lastCode = '';
  while (attempt < 4) {
    attempt++;
    let raw;
    // A transient provider failure on a repair turn must not throw away the turns that
    // already matched: keep the best attempt and report why the loop stopped. The very
    // first turn gets one retry, because losing it loses the whole request.
    try { raw = await ask(brain, messages, { signal, maxTokens: 2600, timeoutMs: 120000 }); }
    catch (e) {
      if (attempt === 1) { try { raw = await ask(brain, messages, { signal, maxTokens: 2600, timeoutMs: 120000 }); } catch { failure = text(e.message, 200); throw e; } }
      else { failure = text(e.message, 200); if (best) break; throw e; }
    }
    const code = typeof raw?.code === 'string' ? raw.code.replace(/^```[a-z]*\n?|```$/g, '').slice(0, MODEL_LIMIT) : '';
    if (!code) { failure = '模型没有给出 code 字段'; break; }
    lastCode = code;
    notes = text(raw?.notes?.join?.('；') ?? raw?.notes, 300);
    const score = scoreWorldModel(code, traces, level);
    if (!score.ok) {
      failure = score.problem;
      messages.push({ role: 'assistant', content: JSON.stringify({ code, notes: raw?.notes }) },
        { role: 'user', content: `你的代码没法运行：${text(score.problem, 200)}。请修好它，重新输出完整 JSON。` });
      continue;
    }
    if (!best || score.error < best.score.error) best = { code, score };
    if (score.error === 0) break;
    messages.push({ role: 'assistant', content: JSON.stringify({ code, notes: raw?.notes }) }, { role: 'user', content: mismatchReport(score, traces) });
  }
  // A model that never matched is reported, never accepted: no verification, no plan.
  const score = best?.score ?? null, verified = !!score && score.error === 0;
  const problem = text(failure || score?.failed || '', 200);
  const planned = verified ? planWithWorldModel(best.code, level, { start: { x: from.x, y: from.y, vy: from.vy, grounded: from.grounded }, target: { x: planTo, y: from.y } }) : null;
  return { method: 'model', model: brain.info().model, code: best?.code || lastCode, verified, attempts: attempt,
    matched: score?.matched ?? 0, frames: score?.frames ?? 0, error: score?.error ?? 1, worst: score?.worst ?? 0, died: score?.died === true,
    mismatches: (score?.mismatches || []).slice(0, 4), notes, failure: problem,
    plan: planned?.ok && planned.found ? planned.plan : [], predicted: planned?.ok && planned.found ? planned.predicted : null,
    planTo, planProblem: planned && !planned.ok ? text(planned.problem, 160) : '', latencyMs: Date.now() - started };
}
