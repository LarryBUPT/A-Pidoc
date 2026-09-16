# V4.5 Agentic Harness 迁移与验证

## 改了什么

V4 `v0.11.0` 保留为已发布的团队协作技术验证。新增 A-Pidoc 自有 Task、Tool、Budget、Trajectory、Approval 与 API 状态/证据契约；领域工具不依赖 Pi 消息类型。

## 为什么

V4 的 `PiReasoner` 注册空工具，并接收唯一预计算根因/动作；Repository、Contract、Collaboration 仍是确定性工作流。Pi SDK 契约通过不能证明模型自主调查。迁移让 Pi 负责规划、工具选择和观察后修正，让 API 约束层负责权限、审批、预算、状态和完成条件。

## 怎么证明

PR-1 保持 Pi `0.74.2`，通过 characterization tests 冻结公开报告字段、`415 → 200` 和 V2～V4 输出。PR-1 已通过 PR #46 合并；PR-2 升级与运行协议见 [Pi 0.85.1 RFC](pi-0.85.1-rfc.md)。旧 CLI 和既有 eval 保留。

| 批次 | 交付 | 完整版本依赖 |
| --- | --- | --- |
| PR-1 | 自有契约、旧行为冻结 | 不改变运行时、不升级依赖 |
| PR-2 | 精确 Pi `0.85.1`、RFC、低层 loop、registry、awaited trajectory | release 实际契约与多轮 faux 轨迹 |
| PR-3 | API Guardrail、审批挂起与精确重入 | 原子落盘、有效期/防重放/前置条件、最多一次纠偏 |
| PR-4 | 收敛工作区、临时上下文投影、Evidence Gate | 状态版本分离、缺证拒绝 resolved |
| PR-5 | HTTP 诊断与仓库契约迁移工具 | 两类任务复用同一运行带、真实工具结果 |
| PR-6 | 独立 Reviewer、配对评测、受预算 live | 逐例指标、真实 DeepSeek 轨迹、完整发布审计 |

## 尚未解决

PR-1 已合并，PR-2 提供低层多轮运行带。PR-1～PR-4 是基础治理节点；完成它们不等于 V4.5 整体完成。未完成两任务族、独立 Reviewer、Raw Pi/Harness-Pi 同条件实验与真实 DeepSeek 发布前验证，不得宣称完整 V4.5。并发契约仅预留，首版全局 sequential。无真实企业采纳率、生产部署、向量数据库、端边云推理或高并发效果证据。
## PR-3 审批治理

完整状态机、作用范围、精确重入与失败合同见 [审批协议](approval-protocol.md)。批准只创建 Grant；模型必须重新调用原工具。执行结果不明保留接管标记，不能用自然语言或授权消费代替执行证据。
## PR-4 状态与证据治理

收敛归约、临时上下文投影、证据包关联和 final Artifact 见 [工作区与证据门禁](workspace-evidence.md)。目前已推进基础治理四批；双 API 工具族、真实模型/Reviewer/配对评测仍须分别验收。

实际 API 工具族见 [PR-5](api-tool-bundles.md)。注册两个 profile 共用同一 Lead 提示与循环；真实工具可生成 HTTP、隔离补丁、Node 测试和磁盘摘要证据，离线 faux 不代表 live 模型验收。
