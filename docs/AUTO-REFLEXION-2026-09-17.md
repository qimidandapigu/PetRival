# 自动反思与落点预测（2026-09-17）

学习机制优化：把 Reflexion 式的"失败自动复盘"和实验室已有的"预测-核对"信号推广到经典教学关。对应文献：Reflexion（失败信号自动触发语言化反思并注入下次决策）、预测误差作为学习信号。

## 行为变化

### 落点预测（经典教学关，此前只有实验室有）

- `planJump` 的输出 schema 新增 `prediction:{xMin,xMax,dead}`：模型每给一段动作，必须同时预测动作结束时脚底的横坐标范围，以及会不会摔死（`server/jump-model.mjs` LESSON_SYSTEM）。
- 服务端用 `lessonPrediction()` 校验（`public/jump-lab.mjs`）：区间颠倒、超宽（>400px）、超出地图的预测一律丢弃为 `null`，**动作序列不受影响**——预测是附加信号，不是门槛。
- 播放结束后前端用 `scoreLessonPrediction()` 核对（`public/jump.mjs` scoreLessonPending）：命中/落空写入日志的 `predict` 频道，落空原因（"落点"/"生死"）追加进下次决策的 feedback。摔死时落点不适用，不重复计错。
- 选择日志（`choice`）现在也会显示经典模式的预测内容。

### 自动反思（不再依赖手动点"让它总结"）

- 触发器一（连摔）：`sameSpotStreak()` 统计连续且落点 x 相距 <48px 的跌落；达到 2 次即自动调用 `learnLesson`，trigger 文本指明失败位置（"在 x≈480 附近连续摔了 2 次"）。存活/通关会重置连击。
- 触发器二（通关固化）：宠物自己通关时自动调用一次 `learnLesson`，把成功做法固化为规则（trigger="它自己通关了这一关…"）。
- 每轮自动反思上限 3 次（`autoReflects`），重开回合/换关时清零；实验室模式（lab）不受影响。
- 服务端 `learnJumpLesson` 接受 `trigger` 字段：出现在系统提示中（"这次总结是自动触发的…优先解释并解决这个具体问题"）。证据计数与状态升降规则不变——自动反思产出的规则同样要靠真实 attempt id 才能升到「确认」。

## 验证

- 新增 `test/lesson-reflexion.test.mjs`（5 项）：预测校验边界、引擎打分（含死亡时落点作废）、同点连摔统计与重置、planJump 返回预测且不泄露物理常数、learnJumpLesson 的 trigger 注入与手动路径不变。
- 全量 `npm test` 与 `node --test cloud-test/*.test.mjs` 通过；`scripts/check.mjs` 0 失败。
- 注意：本机全量测试中 life/http 测试存在与改动无关的偶发失败（Windows 临时文件 rename EPERM、端口/时序），在未修改的 main 上同样出现。

## 度量建议（下一步）

每关通关所需跌落次数、预测命中率（日志 `predict` 频道已累计）、自动反思后同点连摔是否消失、每关 token 消耗。
