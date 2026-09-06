# A-Pidoc 架构与核心链路

本文只描述 V2 已实现并由测试覆盖的代码。规划中的文档检索、动态代码数据流、持久化、前端界面和生产部署不在当前架构中。

## 一句话概括

A-Pidoc 先从本地源码定位 API 调用、规范差异和配置缺口；对用户明确提交的单条请求，才进入受控执行、诊断、修复和证据复核链路。

## 先认识术语

| 名词 | 完整名称 | 大白话解释 |
| --- | --- | --- |
| HTTP | Hypertext Transfer Protocol，超文本传输协议 | 客户端和服务端传递请求、响应的规则 |
| API | Application Programming Interface，应用程序编程接口 | 一个程序允许另一个程序调用的入口 |
| JSON | JavaScript Object Notation，JavaScript 对象表示法 | 接口常用的结构化文本格式 |
| JSON Schema | JavaScript Object Notation Schema，JSON 结构规范 | 描述 JSON 允许哪些字段和值的校验规则 |
| OpenAPI | OpenAPI Specification，开放接口规范 | 描述接口路径、方法、参数和数据结构的机器可读说明书 |
| Agent | 智能体 | 接收目标，调用能力，观察结果，再决定下一步的程序 |
| Reasoner | 推理器 | 本项目中只负责把请求、响应、规范和规则转成诊断与单步修复计划的组件 |
| Fixture | 固定测试样例 | 输入和预期结果都预先写好的可重复案例 |
| Schema | 结构约束 | 规定一个 JSON 对象允许有哪些字段、类型和值 |
| Trace | 执行轨迹 | 按顺序记录每个阶段开始、成功、失败和耗时 |
| CI/CD | Continuous Integration / Continuous Delivery，持续集成与持续交付 | 每次提交自动构建、测试，并按规则生成可追溯版本 |
| RAG | Retrieval-Augmented Generation，检索增强生成 | 先查资料，再把相关内容交给模型回答 |
| MCP | Model Context Protocol，模型上下文协议 | 用统一协议连接模型与外部工具或数据源 |
| Static Analysis | 静态分析 | 只读代码文本推断结构，不运行被扫描项目 |
| Repository Preflight | 仓库预检 | 在真实调试前先列出调用点、规范和配置问题 |

## 用户场景

> 作为刚接触陌生项目的开发者，我想先指定源码目录和 OpenAPI 文档找到可疑调用点；确认单条请求后，再让系统用真实响应证明失败原因和修复结果。

## V2 仓库预检数据流

```mermaid
flowchart LR
    A[仓库根目录] --> B[目录与文件预算]
    B --> C[JS/TS 只读扫描<br/>你在这里]
    D[OpenAPI 3.x] --> E[Operation 索引]
    F[.env.example 变量名] --> C
    C --> G[字面量 fetch + 环境变量]
    E --> H[方法与路径比对]
    G --> H
    H --> I[RepositoryReport<br/>文件 + 行号 + Finding]
```

扫描器不读取 `.env`，不跟随符号链接，忽略 `.git`、`node_modules`、`dist`、`build`、`coverage`，并限制文件数和单文件大小。它只识别字面量 HTTP(S) `fetch`；动态目标会输出 `DYNAMIC_FETCH_UNSUPPORTED`，不会猜测。

## 核心数据流

文档入口先经 `readApiDocument`：JSON / Markdown / HTML → 唯一规范块 → 有预算的本地 `$ref` 展开 → Swagger 2 转换 → OpenAPI operation。`json-schema.ts` 在网络执行前递归检查对象、数组、枚举和基础约束，错误保留字段路径，例如 `$.items[0].quantity`。只接受明确的规范数据，不能从任意自然语言页面猜测接口；不支持的 Schema 断言直接报错。`ApiSpec.bodySchema` 保留完整的受支持请求约束，原 `requiredBody` 继续作为兼容的基本字段索引。

```mermaid
flowchart LR
    A[curl / OpenAPI / Fixture] --> B[输入解析]
    B --> C[统一 DebugTask]
    C --> D[DebugOrchestrator<br/>你在这里]
    D --> E[请求安全策略]
    E --> F[HTTP Tool]
    F --> G{响应成功?}
    G -- 否 --> H[规则检索]
    H --> I[Reasoner 诊断]
    I --> J[受限单步修复]
    J --> E
    G -- 是或停止 --> K[EvidenceReviewer]
    K --> L[DebugReport + Trace]
```

