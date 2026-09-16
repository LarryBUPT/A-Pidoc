# V4.5 完整受控发布审计

## 改了什么

V4.5 正式版本为 [v0.16.0](https://github.com/LarryBUPT/A-Pidoc/releases/tag/v0.16.0)，发布 commit 为 `9d59bd3612db86e41b2409b5ea6e1da73e51826a`。V4 `v0.11.0` 的行为保留兼容，复杂任务通过 `agent-run` 使用 Pi 自主工具循环，由 API Guardrail、审批恢复、收敛工作区、硬 Evidence Gate 与独立 Reviewer 约束执行和完成。

| 批次 | Issue / 功能 PR | 交付 | 版本 PR / 正式版本 |
| --- | --- | --- | --- |
| PR-1 | [#45](https://github.com/LarryBUPT/A-Pidoc/issues/45) / [#46](https://github.com/LarryBUPT/A-Pidoc/pull/46) | 自有契约与旧行为冻结 | test 提交不发新版本，保留 v0.11.0 |
| PR-2 | [#47](https://github.com/LarryBUPT/A-Pidoc/issues/47) / [#48](https://github.com/LarryBUPT/A-Pidoc/pull/48) | 精确 Pi 0.85.1、低层适配、工具注册、awaited 轨迹 | [#50](https://github.com/LarryBUPT/A-Pidoc/pull/50) / v0.12.0 |
| PR-3 | [#49](https://github.com/LarryBUPT/A-Pidoc/issues/49) / [#51](https://github.com/LarryBUPT/A-Pidoc/pull/51) | 领域护栏、挂起、精确授权重发与防重放 | [#53](https://github.com/LarryBUPT/A-Pidoc/pull/53) / v0.13.0 |
| PR-4 | [#52](https://github.com/LarryBUPT/A-Pidoc/issues/52) / [#54](https://github.com/LarryBUPT/A-Pidoc/pull/54) | 事实工作区、临时投影、无进展与硬证据门禁 | [#56](https://github.com/LarryBUPT/A-Pidoc/pull/56) / v0.14.0 |
| PR-5 | [#55](https://github.com/LarryBUPT/A-Pidoc/issues/55) / [#57](https://github.com/LarryBUPT/A-Pidoc/pull/57) | 实际 HTTP 与隔离仓库迁移工具族、恢复 CLI | [#59](https://github.com/LarryBUPT/A-Pidoc/pull/59) / v0.15.0 |
| PR-6 | [#58](https://github.com/LarryBUPT/A-Pidoc/issues/58) / [#60](https://github.com/LarryBUPT/A-Pidoc/pull/60) | 独立 Reviewer、同条件配对、真实双任务与完整工具映射 | [#61](https://github.com/LarryBUPT/A-Pidoc/pull/61) / v0.16.0 |

两个注册 profile 共用薄 Adapter 与领域治理，12 个工具包括扫描、候选任务、规范、契约差异/影响、HTTP、结构化知识/日志、补丁建议/隔离应用、实际测试与本地报告草稿。候选任务不自动执行；知识/日志默认空，仅读取可信 task scope 或公共 demo；批准后的 publish_report 只写本地 FixtureConnector 草稿，不能证明 API 问题 resolved。

## 为什么

V4 的 Pi 空工具与预计算答案不能证明自主调查。PR-1～PR-4 只建立基础治理，完整 V4.5 还必须具备双工具族、独立语义审查、同条件 Raw Pi 对照与真实模型轨迹。模型决定下一工具，host 控制权限、授权、事实和终态；批准只产生 Grant，模型必须准确重发，不能由宿主代执行或自然语言代替证据。

完成提案工具在 Raw/Harness 两组中都是同一无副作用实现。只有 Harness host 包装硬门禁与独立 Reviewer；Reviewer 无执行工具、独立输入、使用共同预算，最多一次 revise。旧简单固定 case 保留零模型路径。

## 怎么证明

### 发布链与版本一致性

PR #60 最新 head `8cc80dd` 通过 required CI 后 squash 为 `b4ad177b5fcc9c8758c9f901128f932990b25e15`；main CI 与 Release Please 成功。版本 PR #61 的最新 head `4e6caef8a03ad7705f736baf914820cfd983f361` 通过 [required CI](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35081606136)，且 dispatch status 同为 success，随后 squash 为发布 commit `9d59bd3`。

版本 PR 仅改变 `.release-please-manifest.json`、`package.json`、`package-lock.json` 与 `CHANGELOG.md`。manifest、package 与 lock 两处版本均为 0.16.0；依赖保持精确 Pi 0.85.1，没有 npm 包发布。发布 commit 的 [main CI](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35104816025) 成功后 Release Please 创建 tag 与非 draft、非 prerelease 的 GitHub Release；tag 指向上述完整发布 commit，CHANGELOG 对应 PR #60。

发布 commit 的 [Release Please](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35105026335) 同样成功，Release 的 `target_commitish` 与本地 `v0.16.0^{commit}` 均为完整发布 SHA。后续 docs 提交只整理公开事实，不移动历史 tag、不重新冻结实验、不触发新版本。复核实际对象可运行：

```bash
git fetch origin main --tags
git rev-parse v0.16.0^{commit}
git show v0.16.0:package.json
git show v0.16.0:.release-please-manifest.json
git show v0.16.0:CHANGELOG.md
```

### 离线与实际工具验证

完整功能封版通过 144 项自动测试、三轮 Pi Tier A、三轮 Harness 合同、旧 Repository/Contract/Collaboration 评测与生产依赖审计（0 vulnerabilities）。历史业务集为 26/26；它使用确定性 Reasoner，与新配对数据集口径不同。

[offline 原始逐例结果](evidence/v45-paired.json) 是 9 类 × 3 轮 × Raw/Harness 两组的 54 条，同模型、基础提示、工具 Schema/描述/实现、任务数据和预算，并自动核对 hash。两组正常任务各 9 次成功；Harness 未授权实际执行 0、正常任务误拦 0；有效引用的虚假生产主张被 Reviewer 阻断，缺证保留 unresolved，未授权迁移保留 waiting_approval。Raw 的风险动作仅在共同隔离沙箱中评分，不接触生产。

faux Token/费用是模拟统计，引用有效率不等于语义准确率；这组固定合同不能用于估计泛化模型成功率。完整命令与退出信号见 [验证指南](verification.md)，实验方法见 [Reviewer/配对评测](reviewer-evaluation.md)。

### 真实模型与失败记录

最终07的 [live 脱敏证据](evidence/v45-live.json) 使用 DeepSeek `deepseek-v4-pro`，两个任务均 resolved 且独立 Reviewer pass。原私有报告 SHA256 为 `3cfbb6e3deb039ad0ef734aea2f0fa48c759a7abb16f44b762766cd4c1106021`。

| 任务 | 模型回合（含 Reviewer）/ 工具调用 | Token | 耗时 | SDK 估算费用 | 实际结果 |
| --- | --- | --- | --- | --- | --- |
| runtime-api | 6 / 7 | 12,661 | 17,979 ms | $0.004101267 | 同目标 415→200；本地响应仅验证请求，不创建订单 |
| repository-contract | 13 / 14 | 43,098 | 37,454 ms | $0.011029077 | 两次准确批准重发、隔离补丁、实际测试退出码0且测试数为正、磁盘核验 |

01～04、06 共五次失败预跑与较早05成功记录保留在私有目录。问题包括完成包缺 HTTP ID、impact row 与 Artifact ID 混淆、Reviewer 数组 Schema 错误、合法核对/提交被误算无进展，以及新增工具后重复核对/未请求批准/未知工具。修正字段说明、意图协议和 inspection/submit 合同后重新验收，未降低硬 Gate、错误工具阻断或重复观察限制。公开摘要包含原报告 hash 和脱敏轨迹；完整敏感报告与凭据不进入 Git。

## 尚未解决

完整受控 V4.5 不代表任意企业 API 语义正确率、真实平台采纳、用户 ROI 或生产 SLO。首版全局 sequential，Reviewer 仍可能误判；成本为 SDK 元数据估算，单次 live 不是稳定性或节约比例。未实现真实平台网络写回、生产部署/数据库、调度队列与常驻监控、向量 RAG、管理 UI、并发效果、端边云推理或生产 Exactly-once。

下一阶段是独立的 V5 设计与验收节点，不用另一套确定性主循环替代已建立的 Agentic 控制面。
