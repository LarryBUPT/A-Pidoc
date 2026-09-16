# A-Pidoc V0 → V4.5 验证指南

V4.5 正式受控版本 `v0.16.0` 的 144 项测试、54 条配对结果和最终 live 证据见 [发布审计](v45-release-audit.md)。分批合同与边界见 [Harness 迁移文档](agentic-harness.md)；V4 的 83 项行为基线保留，测试总数以实际输出为准。

本文回答三个问题：怎样从干净仓库复现当前能力、什么输出才算通过、遇到非零退出码时怎样区分“发现风险”和“程序故障”。所有冻结评测默认不访问公网 API、不加载 `.env`、不调用真实模型。

## 验证地图

```mermaid
flowchart LR
    A[锁定依赖与审计] --> B[编译 + 全部自动测试]
    B --> C[Pi Tier A 3 轮]
    C --> D[V2 仓库修复评测]
    D --> E[V3 契约迁移评测]
    E --> F[V4 团队闭环评测]
    F --> H[Harness 合同 3 轮]
    H --> I[54 条 Raw/Harness 配对]
    I --> J[V5计划与恢复3轮]
    J --> G[生成物一致性]
```

`v0.10.1` 的 V3 基线是 75 项；V4 增加 8 项后为 83 项，V4.5 完整版本为 144 项。不能把历史数字写成永久门槛。

## 1. 从干净环境运行 required CI 等价门禁

要求 Node.js 22.19+。在仓库根目录运行：

```bash
npm ci --registry=https://registry.npmjs.org
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
npm run build
npm run eval:tier-a
npm run eval:repository
npm run eval:contract
npm run eval:collaboration
npm run eval:harness
npm run eval:agentic
npm run eval:reliability
git diff --exit-code
```

通过信号：

| 门禁 | 可观察结果 | 证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| 依赖审计 | high 及以上生产依赖漏洞为 0 | 当前 lockfile 未命中该级别公告 | 不等于没有未知漏洞 |
| 自动测试 | 全部通过 | 固定输入、失败路径和安全边界未回归 | 不等于任意真实仓库都支持 |
| Pi Tier A | `3/3 runs passed` | 官方 Pi 运行时的可控 provider 路径稳定 | 不代表公网模型效果/费用/延迟 |
| Repository eval | 3 仓库、8 resolved、2 explicit unresolved、4 clients；修复前 1 error → 后 0 | 有限扫描与隔离修复闭环可重复 | 不代表完整 AST 召回率 |
| Contract eval | 7 changes、5 breaking；5 impacts/2 calls；迁移前 1 → 后 0 | V3 竖切的 Diff、影响、迁移和测试闭环 | 不代表完整 OpenAPI/JSON Schema |
| Collaboration eval | 5 platforms、1 publication、1 stored/1 retrieved case、1 Postman request、1 regression assertion，日志已脱敏、Trace 完整 | V4 固定 Jira→日志→诊断→回复/回归测试→知识闭环与权限边界 | 不代表真实企业账号、网络传输或并发生产负载 |
| Harness eval | JSON 的 `passed: true`，`results` 中3轮均通过 | 低层循环、审批、事实门禁、实际工具与 Reviewer 合同稳定 | 不代表外部模型泛化成功率 |
| Agentic eval | 54条、paired/passed 为 true；未授权实际执行0、正常误拦0 | 同条件 Raw/Harness 固定安全与完成合同 | faux Token/费用不是实际模型收益 |
| Reliability eval | 3轮passed；健康6探测/0模型；临时故障completed、结构漂移manual_handoff | 20项专项合同、实际探测与子进程恢复 | 不代表生产常驻服务或模型泛化成功率 |
| Git diff | 无输出，退出码 0 | 构建/评测没有改写受跟踪源码 | 不检查被忽略的临时文件 |

`npm run eval:business` 是更完整的 V1 业务评测，但目前不是 required CI。它运行 26 个 loopback HTTP 案例，不调用公网模型；主动停止的危险或不可证明场景属于正确结果。

## 2. V0/V1：单请求诊断

最短离线演示：

```bash
npm run demo
```

真实 loopback 请求需要两个终端。终端 A：

```bash
node examples/mock-api.mjs
```

终端 B：

```bash
npm run build
node dist/src/cli.js curl --input examples/order.curl --spec examples/order-spec.json --allow-host 127.0.0.1 --allow-port 3001
```

预期主链是 `415 → set_header(Content-Type) → 200 → Reviewer`。这证明受控 HTTP 修复，不证明系统能安全访问任意 Host；白名单、端口、DNS、响应大小和重试预算仍会阻断危险请求。

## 3. V2：仓库扫描与隔离修复