核心对象是 `DebugTask`。无论输入来自固定案例、curl 还是 OpenAPI，进入编排器前都会变成同一种结构：请求、接口规范、输入来源和任务标识。这样增加输入类型时，不需要重写诊断循环。

`fault-analysis.ts` 组合工具错误、HTTP 状态和请求 Schema 差异，生成受支持的故障类别及单步动作。Pi 的版本化 Prompt 接收这些候选证据，生成摘要并选择候选动作或停止；执行前 Orchestrator 再校验一次。这个设计主动限制模型自由度，不能宣称模型在任意业务中自主发现根因。403/404/5xx 的分类只是可观察的失败类别，具体权限、资源或服务内部根因仍需人工调查。

HTTP 超时/连接异常通过稳定 `errorType` 进入报告；声明 JSON 的畸形 2xx 响应不再被视为成功。429 的 `Retry-After` 最多等待 1 秒，超出则停止并交给用户稍后重试；写请求超时不自动重发。Reviewer 检查实际响应/工具错误和规范证据，并将相邻请求差异与动作核对；它仍是规则复核器，不具备任意自然语言证据的语义判别能力。

## 一条请求实际经过什么

```mermaid
sequenceDiagram
    participant U as 用户
    participant I as CLI / HTTP API
    participant O as DebugOrchestrator
    participant P as RequestPolicy
    participant T as HttpTool
    participant R as Reasoner
    participant V as EvidenceReviewer

    U->>I: curl 或 OpenAPI
    I->>O: DebugTask
    O->>P: 校验协议、凭据、Host、Port 和模型调用预算
    P-->>O: 允许或阻断
    O->>T: 执行请求
    T-->>O: HttpResult
    alt 2xx 成功
        O->>V: 复核尝试与证据
    else 请求失败
        O->>R: 请求 + 响应 + 规范 + 规则
        R-->>O: Diagnosis + FixAction
        O->>P: 修正后再次校验
        O->>T: 受预算限制地重试
        O->>V: 复核最终结果
    end
    V-->>O: Evaluation
    O-->>I: 脱敏报告和 Trace
    I-->>U: JSON 输出
```

## 按可验证步骤理解核心链路

### 第 0 步：对仓库做无副作用预检

**改了什么**

- `src/repository/scanner.ts` 受限遍历源码，提取字面量 `fetch` 和环境变量引用。
- `src/repository/types.ts` 定义带源码位置、规范匹配和 Finding 的 `RepositoryReport`。
- CLI 新增 `repo --root --document`，且在创建 Pi Reasoner 之前返回扫描结果。

**为什么这样改**

V1 要求用户先手工找到失败请求。V2 把入口前移到仓库，但保持静态、只读，避免扫描结果未经确认就触发网络或模型费用。

**怎么证明它有效**

`test/fixtures/repository` 固定了已匹配调用、规范缺失、已声明/未声明环境变量和动态 URL；`test/repository-scanner.test.ts` 同时验证扫描函数与 CLI，甚至把 `A_PIDOC_REASONER=pi` 且不给 Key，证明 repo 模式不会构造 Pi Reasoner。

**这一步还没有解决什么**

Axios、自定义 HTTP 客户端、模板字符串、变量拼接、跨文件值传播和自动生成 `DebugTask` 尚未实现。

### 第 1 步：把明确输入变成统一任务

**改了什么**

- `src/input/curl-parser.ts` 解析 curl 的方法、地址、Header 和 JSON body。
- `src/input/openapi-parser.ts` 从 OpenAPI 3.x 文档选择 operation，并生成请求和基础规范。
- `src/input/debug-input.ts` 把两种输入转换为 `DebugTask`。

**为什么这样改**

核心循环只依赖统一对象，不需要知道用户粘贴的是 curl 还是上传了 OpenAPI。

**怎么证明它有效**

`test/real-input.test.ts` 和 `test/openapi-input.test.ts` 分别验证正常输入、错误输入和结构校验；`test/v1-integration.test.ts` 验证两种输入能进入 HTTP API。

