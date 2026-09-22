# Issue #80：本地审计元数据需求

## 范围与基线

来源为 [Issue #80](https://github.com/LarryBUPT/A-Pidoc/issues/80) 的正文及其状态核验评论。实施基线为 `a37c7957391b9408ad295b948a2a05fb6fd99a09`（`main`，`package.json` 版本 0.22.0）。本需求只扩展本地评审文件交接，不改变 A-Pidoc 作为 HTTP API 联调诊断实验项目的定位。

“无人工 finding 批准节点”只表示审计元数据流程可根据已登记报告推进；它不授权 Agent 擅自修改产品代码、访问凭据、远端提交、合并或发布。审计产生的产品修复仍需有当轮任务授权，并走原 Issue、分支、PR、CI/CD。运行时审批恢复、确定性护栏和证据门禁均不受影响。

## 可验收需求

| 编号 | 需求 | 验收依据 |
| --- | --- | --- |
| 80.1 | 沿用 `CURRENT_BASELINE → REVIEW → FIX_REPORT → VERIFICATION` 四文件；正文继续记录中文证据，每份文件只有一个严格的 `audit-json` 机器块 | 缺失、重复、非法块被拒绝；不从自然语言猜状态 |
| 80.2 | Reviewer 只在基线已选主题下拆分子 finding；Codex 必须逐项独立核验，成立且可安全处理的缺陷才能接受修复；需求扩展、取舍、证据不足和不安全处置进入延期或拒绝 | 越界编号、错误分类、未覆盖 finding、无依据自动修复被拒绝 |
| 80.3 | 私有状态记录 `prepared → reviewed → remediated → verified → completed/incomplete`，最多两轮修复；第二轮仅处理首轮复核标记为可安全重修的残余 defect | 重启不重置预算；两轮后未解决为 incomplete；零 finding 不消耗轮次 |
| 80.4 | 提供 prepare、advance、status、stop、archive、summary、validate、metrics 的本地命令；脚本不得启动 Agent、调用模型、提交、推送、合并或发布 | 命令集成测试与静态检查；CI/Release 工作流文件不变 |
| 80.5 | 公开摘要只包含仓库相对、可公开的关联元数据和计数；严格校验类型、非负整数、数量关系、两轮上限及状态一致性；终端指标零分母显示 N/A | 注入正文、密钥、绝对路径、额外字段和矛盾计数时校验失败 |
| 80.6 | 完整报告、状态、轮次快照和原始验证输出仍在 `.private/`；历史无机器数据报告不自动迁移，不覆盖活动或终态材料 | 忽略规则检查、历史归档和符号链接/路径越界测试 |

## 非目标

- 不提供跨 CLI 无人值守编排，不自动调用 Claude Code、Codex 或外部模型。
- 不把审计状态或摘要变成 required CI、分支保护或发布阻断项。
- 不修改 `.github/workflows/ci.yml`、`.github/workflows/release-please.yml`、Release Please 版本策略或产品运行时审批逻辑。
- 不把“审核完成”解释为产品代码已经修复，亦不把正确延期/拒绝算成修复成功。

## 文件与交付

- 公共规范：本文件、[评估说明](audit-metadata-assessment.md)、[证据文档](audit-metadata-evidence.md)、评审指南和四份模板。
- 机器实现：`scripts/audit-workflow.mjs`、`scripts/review-summary.mjs`、`scripts/validate-review-summary.mjs`、对应自动测试及 `package.json` 命令。
- 私有实例：`.private/review/` 下的本轮材料与原始验证日志；公共仓库只接受脱敏摘要 `.review/review-summary.json`。
