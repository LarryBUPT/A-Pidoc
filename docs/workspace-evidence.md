# PR-4：收敛工作区与证据终态门禁

## 改了什么

ConvergentWorkspace 将实际执行工具的结构化结果归约为 API 事实；ContextProjector 生成有界临时视图；EvidenceGate 校验任务证据包并保存脱敏 final Artifact。旧命令保留，PiLoopAdapter 内没有 HTTP/OpenAPI 分支或固定工具顺序。

## 为什么

消息总结不能作为事实源，历史报文无限追加会消耗上下文，模型填写 exit 0 不能替代测试。通过工具调用 ID、来源和 hash 绑定证据，区分“调查进度”“已验证事实”和“允许结束”，避免把自然语言成功当成实际完成。

## 怎么证明

| 控制 | 行为 | 验证 |
| --- | --- | --- |
| stateRevision | 全部事务 CAS 时钟 | 日志、策略、审批与工具归约单调递增 |
| workspaceRevision | 控制面/隔离文件变更 | patch/test 的实际写入递增；旧 Grant 不可复用 |
| evidenceSequence | 追加观察/证据/审计时钟 | 不等于已确认事实数量，也不作为授权失效版本 |
| Evidence provenance | 工具元数据声明证据类型、真实 call/result、独立 Artifact hash | 未执行/错误结果、ID 冲突和 hash 篡改不能有效引用 |
| Context | 阶段、剩余预算、最多 24 条证据看板、8 条未决假设、审批摘要 | 裁剪仅临时视图；工具协议成对；原快照与 Artifact 不修改 |
| No progress | 语义事实摘要去重，默认连续三次无新事实停止 | 重复观察仍可审计但不冒充进展 |
| Evidence maturity | 隔离变更、失败后回退、完成后 verification_passed | 状态不规定必须执行哪个工具数组 |

运行时诊断需要错误复现、同目标且匹配的 OpenAPI operation、后续成功 HTTP 观察、有效 claim 引用；最后成功必须是该目标最近的观察。含副作用观察还要对应已消费且确认执行的授权。

契约迁移需要稳定 diff、关联影响、隔离 patch、patch 之后的测试，命令摘要、正整数测试数和真实 exitCode 0；模型字段必须与真实数据一致。patch/test 与同一 diff/patch ID 绑定，所有写入均要匹配 run、参数摘要、环境、执行前 workspaceRevision 和执行时有效 Grant。注册后端必须在完成前重验当前隔离工作区，未提供 verifier 不能 resolved。后端真实文件核验由 PR-5 接入。

waiting、pending-reissue、blocked 或 executionInDoubt 不可 resolved。Reviewer 的 pass 不覆盖硬门禁；Gate 只做结构、来源、关联与约束检查，语义“证据是否支持主张”仍需 PR-6 Reviewer，不能将有效引用等同于任意语义事实正确。完成时保存 final Artifact，重复相同完成请求可幂等读取；报告证明观察时结果，不承诺以后 API 一直健康。

`node --test dist/test/workspace-evidence.test.js` 的 13 项合同覆盖来源/恢复、HTTP 对应、缺证/伪引用/hash、审批终态、上下文边界、假设、无进展、版本、迁移关联/退出码/审批、当前工作区 verifier、投影失败与完成阶段不回退。`npm run eval:harness` 连续三轮重跑 loop + approval + workspace/evidence。

## 尚未解决

PR-4 本批次是基础治理合同；后续 [PR-5](api-tool-bundles.md) 提供实际 HTTP/隔离测试/文件 verifier，[PR-6](reviewer-evaluation.md) 提供独立 Reviewer、真实模型重发与配对结果。完成 PR-1～PR-4 不等于完整 V4.5；后续全部受控验收也不等于生产安全、任意 API 语义验证或 Exactly-once。