**这一步还没有解决什么**

本地 `$ref` 和 Markdown/HTML 的明确 JSON 规范块已接入；外部/循环引用、非 JSON request body、任意自然语言文档与 Postman Collection 尚未支持。

### 第 2 步：执行前先做安全检查

**改了什么**

`RequestPolicy` 只允许 HTTP/HTTPS、拒绝 URL 内嵌凭据，限制 Host、Port、DNS 解析后的私网地址、最大尝试次数和每任务模型调用数。`RealHttpTool` 另有限时、响应大小和重定向约束。HTTP API 还有 Bearer 认证、Origin、每 IP 限流和并发上限。

**为什么这样改**

Agent 生成的计划不能直接获得网络执行权。每一次初始请求和修正请求都必须重新经过确定性策略。

**怎么证明它有效**

`test/orchestrator.test.ts`、`test/real-input.test.ts` 和 `test/pi-reasoner.test.ts` 覆盖恶意 Host、内嵌凭据、超时、超大响应，以及“策略在 Pi 调用前阻断”。

**这一步还没有解决什么**

当前没有对 POST、PUT、PATCH、DELETE 等可能改变服务端状态的方法增加人工确认；DNS 检查和实际连接之间仍存在时间窗口，公网部署还需要网络层出口策略。

### 第 3 步：真实执行并保留证据

**改了什么**

`HttpTool` 是统一执行接口；`FixtureHttpTool` 用固定行为回归测试，`RealHttpTool` 使用真实网络请求并返回状态码、响应体、Header 和耗时。

**为什么这样改**

诊断不能只靠语言模型猜测。第一次失败响应是根因证据，修正后的成功响应是修复证据。

**怎么证明它有效**

`examples/mock-api.mjs` 可以稳定复现 `415 → 修正 Content-Type → 200`；对应集成测试也会启动本地服务完成同一条链路。

**这一步还没有解决什么**

没有持久化历史执行、并发任务管理、真实日志平台查询和跨服务调用链追踪。

### 第 4 步：检索规则并生成单步修复

**改了什么**

`retrieveRules` 根据响应选择本地规则。`Reasoner` 接口有两个实现：`DeterministicReasoner` 使用固定分支，`PiReasoner` 使用 Pi Agent 运行时生成结构化计划。

**为什么这样改**

先用确定性实现建立可回归基线，再把不确定的模型能力放进同一接口，可以区分“工作流坏了”和“模型判断波动”。

**怎么证明它有效**

六个 Fixture 证明确定性路径；`test/pi-reasoner.test.ts` 真实实例化官方 Pi `Agent`，通过可控 provider 验证合法输出、非法 JSON、未知动作、敏感修改、模型异常、超时和显式降级。

**这一步还没有解决什么**

- required CI 不调用公网模型，因此没有线上 DeepSeek 模型的稳定率、延迟和费用数据。
- `.pi/skills/api-doctor/SKILL.md` 存在于仓库，但当前 `PiReasoner` 加载的是 `src/agent/prompts/debug-agent.ts`，并未运行时加载该 Skill。
- 当前 Pi Agent 没有注册工具；网络执行和重试由外层 Orchestrator 控制，而不是模型自主调用工具。

### 第 5 步：校验模型输出再执行

**改了什么**

`PiReasoner` 对模型返回的 root cause、action、字段类型、规范值和敏感字段做运行时校验；模型不能修改 URL，也不能生成 Authorization、Cookie、Token 等敏感值。证据由本地响应、接口规范和规则重新构造。

**为什么这样改**

模型输出是“不可信建议”，不是系统命令。把可执行动作缩小到 `set_header`、`set_body`、`set_method`、`retry` 和 `stop`，才能审计和测试。

**怎么证明它有效**

Pi 测试覆盖 Markdown code fence、畸形 JSON、未知 action、规范外字段和敏感 Header；失败默认阻断，只有设置 `A_PIDOC_PI_FALLBACK=deterministic` 才降级。

**这一步还没有解决什么**

当前 Schema 校验是项目内手写的有限校验，不是完整 JSON Schema 实现；也没有基于业务语义判断“这个数值虽然类型正确但是否合理”。

### 第 6 步：Reviewer 复核并输出 Trace

**改了什么**

