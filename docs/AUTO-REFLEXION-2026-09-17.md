# 自动反思与落点预测（2026-09-17）

学习机制优化：把 Reflexion 式的"失败自动复盘"和实验室已有的"预测-核对"信号推广到经典教学关。对应文献：Reflexion（失败信号自动触发语言化反思并注入下次决策）、预测误差作为学习信号。

## 行为变化（v2，同日第二轮）

第一轮上线后用 `scripts/repro-lesson.mjs` 无头复现（真实模型跑第 2 关），发现三个新问题并修复：

### 停滞检测（触发器盲区）

原触发条件只认"同点连摔"，但"原地小跳、不前进也不摔"（alive）会重置连摔计数，导致卡住时反思永不触发。新增 `stallStreak()`（`public/jump-lab.mjs`）：连续 2 次尝试未能把历史最远 x 推进 >16px 即触发反思，不论死活；通关或真实进展重置。

### 反思带真实物理实验（修复"反思发现不了没试过的动作"）

复现发现：模型从不尝试"按住跳"，反思只能基于旧记录，于是总结出"点按跳 65px"的错误经验并反复撞墙。现在自动触发复盘时，服务端先做一次**零 token 引擎枚举实验**（`holdExperiment()`，`server/jump-model.mjs`）：从上次起跳位置，按住跳 1/10/20/30/45/60 帧各跳一次、**落地即停**，另加一行对照（同样长跳但不按方向键）。实验表作为物理事实写进复盘 prompt（"与尝试记录冲突时以实验为准"），并注入 decision 上下文。

关键设计教训：第一版实验"跳完继续走 150 帧"，结果每个变体都走下山崖，实验表全是 DEAD——实验必须只隔离"跳"这一个变量。对照行（不按方向 = +0px）直接教会了"水平位移来自空中按住方向"，这是复现中模型学会过溪的关键事实。

### tryNext：反思必须改变下一步动作

复盘 prompt 现在要求模型输出 `tryNext`：一个**从未在 attempts 里出现过**的动作变体（≤6 段、≤120 帧）。服务端校验后返回，前端自动把它排为下一段动作（`public/jump.mjs` learnLesson），让"探索新做法"真的发生，而不是只更新知识库。

### 客户端日志回传

浏览器日志（choice/predict/learn/fall/win 等）经 `POST /api/log/client` 落盘到 `data/client-log.jsonl`（`server/http.mjs`），单批上限 30 条、字段截断、按 owner 标记、需访客身份。前端 `logEvent` 自动批量回传（`public/jump.mjs` shipLog，满 10 条或重要事件立即发，失败静默重排）。屏幕日志给人看，文件日志给复盘用。`data/` 本就不入库，日志不会进 git。

## 行为变化（v1）

### 落点预测（经典教学关，此前只有实验室有）

- `planJump` 的输出 schema 新增 `prediction:{xMin,xMax,dead}`：模型每给一段动作，必须同时预测动作结束时脚底的横坐标范围，以及会不会摔死（`server/jump-model.mjs` LESSON_SYSTEM）。
- 服务端用 `lessonPrediction()` 校验（`public/jump-lab.mjs`）：区间颠倒、超宽（>400px）、超出地图的预测一律丢弃为 `null`，**动作序列不受影响**——预测是附加信号，不是门槛。
- 播放结束后前端用 `scoreLessonPrediction()` 核对（`public/jump.mjs` scoreLessonPending）：命中/落空写入日志的 `predict` 频道，落空原因（"落点"/"生死"）追加进下次决策的 feedback。摔死时落点不适用，不重复计错。
- 选择日志（`choice`）现在也会显示经典模式的预测内容。

### 自动反思（不再依赖手动点"让它总结"）

- 触发器一（连摔）：`sameSpotStreak()` 统计连续且落点 x 相距 <48px 的跌落；达到 2 次即自动调用 `learnLesson`，trigger 文本指明失败位置。
- 触发器二（通关固化）：宠物自己通关时自动调用一次 `learnLesson`，把成功做法固化为规则。
- 每轮自动反思上限 3 次（`autoReflects`），重开回合/换关时清零；实验室模式（lab）不受影响。
- 服务端 `learnJumpLesson` 接受 `trigger` 字段：出现在系统提示中。证据计数与状态升降规则不变。

## 验证

- `test/lesson-reflexion.test.mjs`（8 项）：预测校验、引擎打分、同点连摔、停滞统计、hold 实验物理真实性（按住比点按远、对照行几乎原地）、trigger 注入、tryNext 返回。
- `test/client-log-http.test.mjs`：日志端点的截断、过滤、owner 标记与 401。
- 无头复现 `scripts/repro-lesson.mjs`（真实模型，计入版本库）：第 1 关 2 次调用通过；第 2 关在 16 次调用内学会"按住跳+空中按方向"并首次过溪（x=397→541），此前 14 次调用 0 进展。
- 全量 `npm test` 217 通过（4 个 life/http 偶发失败，主分支同样存在，单独重跑即过）；cloud-test 40 全过；`scripts/check.mjs` 0 失败。

## 度量建议（下一步）

每关通关所需跌落次数、预测命中率（日志 `predict` 频道已累计）、自动反思后同点连摔是否消失、每关 token 消耗。
