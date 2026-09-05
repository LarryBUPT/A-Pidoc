# A-Pidoc 构建日志：V0 → V1-A → V1-B → V2

本文是事实日志，不是产品规划。版本、提交、Issue、Pull Request（拉取请求，简称 PR）和 Release（发布版本）均来自当前 Git 历史或 GitHub 记录。HTTP（Hypertext Transfer Protocol，超文本传输协议）、JSON（JavaScript Object Notation，JavaScript 对象表示法）、OpenAPI（OpenAPI Specification，开放接口规范）、Agent（智能体）和 Reasoner（推理器）沿用项目代码中的含义。

## 工作流先导

项目采用 GitHub Flow（以短分支和 PR 为中心的协作流程）与 CI/CD（Continuous Integration / Continuous Delivery，持续集成与持续交付）：

```mermaid
flowchart LR
    A[Issue 写验收标准] --> B[短分支]
    B --> C[代码与测试]
    C --> D[npm ci + check]
    D --> E[Conventional Commit]
    E --> F[PR + Closes Issue]
    F --> G[GitHub Actions CI]
    G --> H[Squash Merge]
    H --> I[Release Please PR]
    I --> J[Tag + GitHub Release]
```

- **Issue**：把“想做什么”变成可以检查的清单。
- **Conventional Commit**：使用 `feat:`、`fix:`、`docs:` 等固定前缀的提交规范，供自动发布判断版本级别。
- **Squash Merge**：把一个 PR 的提交压成一个主分支提交，保持历史可读。
- **Release Please**：根据提交规范自动更新版本号和 CHANGELOG，并创建发布 PR。

### 工作流为什么适合这个项目

1. Agent 行为有不确定性，必须先写固定输入和预期结果。
2. 网络工具有安全风险，必须让安全测试成为合并门禁。
3. 单人项目也需要可追溯证据，否则面试时只能讲结果，讲不清决策。
4. 文档提交使用 `docs:`，默认不产生新产品版本；功能提交使用 `feat:`，产生次版本号。

### 工作流仍然没有自动解决什么

- required CI 使用官方 Pi Agent 的可控 provider，不调用公网模型，不能代表真实模型线上效果。
- 自动测试能证明已写入的验收标准，不能证明遗漏的业务需求。
- Release 成功只代表版本可追溯，不代表已经生产部署；仓库当前没有部署目标。

## 时间线

| 产品阶段 | 关键提交 / PR | 发布 | 阶段结论 |
| --- | --- | --- | --- |
| V0 | `48a849b` 初始闭环；后续改名和首次发布配置 | `v0.1.0` | 固定数据可以跑通诊断、修复、重试、复核 |
| V1-A 前置 | PR #3，`3dce097` | `v0.2.0` | 增加 curl parser 和受控真实 HTTP 基元 |
| V1-A 完成 | Issue #1；PR #11，`fa7aeb3` | `v0.3.0` | curl/OpenAPI 进入同一真实执行链路，但没有 Pi |
| V1-B 完成 | Issue #13；PR #14，`ddfee2e` | `v0.4.0` | Pi Reasoner、Prompt、输出约束、降级和三轮评测接通 |
| 文档事实化 | Issue #16 | 不发产品版本 | 公开当前事实，私有保存个人规划 |
| V2 | Issue #21；PR #22；仓库预检实现与固定 fixture | `v0.5.0` | 从源码定位 fetch、OpenAPI 差异和环境变量缺口，默认不执行 |

## 2026-09-05：V0，先证明闭环能跑

证据：提交 `48a849b feat: initial API Doctor V0`，首次正式标签 `v0.1.0`。

### 改了什么

- 定义 `ApiRequest`、`HttpResult`、`Diagnosis`、`FixAction`、`DebugReport` 等统一类型。
- 建立 `DebugOrchestrator` 主循环。
- 实现确定性 Reasoner、规则检索、EvidenceReviewer、TraceRecorder 和 RequestPolicy。
- 用 FixtureHttpTool 构造 401、415、422、405、429 和健康请求六类固定案例。
- 建立命令行、HTTP 服务、测试、GitHub Actions 和 Release Please 基础配置。
- 添加 `.pi/skills/api-doctor/SKILL.md`，记录领域工作流，但当时没有 Pi 运行时。

