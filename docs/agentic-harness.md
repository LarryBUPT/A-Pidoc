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

V5的计划与Queue/Worker是运行带之外的触发层，复用上述治理合同，附加取消信号和安全continue；不引入第二套模型工具循环或一次迁移全部API工具。历史监控快照与当前HTTP事实分开，原监控合同复查是Worker完成条件，详见 [V5持续可靠性](reliability-v5.md)。生产队列、长期SLO与企业账号仍不在已验证范围。

PR-1～PR-6 已完成完整受控 V4.5，正式版本为 `v0.16.0`；required CI、版本 PR #61、tag/Release/main 一致性见 [发布审计](v45-release-audit.md)。公开证据见 [offline](evidence/v45-paired.json) 与最终07的 [live](evidence/v45-live.json)。并发契约仅预留，首版全局 sequential。无真实企业采纳率、生产部署、向量数据库、端边云推理或高并发效果证据。
## PR-3 审批治理

完整状态机、作用范围、精确重入与失败合同见 [审批协议](approval-protocol.md)。批准只创建 Grant；模型必须重新调用原工具。执行结果不明保留接管标记，不能用自然语言或授权消费代替执行证据。
## PR-4 状态与证据治理

收敛归约、临时上下文投影、证据包关联和 final Artifact 见 [工作区与证据门禁](workspace-evidence.md)。PR-1～PR-4 只构成基础治理；双工具族/Reviewer/offline/live 的后续证据不能被基础版本替代。

实际 API 工具族见 [PR-5](api-tool-bundles.md)。注册两个 profile 共用同一 Lead 提示与循环；真实工具可生成 HTTP、隔离补丁、Node 测试和磁盘摘要证据，离线 faux 不代表 live 模型验收。

PR-6 采用[独立 Reviewer 与配对评测](reviewer-evaluation.md)。完成工具为相同的无副作用 proposal 实现；host 包装核验硬门禁并单独审查语义。完整 V4.5 的验收以实际 offline/live 发布证据为准。

## V5 调查收敛看板补充

重新执行live时出现重复读取、NO_PROGRESS_LIMIT接管。看板现在公开持久事实中的inspected状态和既有完成合同；压缩降级仍保留目标、预算、无进展计数。监控任务允许有证据的UNKNOWN根因与局部观察，不能伪造生产恢复。模型自主选工具，原Evidence Gate、Reviewer、审批与无进展上限保持不变；失败尝试与最终验收分开保留，不能据单次成功宣称根因已唯一定位或稳定成功率，见 [本次验收记录](evidence/v5-performance-live.json)。
