# 双 Agent 评审工作流

本目录提供中文协作规则和可复用模板。实际项目评审材料默认保存在 Git 忽略的 `.private/review/current/`，不会随正常提交上传。

1. 人工确认已有问题范围，Codex 固定 Git 基线并准备 CURRENT_BASELINE.md。
2. 在 Claude Code 中运行 `/review-issues`，逐项鉴定问题并输出 REVIEW.md。
3. 人工决定存在需求取舍的问题；Codex 只修复已确认且获准处理的问题，输出 FIX_REPORT.md。
4. 在 Claude Code 中运行 `/verify-fixes`，只复核这些问题，输出 VERIFICATION.md。
5. 未通过的编号返回修复；通过且满足现有贡献门禁后提 PR，由 CI 检查后合并。

这是一套通过文件交接的协作流程，需要分别向两个 Agent 发出任务，不会自动共享聊天或自动轮流启动。

- [评审与验收指南](REVIEW_GUIDE.md)
- [基线与问题清单模板](templates/CURRENT_BASELINE.md)
- [问题鉴定模板](templates/REVIEW.md)
- [修复报告模板](templates/FIX_REPORT.md)
- [修复复核模板](templates/VERIFICATION.md)
- [Issue #80：审计元数据需求](audit-metadata-requirements.md)
- [Issue #80：需求评估](audit-metadata-assessment.md)
- [Issue #80：实施证据](audit-metadata-evidence.md)

Claude Code 的认证、本机终端配置和实际演练说明保存在私有本地材料中；用户 README 继续服务项目使用者。

## Issue #80：可选的本地审计元数据

此模式在上述四文件旁增加机器块、私有状态、公开最小摘要与终端指标。它不启动 Agent、不调用模型，也不改变现有交付 CI 或发布流程。准备时必须明确选择本轮已有主题，不默认对整个仓库审计：

```bash
npm run audit:prepare -- --topics AUDIT-001
# 补齐 CURRENT_BASELINE.md 的来源、断言与边界；Reviewer 写 REVIEW.md
npm run audit:advance
# Codex 独立核验并写 FIX_REPORT.md
npm run audit:advance
# Reviewer 独立复核并写 VERIFICATION.md
npm run audit:advance
npm run audit:advance
npm run audit:summary
npm run audit:validate
npm run review:metrics
```

脚本不会帮角色生成鉴定、修复或复核结论，也不会授予产品修改权限。未能安全继续时可执行 `npm run audit:stop -- --reason agent_unavailable`（或 `unsafe`、`terminated`），合法 `incomplete` 摘要可生成，但不代表问题已解决。第二轮只针对复核确认的可重修残余缺陷；状态文件和原报告保存在 `.private/review/current/`，首轮报告另作不可覆盖快照。

已有 PR 时可在准备阶段传入真实 PR 编号 `--pr <number>`；Issue 编号不是 PR 编号，未创建 PR 时保持 `null`。

历史 current 缺少机器状态时，脚本拒绝覆盖。人工核对并显式执行 `npm run audit:archive -- --legacy` 后才可创建新轮次；活动轮次不能归档重置预算。生成的 `.review/review-summary.json` 只包含白名单元数据与统计，提交前仍需人工检查公开内容。格式、分类和状态解释见[需求文档](audit-metadata-requirements.md)与[评估说明](audit-metadata-assessment.md)。