### 为什么这样改

第一次只验证一个最小问题：给定完全可控的失败请求，程序能否执行、诊断、只改一步、重试并复核。真实网络和真实模型同时接入会增加两个不稳定源，无法快速判断错误来自工作流还是外部服务。

### 怎么证明它有效

- `npm run demo` 能让六个 Fixture 走完主循环。
- `test/orchestrator.test.ts` 检查根因、修复结果、越权 Host 和 Trace 顺序。
- `v0.1.0` 表明首次发布链路可以生成可追溯标签。

### 这一步还没有解决什么

- 不接受真实 curl 或 OpenAPI。
- 不发送真实网络请求。
- 没有 Pi 模型调用。
- Skill 文件只是一份领域说明，未连接运行时。
- Reviewer 只做基础证据检查。

### 本阶段遇到的问题与风险

- 初始提交同时包含业务代码、CI、Skill 和大量个人规划文档，改动面很大，不利于审查。
- 项目最初仍叫 L-Pilot，随后用 `aaff322` 改名为 A-Pidoc，说明产品定位在初次提交后才收敛。
- 首次 Release Please 需要在没有自定义 Token 时也能运行，因此增加 `f377278` 修复并发布 `v0.1.0`。

## 2026-09-05：V1-A 前置，先接真实输入基元

证据：PR #3，提交 `3dce097 feat: add guarded curl and HTTP input primitives`，发布于 `v0.2.0`。

### 改了什么

- 新增 curl parser，把命令转换为统一 `ApiRequest`。
- 新增 RealHttpTool，加入 Host allowlist、超时、响应大小限制和脱敏。
- 增加真实输入单元测试。

### 为什么这样改

先把“解析真实请求”和“安全发送请求”做成可独立测试的基元，再接入主循环。这样错误可以定位在 parser、tool 或 orchestrator 中，而不是一次排查整条链路。

### 怎么证明它有效

- `test/real-input.test.ts` 验证 curl 解析和真实本地 HTTP 行为。
- PR #3 经过 CI 后合并。
- `v0.2.0` 包含这些基元。

### 这一步还没有解决什么

- curl 和 RealHttpTool 尚未完整接入 CLI、HTTP API 与修复重试闭环。
- 没有 OpenAPI operation 输入。
- 没有 Pi。

### 本阶段遇到的问题与风险

Release PR 的 required CI 没有正常触发。Issue #5 后连续出现三个修复提交：

1. `6e04909`：为 Release Please PR 主动 dispatch required CI。
2. `4443f1c`：补传 repository 参数。
3. `39a8753`：补发仓库规则识别的 commit status。

这说明 CI/CD 本身也需要测试。只写 YAML 文件不等于工作流真的能被分支保护规则识别。

## 2026-09-05：公开仓库边界修正

证据：PR #10，提交 `2eec403 docs: keep maintainer notes out of public repository`。

### 改了什么

移除 Git 中的个人维护资料，并让 `docs/` 整体进入 `.gitignore`。

### 为什么这样改

求职分析、个人差距和未来规划不应与开源产品当前能力混在一起。

### 怎么证明它有效

从该提交直到 `v0.4.0`，`git ls-files docs` 为空，GitHub 不再公开私人资料。

### 这一步还没有解决什么

整个目录被忽略也使架构、构建日志和面试材料无法选择性公开。Issue #16 才进一步拆成公开 `docs/` 与本地 `.private/`。

## 2026-09-05：V1-A，把真实输入接入闭环

证据：Issue #1、PR #11、提交 `fa7aeb3 feat: complete guarded V1 input workflow`、发布 `v0.3.0`。

### 改了什么

- 把 `DebugTask` 与固定评测预期分离，让真实输入不依赖 Fixture。
- 新增 OpenAPI 3.x operation parser 和基础 JSON Schema 校验。
- curl、OpenAPI 同时进入 CLI 与 HTTP API。
- RealHttpTool 接入诊断、修复、重试和 Reviewer 主循环。
- 增加 URL 凭据阻断、Header/body/query 脱敏和 Trace 元数据。
- 增加本地 Mock API 与可复现示例。

### 为什么这样改

