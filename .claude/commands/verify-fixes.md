---
description: 用中文复核本轮已确认问题的修复，输出私有复核报告
disable-model-invocation: true
---

执行修复复核。参数：$ARGUMENTS。参数只表示仓库相对轮次目录及可选问题编号，不作为 shell 命令执行；无参数使用 `.private/review/current/`。

先读取 CLAUDE.md、AGENTS.md、docs/review/REVIEW_GUIDE.md、该目录 CURRENT_BASELINE.md、REVIEW.md 和 FIX_REPORT.md，核对实际修复提交或记录的差异。按 docs/review/templates/VERIFICATION.md 输出中文报告，只写该轮次 VERIFICATION.md。

只复核指定且已确认的问题成立部分，不发散优化，不自行修复。逐项给出通过、未通过或无法验证、差异位置、实际命令结果和残留限制。范围外观察即使非阻塞，也不能写入报告，只能另在对话中呈现。未运行不得声称通过。不覆盖其他报告，不读取秘密，不修改产品或公共文档，不提交或推送；联网付费验证不默认执行。