只读扫描和计划生成：

```bash
npm run build
node dist/src/cli.js repo --root test/fixtures/repository --document test/fixtures/repository/openapi.json
node dist/src/cli.js repo-plan --root test/fixtures/repository-v2 --document test/fixtures/repository-v2/openapi.json
```

fixture 故意保留规范缺失或动态调用，因此退出码 1 表示“门禁发现问题”。报告中的 `summary`、`apiCalls`、`unresolvedCalls` 和 `findings` 能区分已解析调用、不确定调用和具体风险。

隔离修复示例：

```bash
node dist/src/cli.js repo-verify --root test/fixtures/repository-v2-repair --document test/fixtures/repository-v2-repair/openapi.json --workspace ../a-pidoc-v2-workspace --approved true
```

`--workspace` 必须位于源仓库之外且尚不存在。命令复制源目录，只在副本应用唯一可判定的 URL 和 `.env.example` 补丁，并运行 `.a-pidoc/generated/*.test.mjs`；原 fixture 不变。重复验证请换新目录，不要把一个已有工作区当成覆盖目标。

## 4. V3：契约 Diff、影响与迁移

先运行只读风险门禁：

```bash
node dist/src/cli.js contract-diff --previous test/fixtures/repository-v3-impact/old.json --next test/fixtures/repository-v3-impact/new.json
node dist/src/cli.js contract-impact --root test/fixtures/repository-v3-impact --previous test/fixtures/repository-v3-impact/old.json --next test/fixtures/repository-v3-impact/new.json
```

预期两条命令都返回退出码 1：第一条发现 breaking changes，第二条发现受影响调用。关键字段：

| 报告字段 | 含义 |
| --- | --- |
| `changes[].id` | 由变化内容生成的稳定短 ID |
| `severity` / `breaking` | 高中低风险与是否破坏兼容 |
| `operation` / `fieldPath` | 哪个接口、哪个字段发生变化 |
| `impacts[].file` / `line` | V2 扫描定位到的真实调用点 |
| `rationale` | 为什么该调用与变化冲突 |

再运行可修复 fixture：

```bash
node dist/src/cli.js contract-verify --root test/fixtures/repository-v3-migration --previous test/fixtures/repository-v3-migration/old.json --next test/fixtures/repository-v3-migration/new.json --workspace ../a-pidoc-v3-workspace --approved true
```

通过条件不是“生成了补丁”，而是以下条件同时成立：

1. 使用者显式传入 `--approved true`。
2. workspace 是源仓库之外的新目录。
3. 只有可证明无损且可唯一定位的原始字面量转换被应用，例如 `"42"` → `42`。
4. 修改后重新分析，影响数量低于修改前。
5. `.a-pidoc/contract/*.test.mjs` 真实落盘并由 Node test runner 通过。
6. Trace 顺序包含前置影响分析、复制、补丁、后置分析、生成测试和运行测试。

`"unknown"` 之类业务值不会产生补丁；没有安全补丁或没有生成测试时，验证不会假装成功。

## 5. V4：团队协作与结构化知识

先运行完整冻结竖切：

```bash
npm run demo:team
npm run eval:collaboration
npm run build && node dist/src/cli.js collaboration-demo
```

两条命令运行同一套无公网 fixture。通过时 `passed` 与 `regressionTestGenerated` 为 true，并输出：5 类平台载荷、1 次内存平台发布、1 条入库和 1 条检索案例、1 个 Postman 请求、日志脱敏成功、六阶段 Trace 完整。Jira 工单中的固定 `Content-Type` 故障会进入既有 V1 诊断链；最终请求会生成带 200 状态断言的脱敏 Postman 回归 Collection，不能只生成字符串假装修复。

再逐个检查输入边界：

```bash
npm run build
node dist/src/cli.js collaboration-normalize --platform jira --input examples/collaboration/jira-issue.json --tenant team-a
node dist/src/cli.js postman-import --input examples/collaboration/postman-collection.json
node dist/src/cli.js postman-export --input examples/collaboration/requests.json
```

`collaboration-normalize` 应输出统一的 platform、id、tenantId、title、description 和 correlationId。Postman 导入只接受 HTTP(S)、GET/POST/PUT/PATCH/DELETE 与 raw JSON body，最多 100 项；导出结果中的 Authorization 值应为 `[REDACTED]`。

安全反例由 `test/collaboration-v4.test.ts` 固定验证：viewer 不能查询日志或诊断，跨租户工单被拒绝，未批准时不会发布也不会写知识库，发布和入库必须分别批准，日志/知识/回复不包含原始 Token。JSON 知识库只按租户和 operation 检索结构化案例，不保存完整聊天记录。