V0 只能证明算法骨架；V1-A 要证明用户自己的请求能进入相同链路，并且网络执行仍受服务端策略控制。

### 怎么证明它有效

- PR #11 的 required CI 通过。
- 自动测试达到 23 项且全部通过。
- 本地示例稳定复现 `415 → 修改 Content-Type → 200`。
- Issue #1 通过 `Closes #1` 自动关闭，Release Please 生成 `v0.3.0`。

### 这一步还没有解决什么

- Issue #1 明确把“Pi 模型接入、文档 RAG/rerank 与 30 Case 统计评测”放到后续 Issue。
- 运行入口仍固定实例化 `DeterministicReasoner`。
- 因此这是 V1-A，而不是完整产品 V1。

### 本阶段遇到的问题与风险

最大的流程问题是版本口径不一致：产品路线图的 V1 包含 Agent 推理能力，但工程 Issue #1 只覆盖真实输入。PR 合并后曾被表述为“V1 完成”，直到对照 Issue 非本期范围和 `app.ts` 才发现 Pi 未接入。结论是：**Issue 完成不等于上层产品阶段完成，验收前必须做版本差分检查。**

## 2026-09-05：V1-B，接入 Pi 并补齐产品 V1

证据：Issue #13、PR #14、提交 `ddfee2e feat: integrate Pi Agent and complete product V1`、发布 `v0.4.0`。

### 改了什么

- 接入官方 Pi Agent 运行时的 Node 20 兼容版本 `0.74.2`。
- 新增 `PiReasoner` 和版本化 Debug Agent Prompt。
- 增加 deterministic/pi 模式、provider、model、credential、timeout 和显式 fallback 配置。
- 模型输入先脱敏；输出经过 root cause、action、规范字段和敏感操作校验。
- 模型只提出计划，Orchestrator、RequestPolicy 和 HttpTool 保留执行权。
- Trace 记录非敏感运行元数据。
- CI 增加官方 Pi `Agent` + faux provider 的离线完整链路和三轮稳定性评测。

### 为什么这样改

直接让模型执行网络请求会放大提示词注入、错误动作和凭据泄露风险。把 Pi 放在已有 `Reasoner` 接口后面，可以复用 V0/V1-A 已验证的工具、安全和复核层。

### 怎么证明它有效

- 测试从 23 项增加到 36 项，全部通过。
- Pi Tier A 连续三轮为 3/3。
- 测试真实实例化官方 Pi `Agent`，覆盖合法计划、code fence、畸形 JSON、未知动作、敏感字段、模型异常、超时、显式降级、Host 阻断和最大尝试次数。
- npm 官方审计端点返回 0 vulnerabilities。
- PR #14、main、Release PR #15 的 required CI 均通过，最终创建 `v0.4.0`。

### 这一步还没有解决什么

- CI 没有公网模型调用，也没有真实用户成功率、费用和延迟数据。
- `.pi/skills/api-doctor/SKILL.md` 没有被 `PiReasoner` 动态加载。
- Reviewer 不是 Pi 子 Agent，也没有语义级证据核验。
- Pi Agent 当前没有工具，属于“Pi 推理器 + 外层确定性编排”，不是模型自主工具循环。
- 文档 RAG（Retrieval-Augmented Generation，检索增强生成）、仓库扫描、MCP（Model Context Protocol，模型上下文协议）、持久化和界面仍未实现。

### 本阶段遇到的问题与风险

- 最初尝试的 `@mariozechner/*` 包已被 npm 标记废弃，随后切换到官方新命名 `@earendil-works/*`，并锁定兼容 Node 20 的 `0.74.2`。
- npm 镜像不支持安全审计端点，改用 npm 官方 registry 后完成审计。镜像功能缺失不能被误判为依赖漏洞。
- Pi 依赖增加了 lockfile 和供应链体积；后续升级必须重新检查 Node 版本、类型定义和回归测试。

## 2026-09-05：Issue #16，公开事实文档与私有规划分离

### 改了什么

- `.gitignore` 从忽略整个 `docs/` 改为忽略 `.private/`。
- 原 `docs/` 的 11 个个人、JD、废弃方案和路线规划文件原样移动到 `.private/planning-docs/`。
- 新建公开的 `architecture.md`、`build-log.md` 和 `interview.md`。

