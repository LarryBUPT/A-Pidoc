# A-Pidoc V0 → V3 验证指南

本文回答三个问题：怎样从干净仓库复现当前能力、什么输出才算通过、遇到非零退出码时怎样区分“发现风险”和“程序故障”。所有冻结评测默认不访问公网 API、不加载 `.env`、不调用真实模型。

## 验证地图

```mermaid
flowchart LR
    A[锁定依赖与审计] --> B[编译 + 全部自动测试]
    B --> C[Pi Tier A 3 轮]
    C --> D[V2 仓库修复评测]
    D --> E[V3 契约迁移评测<br/>你在这里]
    E --> F[生成物一致性]
```

`v0.10.0` 的 V3 代码基线是 73 项；Issue #39 又加入 2 项公开文档检查，因此本补丁为 75 项。后续版本仍应以实际命令输出为准，不能把历史数字写成永久门槛。

## 1. 从干净环境运行 required CI 等价门禁

要求 Node.js 20.6+。在仓库根目录运行：

```bash
npm ci --registry=https://registry.npmjs.org
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
npm run build
npm run eval:tier-a
npm run eval:repository
npm run eval:contract
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

## 5. 常见问题

### 风险命令退出 1，是不是坏了？

先看是否仍输出完整 JSON。`contract-diff` 有 breaking change、`contract-impact` 有 impact、`repo`/`repo-plan` 有 error 时，退出 1 是 CI 风险门禁的设计。解析异常、文件不存在或权限错误通常会输出错误栈，而不是结构化报告。

### 为什么 verify 说 workspace 已存在？

隔离验证拒绝覆盖已有目录。换一个尚不存在且位于源仓库外的路径。工具故意不提供覆盖开关，以免把用户目录误当临时空间。

### 为什么不执行被扫描项目自己的测试脚本？

陌生仓库脚本可能联网、修改状态或读取凭据。当前只运行 A-Pidoc 自己生成且明确列出的无网络测试文件；这换来可审计性，也意味着尚未证明目标项目的完整业务测试通过。

### 哪些能力仍不应写成已完成？

完整 AST/函数间数据流、完整 OpenAPI/JSON Schema、字段重命名与业务值推断、响应字段使用级追踪、历史任务持久化/回放、PR 评论、生产部署、真实用户指标和公网模型稳定性均不在 V3 已验证范围内。

## 6. 证据入口

- [架构与模块边界](architecture.md)
- [逐版本构建日志](build-log.md)
- [V1 loopback 示例](../examples/README.md)
- `test/repository-v2.test.ts`：V2 隔离修复与源仓库不变
- `test/contract-v3.test.ts`：V3 Diff、影响、迁移、审批、Trace 与 CLI
- `.github/workflows/ci.yml`：远程 required CI 的真实命令
