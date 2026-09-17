# 摔死预取 + 记忆三层（2026-09-17）

横版闯关的两处优化，都是"两层架构"标准（docs/REALTIME-TWO-LAYER-STANDARD-2026-09-16.md）的延伸。

## 1. 摔死预取（death prefetch）

**问题**：预取接线后，`prefetch()` 推演当前段终点，但如果终点是"摔死"就直接放弃——于是每次摔死都回到"复活 → 现场等模型 4–13 秒"的老路。

**做法**（`public/jump.mjs`）：

- 死亡后的世界状态是**完全确定的**（复活点 + 全新进度），所以 `prefetch()` 推演到死亡时，改为以 `actor(level.spawn)` + `freshProgress()` 为起点请求下一段，标记 `prefetched.afterDeath = true`。
- 死亡发生时（`advance()`）只丢弃**非** afterDeath 的预取——那是按"还活着"算的，必须作废；afterDeath 的就是为复活准备的，保留。
- 复活那一帧直接 `adoptPlan`，无需任何现场等待；被采用的段自身再链式预取下一段，流水线不空转。
- **例外**：复盘（learnLesson）如果得出了新规则（learned/confirmed/adjusted 任一非零），afterDeath 预取会被丢弃并在日志注明——它按旧认识算的，复活后要用新规则重新决策。这是"世界变了就重规划"的触发条件之一。

测试：`test/jump-ui.test.mjs` 的 "death prefetch" 用第 2 关（有溪）验证：摔死段播放期间就发出了以复活点为起点的请求，复活后无现场决策直接接上，且采用后再链式预取（共 3 次请求、0 次阻塞）。

## 2. 决策上下文的记忆三层

**问题**：决策提示词里，8 条尝试各带完整动作 JSON、4 条示范各带完整关卡+动作——绝大部分 token 花在了模型根本不需要逐帧看的历史上；而且示范被复盘消化过后仍然原样重复送。

**三层结构**：

| 层 | 内容 | 进入决策上下文的形式 |
|---|---|---|
| 规则库 | 复盘蒸馏出的规则（猜想/观察/确认/已推翻，带证据计数） | 全量（summarizeNotebook 整理后） |
| 情景卡 | 最近 8 次尝试 | 每条 = from/to/outcome + summary（如 `右120帧→右跳30帧`）；**只有最近 2 次**附完整 actions |
| 未蒸馏示范 | 主人刚录、还没被复盘消化的操作 | 最多 4 条完整录像；**蒸馏后退场**，由规则代替 |

实现：

- `server/jump-model.mjs` 的 `attemptsInput` 把较早尝试的 `actions` 换成 `summary` 字段（`actionSummary()`），系统提示词同步说明格式。复盘端共用同一函数，证据 id 引用不变。
- `public/jump.mjs`：`learnLesson` 成功后把全部示范标记 `distilled = true`（随 samples 一起持久化）；决策/预取只送 `freshSamples()`（未蒸馏、最多 4 条）。复盘本身仍能看到全部示范。
- 记忆面板（renderMemory）和示范计数文案同步说明"未蒸馏直接送 / 已蒸馏由规则代替"。

测试：`test/jump-model.test.mjs` 验证情景卡压缩（旧尝试无 actions、有 summary、最近两次保留原样）；`test/jump-ui.test.mjs` 验证复盘后示范标记 distilled、决策请求 demonstrations 为 0。

## 验证

- 新增/相关 64 项测试全过（jump-ui、jump-model、lesson-reflexion、jump-lab 等）。
- 行为仍是真实模型决策；无脚本代打。

## 限制

- 蒸馏标记以"复盘看过"为准，不区分该示范是否真的支撑了某条规则（模型可能没引用它）。代价是偶有一条未被引用的示范提前退场，可接受——复盘证据计数仍在追踪。
- 推箱子、打拳仍只接了标准接口，未接摔死预取/记忆三层。