### 为什么这样改

公开仓库需要架构和构建证据，但不需要公开个人求职分析和未实现规划。目录级边界比逐文件白名单更容易检查。

### 怎么证明它有效

- 移动前后递归文件数均为 11。
- `git check-ignore` 确认 `.private/planning-docs/方案.md` 被 `.private/` 规则忽略。
- 最终应由 `git ls-files docs` 只列出三份公开文档。

### 这一步还没有解决什么

私人规划只在当前本机保存，不随 Git clone 同步，需要使用者自行备份。

### 本阶段遇到的问题与风险

第一次创建 `.private/` 时使用了当前 PowerShell 不支持的 `New-Item -LiteralPath` 参数，目标目录没有创建，移动也没有发生。检查确认源目录仍有 11 个文件后，改用 `.NET Directory.CreateDirectory`，再次校验源和目标绝对路径，最终完成 11→11 的移动。这个过程证明破坏性或递归文件操作前后都应核对精确路径和数量。

## 2026-09-06：V2，把入口前移到代码仓库

证据：Issue #21、PR #22、`src/repository/*`、`test/fixtures/repository` 与 `test/repository-scanner.test.ts`。

### 改了什么

- CLI 新增 `repo --root <dir> --document <openapi.json>`。
- 扫描器只读 `.js/.jsx/.ts/.tsx`，忽略依赖、构建和覆盖率目录，不跟随符号链接，并限制文件数与单文件大小。
- 识别字面量 HTTP(S) `fetch` 的 URL、方法、文件和行号，与 OpenAPI 3.x 的 method/path 比对。
- 识别 `process.env.NAME`、`import.meta.env.NAME`，只读取 `.env.example` 的变量名，不读取 `.env`。
- 输出 `RepositoryReport`，区分规范缺失、环境变量缺失、动态 URL 未支持和超大文件。

### 为什么这样改

V1 已能诊断一条明确请求，但用户仍需先在陌生仓库中定位调用点。V2 先完成无副作用预检，让“从仓库找到问题”成为可验证入口，同时避免扫描结果直接产生网络请求或模型费用。

### 怎么证明它有效

- 固定仓库样例包含 2 个字面量调用：1 个匹配 `POST /orders`，1 个未在 OpenAPI 声明。
- 固定样例包含已声明与未声明环境变量，以及一个动态 `fetch`。
- 测试断言具体文件、行号、operation、Finding 数量和扫描限制。
- CLI 测试在 `A_PIDOC_REASONER=pi` 且无 Key 时仍能输出报告，证明 repo 模式没有构造 Pi 或调用模型。

### 这一步还没有解决什么

- 这是保守的文本级静态分析，不是完整抽象语法树或跨文件数据流分析。
- 不支持 Axios、自定义 HTTP 客户端、变量拼接和模板表达式 URL。
- 不会自动把发现项转换成 `DebugTask`，也不会执行、修代码或提交 PR。

### 本阶段遇到的问题与风险

- 固定 fixture 位于 `test/fixtures`，最初被 TypeScript 编译器当成项目源码；fixture 中故意使用的 `import.meta.env` 不属于当前 Node 类型环境。随后在 `tsconfig.json` 排除 fixture，扫描器仍按文件读取它。
- 首个限制测试把 `await` 写进非异步回调，编译器在运行前阻断；改为先加载文档再执行断言。
- 正则扫描便于解释和固定验证，但可能受注释、字符串内容或复杂语法影响；报告明确把动态目标标为未支持，不把不确定结果伪装成已解析。

## 从这条迭代得到的方法

1. **一次只增加一个不稳定源**：先固定数据，再真实网络，最后真实 Agent 运行时。
2. **每个阶段必须有反例**：不仅测试能修好，也测试危险 Host、畸形输出、超时和无降级。
3. **产品版本与 Issue 范围分开检查**：关闭一个 Issue 前，再对照产品阶段的完整能力清单。
4. **模型建议与执行权限分离**：Pi 输出计划，确定性代码决定计划能否执行。
5. **发布是证据链的最后一环**：Issue、PR、CI、merge commit、tag 和 Release 应能相互追溯。