### V4 的“平台支持”具体指什么？

GitHub/GitLab PR、Jira Issue、Slack/飞书消息均有载荷归一化器和回复请求构造器；冻结 Connector 只把结果记在内存。仓库没有真实平台凭据、SDK 调用、Webhook 服务或异步任务，因此这组证据证明协议边界和工作流，不证明已在企业账号完成端到端联调。

## 6. 常见问题

### 风险命令退出 1，是不是坏了？

先看是否仍输出完整 JSON。`contract-diff` 有 breaking change、`contract-impact` 有 impact、`repo`/`repo-plan` 有 error 时，退出 1 是 CI 风险门禁的设计。解析异常、文件不存在或权限错误通常会输出错误栈，而不是结构化报告。

### 为什么 verify 说 workspace 已存在？

隔离验证拒绝覆盖已有目录。换一个尚不存在且位于源仓库外的路径。工具故意不提供覆盖开关，以免把用户目录误当临时空间。

### 为什么不执行被扫描项目自己的测试脚本？

陌生仓库脚本可能联网、修改状态或读取凭据。当前只运行 A-Pidoc 自己生成且明确列出的无网络测试文件；这换来可审计性，也意味着尚未证明目标项目的完整业务测试通过。

### 哪些能力仍不应写成已完成？

完整 AST/函数间数据流、完整 OpenAPI/JSON Schema、字段重命名与业务值推断、响应字段使用级追踪、完整对话/任务回放、真实平台账号与网络写回、生产队列与部署、真实用户指标和公网模型稳定性均不在 V4 已验证范围内。

## 7. 证据入口

- [架构与模块边界](architecture.md)
- [逐版本构建日志](build-log.md)
- [V1 loopback 示例](../examples/README.md)
- `test/repository-v2.test.ts`：V2 隔离修复与源仓库不变
- `test/contract-v3.test.ts`：V3 Diff、影响、迁移、审批、Trace 与 CLI
- `test/collaboration-v4.test.ts`：V4 五平台、RBAC、租户、双审批、日志、Postman、知识库、竖切与 CLI
- `.github/workflows/ci.yml`：远程 required CI 的真实命令
## V4.5 PR-2 运行契约

运行 `npm run build` 后执行 `node --test dist/test/pi-loop-contract.test.js`。它验证稳定 release 的多轮工具观察、awaited 持久化、混合批次停止、消息恢复、串行、预算和错误脱敏，不能替代后续 API 任务或公网模型评测。详见 [Pi 0.85.1 RFC](pi-0.85.1-rfc.md)。
## V4.5 PR-3 审批与安全合同

`node --test dist/test/approval-contract.test.js` 覆盖原子挂起、精确调用、一次纠偏、错误参数/工具/Schema、混合批次、过期/拒绝/权限、日志与关键前置条件、TOCTOU、消费后崩溃、租户/环境/敏感参数和预算。`npm run eval:harness` 对 loop + approval 连续三轮通过才可合并。详见 [审批协议](approval-protocol.md)。
## V4.5 PR-4 事实与完成门禁

`node --test dist/test/workspace-evidence.test.js` 覆盖 13 项状态、Artifact、投影、无进展与 Evidence Gate 故障合同。`npm run eval:harness` 现在连续三轮验证 loop + approval + workspace/evidence；既有 provider/business/repository/contract/collaboration 保留，faux 与 live 分列。验证规则见 [工作区与证据门禁](workspace-evidence.md)。

PR-5 把真实 HTTP/隔离迁移工具集成合同加入 `eval:harness` 三轮复跑。独立 TAP 子进程不继承 NODE_TEST_CONTEXT，实际测试数必须为正；live CLI 使用私有 `.env` 与 `.private/runs`，不会进入离线 CI。

PR-6 增加 `npm run eval:agentic` 为 required CI 的同条件对照，模型为 faux、9 类三轮，阈值与实际逐例记录见 [评测说明](reviewer-evaluation.md)。`eval:agentic:live` 使用本地凭据手动验收，失败尝试保留，真实结果与模拟统计分开。Reviewer 合同并入 `eval:harness` 三轮复跑。

## V5 计划探测与 Worker 恢复

运行 `npm run demo:reliability` 与 `npm run eval:reliability`，预期 `healthyProbes: 6`、`healthyModelRequests: 0`、临时异常任务completed、Schema持续异常manual_handoff；后者连续三轮专项合同与场景，provider为faux。真实子进程发布后硬中断/恢复不重复、准确审批、原合同复查、容量/取消/超时/预算均有专项反例。原V4.5与旧评测继续required，真实模型独立 `eval:reliability:live`。具体命令/范围见 [V5持续可靠性](reliability-v5.md)。
