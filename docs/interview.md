# A-Pidoc 面试追问题

这是一份回答练习册，不是标准答案。问题只来自当前仓库真实实现；“我的回答”必须由你自己填写。不要声称已有真实用户、线上部署或公网模型评测，除非以后补充了证据。

## 使用方法

每次只练一个问题：

1. 先不用看代码，用 1～2 分钟回答。
2. 打开“仓库证据”核对事实。
3. 按“问题—选择—验证—边界”重答一次。
4. 在“我的回答”中记录自己的语言，不要背文档原句。

首次出现的术语：

- **HTTP API**：Hypertext Transfer Protocol Application Programming Interface，基于超文本传输协议的应用程序编程接口。
- **JSON**：JavaScript Object Notation，JavaScript 对象表示法，接口常用结构化格式。
- **OpenAPI**：OpenAPI Specification，开放接口规范，机器可读的接口说明书。
- **Agent**：智能体，接收目标、观察结果并决定下一步的程序。
- **CI/CD**：Continuous Integration / Continuous Delivery，持续集成与持续交付。
- **MCP**：Model Context Protocol，模型上下文协议，用统一协议把模型与外部工具或数据源连接起来；当前项目未实现 MCP。

## 第一组：30 秒和 2 分钟项目介绍

### 1. 这个项目解决谁的什么问题？

- 考察点：能否先讲业务，而不是先报技术栈。
- 仓库证据：`README.md`、`examples/mock-api.mjs`。
- 必须说清：输入是什么、输出是什么、为什么要真实执行请求。
- 不要声称：已有生产客户或真实业务指标。
- 我的回答：

### 2. 请用 30 秒介绍 A-Pidoc。

- 考察点：能否压缩成“用户—问题—核心链路—结果”。
- 仓库证据：`README.md` 开头和架构图。
- 我的回答：

### 3. 请用 2 分钟介绍 V0 到 V1 的迭代。

- 考察点：是否能解释为什么分 V0、V1-A、V1-B，而不是罗列功能。
- 仓库证据：`docs/build-log.md`、`CHANGELOG.md`、标签 `v0.1.0`～`v0.5.0`。
- 我的回答：

## 第二组：核心链路

### 4. 一条 curl 从输入到报告经过哪些步骤？

- 考察点：能否按调用方向讲 parser → task → policy → tool → reasoner → reviewer → report。
- 仓库证据：`src/cli.ts`、`src/input/debug-input.ts`、`src/core/orchestrator.ts`。
- 追问：OpenAPI 从哪里进入？两条路径在哪里汇合？
- 我的回答：

### 5. 为什么要定义统一的 `DebugTask`？

- 考察点：接口抽象和扩展成本。
- 仓库证据：`src/domain/types.ts`、`src/input/debug-input.ts`。
- 追问：未来接 Postman Collection 最少改哪些模块？
- 我的回答：

### 6. 为什么一次只允许一个修复动作？

- 考察点：可归因性、风险控制和证据链。
- 仓库证据：`Diagnosis.action`、`applyDiagnosis`、`maxAttempts`。
- 追问：多个字段同时错误会发生什么？
- 我的回答：

### 7. 怎么判断“修好了”，而不是模型说修好了？

- 考察点：执行证据和复核机制。
- 仓库证据：`HttpResult`、`EvidenceReviewer.review`、第二次 HTTP 响应。
- 追问：如果接口返回 200 但业务状态失败，当前实现能识别吗？
- 我的回答：

## 第三组：为什么先做确定性版本

### 8. 为什么 V0 不直接接大模型？

- 考察点：能否区分工作流错误与模型不确定性。
- 仓库证据：Fixture、DeterministicReasoner、V0 测试。
- 追问：这种策略牺牲了什么？
- 我的回答：

### 9. Fixture 和 Mock 有什么区别？项目里分别怎么用？

- 考察点：测试分层。
- 仓库证据：`FixtureHttpTool`、`examples/mock-api.mjs`、`test/v1-integration.test.ts`。
- 我的回答：

### 10. 为什么保留 `DeterministicReasoner`？

- 考察点：基线、降级与回归定位。
- 仓库证据：`src/config/reasoner.ts`、`A_PIDOC_PI_FALLBACK`。
- 追问：为什么降级必须显式开启？
- 我的回答：

## 第四组：Pi 接入

### 11. 你具体怎么接入 Pi，而不是只调用一个模型 API？

- 考察点：能否指出官方 `Agent` 实例、模型注册、Prompt、消息和错误状态。
- 仓库证据：`src/agent/pi-reasoner.ts`、`package.json`。
- 追问：Pi Agent 当前有没有工具？
- 必须诚实：Pi Agent 当前负责推理，HTTP 工具由外层 Orchestrator 调用。
- 我的回答：

