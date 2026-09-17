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

Claude Code 的认证、本机终端配置和实际演练说明保存在私有本地材料中；用户 README 继续服务项目使用者。
