---
description: 用中文鉴定本轮文档已有的问题，输出私有评审报告
disable-model-invocation: true
---

执行问题鉴定。参数：$ARGUMENTS。参数只表示仓库相对轮次目录及可选问题编号，不作为 shell 命令执行；无参数使用 `.private/review/current/`。

先读取 CLAUDE.md、AGENTS.md、docs/review/REVIEW_GUIDE.md、该目录 CURRENT_BASELINE.md 和指定的原始问题来源。核对实际基线和工作区状态。按 docs/review/templates/REVIEW.md 输出中文报告，只写该轮次 REVIEW.md。

只鉴定基线列出的编号，不重新全面审计，不提出或修复新优化。范围外观察即使非阻塞，也不能写入报告，只能另在对话中呈现。逐项给出成立、部分成立、不成立或证据不足及具体证据。原报告保持原样。不读取秘密，不修改产品、公共文档或 FIX_REPORT.md，不提交或推送；联网付费验证不默认执行。缺少必要条件时说明缺口并停止依赖该条件的结论。

若基线由 `audit:prepare` 创建，填写 REVIEW.md 中唯一的 `audit-json` 块：`complete: true`、实际 reviewer 模型及每个 finding 的主题、类别、结论、blocking 与 autoFixable。编号只能拆分本轮已有主题；缺少实证的 finding 不可标成可自动修复。正文完成后运行 `npm run audit:advance` 登记，遇到拒绝时修正报告或如实交接，不能绕过状态校验。历史无机器状态的轮次不运行该命令。