### 12. 为什么把 Pi 接在 `Reasoner` 接口后面？

- 考察点：依赖倒置、可替换性和安全边界。
- 仓库证据：`Reasoner` interface、`DeterministicReasoner`、`PiReasoner`。
- 追问：如果换 Claude Code/Codex 风格的 Agent Harness，哪些代码不需要变？
- 我的回答：

### 13. 模型返回一段文本，程序为什么敢执行？

- 考察点：不可信输入、运行时校验、动作白名单。
- 仓库证据：`parseJson`、`parseDiagnosis`、`parseAction`。
- 追问：为什么接受 Markdown code fence？为什么仍拒绝额外字段？
- 我的回答：

### 14. 为什么模型不能修 Authorization？

- 考察点：凭据安全与“不能凭空生成秘密”。
- 仓库证据：`isSensitiveKey`、`parseAction`、401 的 `stop` 测试。
- 追问：确定性 Reasoner 为什么在规范提供值时可以修改？这是否仍有风险？
- 我的回答：

### 15. Pi 调用失败会怎样？

- 考察点：异常、超时、默认阻断和显式 fallback。
- 仓库证据：`timeoutMs`、`agent.abort()`、catch fallback、配置测试。
- 我的回答：

### 16. 为什么 required CI 不调用真实 DeepSeek 模型？

- 考察点：可复现性、密钥、费用、限流和外部依赖。
- 仓库证据：`registerFauxProvider`、`scripts/pi-tier-a.mjs`、CI workflow。
- 追问：那你怎么补真实模型效果评测？
- 我的回答：

### 17. 仓库里的 Pi Skill 是否已经被运行时使用？

- 考察点：是否会把存在文件误说成接通能力。
- 仓库证据：`.pi/skills/api-doctor/SKILL.md` 与 `src/agent/prompts/debug-agent.ts`。
- 必须诚实：当前 `PiReasoner` 使用版本化 TypeScript Prompt，没有动态加载 Skill。
- 追问：下一步如何让 Skill 真正参与？
- 我的回答：

### 18. Reviewer 是子 Agent 吗？

- 考察点：模块命名与真实运行模型的区别。
- 仓库证据：`src/agent/reviewer.ts`。
- 必须诚实：当前是确定性复核类，不是 Pi 子 Agent。
- 追问：什么时候值得升级为子 Agent？如何防止两个模型互相认同却都错？
- 我的回答：

## 第五组：安全与工程质量

### 19. 如何防止 Server-Side Request Forgery？

- Server-Side Request Forgery（服务端请求伪造）：攻击者诱导服务端访问不该访问的地址。
- 仓库证据：`RequestPolicy` 的协议、Host、Port、DNS 解析地址检查，RealHttpTool 的重定向阻断。
- 追问：为什么 DNS 预检查仍不能完全替代网络层出口策略？
- 我的回答：

### 20. 敏感信息在哪些阶段脱敏？

- 考察点：模型输入、报告、Trace 和错误路径。
- 仓库证据：`src/security/redaction.ts`、Pi prompt 构造、`redactDiagnosis`。
- 追问：字段名脱敏与值级脱敏各覆盖什么？为什么仍不能承诺识别所有个人信息？
- 我的回答：

### 21. 当前对写请求的保护够吗？

- 考察点：是否能主动发现项目限制。
- 仓库证据：RequestPolicy 目前检查协议、URL 凭据和 Host，但没有写方法人工确认。
- 追问：如果增加 dry-run、method allowlist 或用户确认，放在哪一层？
- 我的回答：

### 22. 测试为什么从 23 项增长到 49 项？新增测试覆盖了什么？

- 考察点：不是追求数量，而是覆盖新风险。
- 仓库证据：`test/pi-reasoner.test.ts`、`scripts/pi-tier-a.mjs`。
- 我的回答：

### 23. 三轮 Pi Tier A 评测能说明什么，不能说明什么？

- Tier A：项目定义的最小阻断评测层，要求每次 PR 都必须通过。
- 能说明：可控 Pi Agent 路径可重复、结构校验和策略无随机回归。
- 不能直接照抄为答案：请自己解释为什么它不代表公网模型准确率。
- 我的回答：

### 24. 为什么锁定 Pi `0.74.2`？

- 考察点：Node 20 兼容、依赖可复现、包迁移。
- 仓库证据：`package.json`、`package-lock.json`、`engines.node`。
- 追问：升级依赖时你会检查什么？
- 我的回答：

## 第六组：CI/CD 和问题复盘

### 25. 从 Issue 到 Release 的完整流程是什么？