`EvidenceReviewer` 检查最后一次请求是否成功、固定评测中的根因是否匹配、诊断是否具备足够证据。`TraceRecorder` 记录每个阶段的顺序、状态、耗时和非敏感运行元数据。

**为什么这样改**

Reasoner 提出结论，Reviewer 决定证据是否足够；职责分离能防止“模型自己给自己判满分”。

**怎么证明它有效**

所有报告都包含 `evaluation` 和 `trace`；测试检查 Trace 顺序、Pi provider/model/Prompt 版本/timeout/fallback 元数据，以及敏感字段不进入报告。

**这一步还没有解决什么**

Reviewer 当前是确定性类，不是 Pi 子 Agent；它检查成功状态、预期根因、实际响应/规范证据来源，以及动作与相邻请求变化的一致性，仍不理解任意自然语言证据的业务语义。

## 模块边界

| 模块 | 负责什么 | 不负责什么 | 关键文件 |
| --- | --- | --- | --- |
| 输入层 | 解析 curl/OpenAPI，生成统一任务 | 不执行网络请求 | `src/input/*` |
| 仓库预检层 | 只读扫描源码并与 OpenAPI/.env.example 比对 | 不执行网络、不调用模型 | `src/repository/*` |
| 编排层 | 控制阶段顺序、重试预算和报告 | 不直接判断具体根因 | `src/core/orchestrator.ts` |
| 安全层 | Host、协议、凭据和脱敏 | 不进行模型推理 | `src/security/*` |
| 工具层 | 固定或真实执行 HTTP | 不决定下一步修复 | `src/tools/*` |
| 知识层 | 按响应检索基础规则 | 不是向量数据库或文档 RAG | `src/knowledge/rules.ts` |
| 推理层 | 生成诊断和单步动作 | 不能绕过策略直接执行 | `src/agent/*reasoner.ts` |
| 复核层 | 检查成功、根因和证据 | 不修改请求 | `src/agent/reviewer.ts` |
| 观测层 | 记录顺序、状态和耗时 | 不保存到外部数据库 | `src/observability/trace.ts` |
| 入口层 | 提供命令行和 HTTP API | 不复制核心诊断逻辑 | `src/cli.ts`、`src/server.ts` |

## 关键取舍

1. **确定性优先，再接 Pi**：降低首次闭环的排错难度，但 V1-A 曾因此被误称为完整 V1。
2. **Pi 在 Reasoner 后面有输出闸门**：牺牲部分自由度，换取可执行动作可控。
3. **模型只提计划，Orchestrator 掌握工具**：更安全、更容易回归，但还不是工具自主型 Agent。
4. **公网模型不进入 required CI**：避免密钥、费用和服务波动阻塞合并，但线上效果需要另建评测。
5. **显式降级**：模型失败不会悄悄伪装成 Pi 成功；是否退回确定性路径由部署者决定。
6. **仓库扫描默认无副作用**：先定位证据，暂不自动执行；牺牲一步自动化，避免误请求和模型费用。

## 推荐阅读顺序

| 顺序 | 文件 | 为什么先看 |
| --- | --- | --- |
| 1 | `src/repository/types.ts` | 先认识 V2 仓库报告契约 |
| 2 | `src/repository/scanner.ts` | 看仓库怎样变成调用点和 Finding |
| 3 | `src/domain/types.ts` | 再认识单请求、诊断、动作和报告契约 |
| 4 | `src/core/orchestrator.ts` | 看单请求主循环和每个决策点 |
| 5 | `src/input/debug-input.ts` | 看明确输入怎样进入主循环 |
| 6 | `src/security/request-policy.ts` | 看网络和预算边界 |
| 7 | `src/agent/pi-reasoner.ts` | 看 Pi、脱敏、校验和降级 |
| 8 | `test/repository-scanner.test.ts` | 用固定仓库反推 V2 实际承诺 |

## 动手验证

先运行 README 中的 `repo` 命令，观察文件/行号、规范缺失和环境变量缺口；再运行 `npm run demo`，观察六个固定诊断案例。

验证理解：为什么 Pi 生成了一个 `set_header` 动作后，仍然不能直接发送请求？答案应能同时提到 Orchestrator、RequestPolicy 和 HttpTool。
