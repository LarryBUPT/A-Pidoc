# PR-5：实际 API 工具族与两个任务竖切

## 改了什么

ApiHarnessRuntime 组合 PiLoopAdapter、ApiGuardrail、ConvergentWorkspace、ContextProjector 和 EvidenceGate。Lead 从实际观察选择工具；共享提示只说明目标、引用和审批协议，不给固定工具数组或最终答案。旧工作流保留，领域工具直接复用 scanner、OpenAPI diff、impact analysis、lossless patch 和固定 Node test runner。

runtime-api 注册只读的 loopback `/orders` 验证服务，实际 HTTP 可复现媒体类型错误或字段类型错误。read_api_document 暴露 operation/schema，execute_http 由模型选择请求参数，read_evidence 查看实际 Artifact，submit_completion 提交硬门禁。这个 POST 不创建订单，行政配置 sideEffectFree；任意企业 POST 不自动继承此豁免。Guardrail 拦截 DELETE、operation 不符和越界网络，后端也有相同沙箱边界、禁重定向、5 秒超时与 8 KiB 响应上限。

repository-contract 提供 scan_repository、compare_contracts、analyze_contract_impact、propose_patch、apply_patch_isolated、run_regression_tests。参数使用本 run 的实际 Artifact ID，不接受模型路径、补丁文本或任意 shell。patch 与 tests 各需要独立认证审批和 Pi 原参数重发；复制到全新隔离目录后应用受支持的无损字面量变更，扫描实际修改后的调用，生成固定断言并启动独立 Node 子进程。

## 为什么

固定 Orchestrator 的分支不能证明工具结果会影响模型下一步。提供有界事实摘要与 read_evidence 实际内容才能让投影后的模型继续判断；完整报文仍只在 Artifact 中。只有已执行工具可以产生证据，退出码与 TAP 报告中的实际测试数共同用于终态，避免空测试 exit 0。

注册仓库限制 200 文件、单文件 1 MB并拒绝符号链接；原仓库、契约与当前隔离目录摘要参与审批前置条件，执行锁内重新计算。测试证据保存 sourceDigest/workspaceDigest，完成时从磁盘重算，重启后也不将变化后的源文件重新视为原基线。自然语言结束且未提交有效完成包归为 unresolved。

## 怎么证明

`node --test dist/test/api-tool-bundles.test.js` 覆盖真实 HTTP 415→200、两次审批/真实隔离测试/source 不变、授权后文件漂移、DELETE 执行前阻断、隔离路径与恢复核验。离线模型是 faux，工具后端是真实 HTTP/文件/测试；这证明集成合同，模型自治与独立 Reviewer 证据继续由 PR-6 提供。

先 `npm run build`，本地忽略的 `.env` 配置真实 provider/key 后运行：

```powershell
node --env-file=.env dist/src/cli.js agent-run --profile repository-contract --run .private/runs/migration.json
node --env-file=.env dist/src/cli.js agent-approve --run .private/runs/migration.json --approval <报告中的准确审批ID>
node --env-file=.env dist/src/cli.js agent-resume --run .private/runs/migration.json
node --env-file=.env dist/src/cli.js agent-run --profile runtime-api --run .private/runs/runtime.json
```

CLI 审批身份来自本地 OS 会话，显式 approval ID 代表用户授权该项；不能使用模型生成的“批准”消息代替。远程应用必须注入实际认证 authorizer。runtime 沙箱进程结束即关闭，不能跨进程继续 HTTP 任务；契约 run 可从同一快照恢复。预算随快照累计，不因审批或重启重置；没有自动 fallback。

## 尚未解决

目前注册两个受控任务 profile；不支持任意真实企业环境、任意源代码执行或复杂迁移的语义正确性。单写入 action lock 不承诺外部进程遵守锁，也不等于 Exactly-once。[PR-6](reviewer-evaluation.md) 补充独立 Reviewer、同条件 Raw Pi 对照及真实 DeepSeek 证据；离线本文件集成测试中的语义 stub 不作为真实审查收益。