- 考察点：Issue、短分支、测试、Conventional Commit、PR、required CI、squash merge、Release Please。
- 仓库证据：`CONTRIBUTING.md`、`.github/workflows/*`。
- 我的回答：

### 26. Release PR 为什么连续修了三次？

- 考察点：是否能讲清 GitHub Actions 触发与分支规则的真实调试过程。
- 仓库证据：`6e04909`、`4443f1c`、`39a8753` 和 Issue #5。
- 我的回答：

### 27. 为什么 V1-A 被误认为完整 V1？你如何修正？

- 考察点：需求拆分与产品版本管理。
- 仓库证据：Issue #1 的非本期范围、Issue #13、PR #14。
- 追问：以后如何避免同类问题？
- 我的回答：

### 28. 文档为什么从 `docs/` 整体忽略改成 `.private/`？

- 考察点：开源边界、隐私和事实文档。
- 仓库证据：PR #10、Issue #16、`.gitignore`。
- 我的回答：

## 第七组：设计边界和下一步

### 29. 当前最薄弱的模块是什么？

- 可选角度：Reviewer 语义能力、写请求确认、完整 OpenAPI、线上模型评测。
- 要求：选择一个，用现有代码证明，不要一次承诺全部改完。
- 我的回答：

### 30. 如果只允许做一个 V1.1 改动，你选什么？

- 考察点：能否基于风险和用户价值排序。
- 限制：不要把仓库扫描、RAG、MCP、UI 一次全部塞进来。
- 我的回答：

### 31. V2 为什么选择仓库预检，而不是继续堆错误码？

- 考察点：从单请求价值走向工程上下文价值。
- 仓库证据：`src/repository/scanner.ts`、`test/fixtures/repository`、repo CLI 测试。
- 追问：为什么 V2 默认不执行扫描到的请求，也不调用 Pi？
- 我的回答：

### 32. 仓库扫描器为什么先支持字面量 fetch？

- 考察点：能否解释最小垂直链路、可验证性和能力边界。
- 仓库证据：`literalFetch`、`DYNAMIC_FETCH_UNSUPPORTED`、固定 fixture。
- 追问：文本正则相对抽象语法树会有哪些误报和漏报？
- 我的回答：

### 33. 如何证明 repo 模式没有产生模型费用？

- 仓库证据：`src/cli.ts` 在 `createConfiguredReasoner()` 之前处理 repo；CLI 测试显式设置 Pi 模式但不给 Key，仍生成报告。
- 追问：如果以后要让 Pi 解释 Finding，怎样保留“扫描不付费”的默认行为？
- 我的回答：

### 34. 哪些数据能够证明这个产品“真正好用”？

- 可考虑但尚未采集：首次修复成功率、平均尝试次数、误修率、阻断危险请求比例、诊断耗时、单次模型费用。
- 要求：把“已有自动测试证据”和“未来需要真实用户数据”分开。
- 我的回答：

## 文档与 Schema 补齐追问

- 为什么 Markdown/HTML 只读取明确的 JSON 规范块？它和模型理解任意文档有什么区别？
- `$ref` 如何防止循环与展开量失控？为什么禁止远程引用？
- `$.items[0].quantity` 由哪层生成？错误会不会在 HTTP 请求发出之后才被发现？
- 为什么 required 字段缺失时不能统一填 0 或空字符串？
- 59 项自动测试、6 个入门 Fixture 和 26 个 HTTP 业务案例分别证明什么？

对应证据：`api-document.ts`、`json-schema.ts`、`document-contracts.test.ts`。先运行测试，再用自己的话解释边界。

## 自检清单

- 为什么 26 个案例全部符合预期，但请求恢复率不应达到 100%？
- `supportedAction` 限制了 Pi 的哪些能力？模型增加了哪些表达能力，哪些决定仍在本地代码？
- `Boolean("false")` 的问题如何被真实请求测试捕获？
- 写请求超时为什么不能直接重试？一个较大的 Retry-After 怎么处理？
- Reviewer 如何检测“动作只改金额，但实际还换了 URL”？哪些语义错误它仍发现不了？

- [ ] 我能在 30 秒内先讲业务问题，再讲技术。
- [ ] 我能画出核心链路并指出每一跳对应文件。
- [ ] 我不会把 V1-A 说成已经接入 Pi。
- [ ] 我不会把 `.pi/skills` 说成已被运行时加载。
- [ ] 我不会把 EvidenceReviewer 说成 Pi 子 Agent。
- [ ] 我能解释为什么模型只生成计划、不能直接获得工具权限。
- [ ] 我能区分仓库预检的静态证据与单请求链路的运行证据。
- [ ] 我能说出至少三个已测试的失败场景。
- [ ] 我会主动说明真实公网模型和真实用户指标尚未进入证据链。
