# PR-2：Pi 0.85.1 运行兼容性 RFC

## 改了什么

从精确 `0.74.2` 升级 `@earendil-works/pi-agent-core` 与 `pi-ai` 到精确 `0.85.1`；直接使用同版 `typebox@1.3.7` 构造工具 Schema。lockfile 固定完整依赖树。运行要求改为 Node.js 22.19+，CI 使用 Node 22。新增 PiLoopAdapter、ToolRegistry、TrajectoryStore、规范化摘要与可控多轮轨迹测试。

## 为什么

设计参考 `main@3349e1db`，交付以稳定 tag `v0.85.1@d981de1` 为准。低层 loop 让 A-Pidoc 显式持有快照、awaited 事件屏障和继续入口；不是因为高层 Agent 缺失 stop hook。官方 release 已把旧全局模型目录/stream/faux 注册移到 `/compat`；旧 Reasoner 暂用官方桥接，新 Adapter 只接显式注入的 stream，不维护私有补丁。

## 怎么证明

上游核验：[release types](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/types.ts)、[release loop](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent-loop.ts)。实际包 exports、类型与 npm engines 已核对。

| 生命周期契约 | release 实际语义 | 本项目验证/控制 |
| --- | --- | --- |
| runAgentLoop/runAgentLoopContinue | emit 在 signal/stream 前，sink 返回 Promise 时等待 | 直接 await run；落盘后才能进入下一 provider |
| continue | 空历史与 assistant 尾部被拒绝 | 标准 user/toolResult 尾部；重建 Adapter 保留历史 |
| beforeToolCall | Schema 后运行，block 走 immediate error | 结果仍由 sink 记录；PR-3 在前置钩子原子挂起 |
| afterToolCall | 已执行工具才经过；不能治理之前副作用 | 默认只读路径；非 read 工具要求领域 Guardrail |
| terminate | 只有本批全部 terminating 才结束后续工具循环 | 混合批次依赖状态检查与 shouldStopAfterTurn |
| shouldStopAfterTurn | turn_end 后、下一 provider 前；正常 agent_end | waiting_approval 不 abort、不额外模型调用 |
| transformContext | 临时视图，不修改事实源 | 投影失败回退原消息；PR-4 增加有界安全投影 |
| execution | 默认 parallel | 全局/转换工具均 sequential，parallelSafe 不能授予并发 |
| provider API | root 改为显式 Models/provider；旧 API 在 compat | 旧路径只改官方 import，局部契约测试通过 |
| durable transcript | 消息落盘不依赖 EventStream 观察消费者 | message_end 保存；stream delta 不反复写文件 |

TrajectoryStore 使用同目录临时文件、文件 fsync、原子 rename 与 mkdir 排他锁。CAS 按 stateRevision 防覆盖；同一 run 的 runner lease 防止两个 loop 交错。陈旧锁不自动窃取，需人工核验。错误转换为稳定公开码；原始 provider/tool 异常不进入快照。预算与已用模型/工具次数、Token/估算费用、活动时长可持久恢复。

## 尚未解决

PR-2 本批次只证明 provider、多轮工具轨迹、持久化和串行协议；后续 domain preflight/审批、事实/Gate、实际双工具族与 Reviewer/offline/live 分别见 PR-3～PR-6 文档与证据。文件 fsync + rename 不等于跨存储生产事务；SDK 估算费用不是账户硬账单预算；进程崩溃留下 runner 锁时须先检查，不自动重放副作用。
