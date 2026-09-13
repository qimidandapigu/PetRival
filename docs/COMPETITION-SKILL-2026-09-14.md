# 比赛技能槽（2026-09-14）

## 本次实现

每只小精灵有「技巧 100」属性与 **1 个比赛技能槽**。可以装备推箱子或打拳技能；两个项目共用槽位。技能名称最多 24 个字，描述与 TS 源码原样保存。执行不会扣减技巧或容量。

计数为 `encode(description).length + encode(code).length`，固定使用 `gpt-tokenizer@3.4.0` 的 `o200k_base` 编码。名称、项目和系统类型说明不计入；描述与代码内的空格、注释、类型标注全部计入。100 token 可以保存，101 token 拒绝；客户端上传的计数、容量等额外字段会被拒绝。这里的 token 是游戏统一的容量单位，不表示 DeepSeek 的实际 API 计费用量。

入口：主页「宠物技能库 → 比赛技能 → 装备比赛技能 / 查看或替换技能」。支持填写示例、实时服务端计数、当前局面试运行、替换、卸下。保存接口有版本检查，旧页面不能静默覆盖另一页面的修改。旧宠物默认空槽，无需重置存档。

接口：

- `POST /api/pets/skill/check`：`{name, gameId, description, code}`，返回计数、语法/容量结果、试运行状态，不写入存档。
- `POST /api/pets/skill`：`{revision, skill}`，skill 为上述对象或 null（卸下），服务端再次校验后持久保存。
- `/api/state` 的 `mine.competition` 含自己的代码、描述、revision；其他宠物只暴露名称、项目、容量，不暴露私有源码。

Node JSON 存档和 Cloud D1 的宠物 JSON 均已接通。创建比赛或试玩时把技能放入私有快照，替换技能只影响新比赛。比赛快照不会返回给浏览器或发送给模型。

## 执行约束

使用 `@babel/parser@7.28.5` 解析 TS 箭头函数，转换为数据指令并解释执行。支持单参数箭头函数、const、if、return、条件/逻辑/基础算术表达式、只读属性、可选属性访问、数组 find/filter/some/every/includes。不是完整 TypeScript 编译器；类型标注可写但不进行完整类型检查。

不调用 eval、Function 或 node:vm；禁止循环、递归调用、赋值、异步、网络、模块导入、全局变量和原型访问。解析深度 32、512 个节点，单次执行最多 2000 条指令，数组最多 64 项。错误、非法动作或 null 都会回到原来的决策方式，不伪造行动或通关。

推箱子：每次推动前读取真实棋盘，返回 `availablePushes` 中的 id、`undo`、`restart` 或 null。只读局面沿用现有规则观察，不含出题证明、玩家动作或私聊。寻路与移动仍由游戏引擎执行；整推动撤销遵循同轮整合的推动协议。技能与既有候选预览按顺序工作：技能有合法动作就执行，否则进入原候选预览 / 模型 / 算法。

打拳：输入 `fighterObservation` 的距离、剩余时间和双方可见状态；返回 `idle/advance/retreat/jab/heavy/guard` 或 null。每 0.5 秒判断一次，具体伤害、攻击前摇、范围和胜负仍由拳台引擎裁定。仅应用于宠物控制的拳手，真人操作不经过技能；人宠对抗中的对手宠物使用自己的技能。Node BoxingArena 和同期整合任务提供的 CloudBoxing 均使用开赛快照。

## 示例

推箱子「优先归位」，以下描述与代码合计 **49 token**：

> 优先将未归位的箱子推入目标，避开死角。

```ts
(ctx: SkillContext) =>
  ctx.availablePushes.find(p => p.onGoal && !p.wasOnGoal && !p.corner)?.id ?? null
```

打拳「近身快拳」：

> 远处接近，对手重拳时后撤，否则近身出刺拳。

```ts
(ctx: SkillContext) =>
  ctx.distance > 114 ? "advance" : ctx.opponent.action === "heavy" ? "retreat" : "jab"
```

## 验证与交接

- `test/competition-skill.test.mjs`：6 项，覆盖精确计数与 100/101 边界、禁止能力与执行预算、权限/版本/恢复/私有性、真实双箱通关、快照固定、错误回退、Node 拳台技能控制。通过。
- `test/competition-skill-http.test.mjs`：真实 HTTP 接口身份、计数/保存/拒绝与静态资源。通过。
- `cloud-test/competition-skill.test.mjs`：2 项，跨独立 D1 事务保存/快照/两次技能执行通关与旧版本/超限拒绝。通过。
- `cloud-test/competition-skill-runtime.test.mjs`：实际 Miniflare Worker 打包和执行，中文/TS 精确分词、解释器试运行、D1 保存重读与超限拒绝。通过。
- UI 夹具 `ui-binding/ui-concurrency/completion-ui` 改为移除所有入口 import，而不是假定所有 import 只有一行；相关 23 项回归全过。
- `npm run build` 通过，`npm run check` 在本次检查时扫描 120 文件、0 失败。构建与实际 Worker 测试因 Windows 沙箱目录读取限制在受审核的本地环境执行，无发布动作。
- 浏览器在独立本地测试存档 `http://127.0.0.1:4398` 验证领养、装备、49/100 实时计数、超限禁用保存、保存后属性更新、人宠同时试玩。宠物技能实际使用 2 次，6 步双箱通关；真人棋盘仍为初始状态且可操作。测试使用专门的双箱地图，不能据此证明任意关卡胜率。当前本地预览进程仅作验收，不是线上部署。
- 本次未增加模型自动编写/学习技能流程，使用编辑器装入 TS；没有进行真实付费模型竞技验证，没有自行提交、推送或 Sites 发布。统一整合/发布由另一个用户授权任务负责。

技能槽任务修改清单：`package*.json`；`server/competition-skill.mjs`；`server/arena.mjs`；`server/http.mjs`；`server/provider.mjs`；`server/boxing-arena.mjs`；`cloud/arena.mjs`；`cloud/brain.mjs`；`cloud/step-play.mjs`；`cloud/worker.mjs`；`public/skill-editor.mjs`；`public/skill-editor.css`；`public/index.html`；`public/app.mjs`；`public/companion.mjs`；本节列出的 7 个测试文件和本说明。上述共享文件还包含同时进行的拳台/候选预览整合改动，整合任务需在当前磁盘版本上统一回归。
