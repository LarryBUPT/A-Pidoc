# 使用指南

API Doctor 提供命令行和本地 HTTP 服务。下面的示例从本地演示开始，再介绍代码扫描和接口升级检查；无需先配置模型。所有命令都在仓库根目录运行。

## 1. 安装并体验

需要 Node.js 22.19+。

```bash
npm ci
npm run demo
```

六个案例的 `passed` 都应为 `true`。其中包括原本正常的请求，因此不是每个案例都需要修正。

想查看真实 HTTP 请求从失败到修正的过程，请按[本地请求示例](../../examples/README.md)启动示例服务。请求初始返回 415，修正内容类型后返回 200。

### 体验 Harness 交互（免密钥）

基础演示和 `/api/debug` 使用预设诊断流程。想体验 Agent 通过工具调查、记录证据并接受门禁检查，运行：

```bash
npm run demo:harness
```

无需 `.env`、API Key 或手动启动示例服务。演示自动建立本地验证接口，真实执行 HTTP 请求，展示工具调用、415→200 的响应证据和最终门禁判定。模型决策与语义复核使用预设演示响应，不调用公网模型，也不证明真实模型自治能力。

体验需要用户逐项审批的隔离迁移：

```bash
npm run demo:harness -- --migration
```

程序使用内置仓库样例的独立副本，展示契约变化、补丁提案和准确审批 ID。修改隔离副本和运行固定 Node 回归测试分别需要批准；每项操作输入 `yes` 后才执行，其他输入或输入结束均拒绝。拒绝后任务停止，此前批准的操作不会自动回滚，源样例不改变。

每次运行自动创建新的 `.private/runs/harness-demo-*` 目录，终端给出文件位置：`report.json` 保存摘要，`run.json` 保存完整工具轨迹、审批与证据。重复运行无需手动更换名称。免密钥演示不提供跨进程恢复；要体验真实模型与审批恢复，请按[模型配置](model-setup.md)使用 `agent-run` 等入口。当前任务仍限于内置受控接口与样例仓库。

## 2. 核对代码与接口文档

先编译，再扫描仓库自带的样例：

```bash
npm run build
node dist/src/cli.js repo --root test/fixtures/repository --document test/fixtures/repository/openapi.json
node dist/src/cli.js repo-plan --root test/fixtures/repository-v2 --document test/fixtures/repository-v2/openapi.json
```

报告给出发现的问题及其文件、行号。样例故意包含文档未声明的调用和缺失的环境配置，因此发现问题时返回退出码 1 是预期结果。

如需体验隔离修正，可运行：

```bash
node dist/src/cli.js repo-verify --root test/fixtures/repository-v2-repair --document test/fixtures/repository-v2-repair/openapi.json --workspace ../a-pidoc-repair-demo --approved true
```

`--approved true` 表示批准这次隔离验证。输出目录必须尚不存在，且位于源仓库之外；重复运行时请换一个新目录。这里只处理支持的 URL 替换和环境模板补充。

## 3. 检查接口升级的影响

以下示例比较两份接口规范，并定位受影响的调用：

```bash
node dist/src/cli.js contract-diff --previous test/fixtures/repository-v3-impact/old.json --next test/fixtures/repository-v3-impact/new.json
node dist/src/cli.js contract-impact --root test/fixtures/repository-v3-impact --previous test/fixtures/repository-v3-impact/old.json --next test/fixtures/repository-v3-impact/new.json
```

发现不兼容变化或受影响的调用时，命令返回退出码 1。报告用于帮助你决定是否迁移，并不意味着程序运行失败。

在样例副本中验证支持的迁移：

```bash
node dist/src/cli.js contract-verify --root test/fixtures/repository-v3-migration --previous test/fixtures/repository-v3-migration/old.json --next test/fixtures/repository-v3-migration/new.json --workspace ../a-pidoc-migration-demo --approved true
```

同样需要批准与新的输出目录。迁移只处理可证明无损的字面量类型转换，不推测字段重命名或业务值。

## 4. 体验协作与巡检

```bash
npm run demo:team
npm run demo:reliability
```

团队演示在本地处理工单、诊断、回复草稿与案例保存，不发送真实平台消息。巡检演示展示健康检查、临时故障调查和需要人工接手的异常，使用可控模型响应，不需要真实 API Key。

也可以单独体验输入转换与 Postman 导入、导出：

```bash
node dist/src/cli.js collaboration-demo
node dist/src/cli.js collaboration-normalize --platform jira --input examples/collaboration/jira-issue.json --tenant team-a
node dist/src/cli.js postman-import --input examples/collaboration/postman-collection.json
node dist/src/cli.js postman-export --input examples/collaboration/requests.json
```

## 5. 启动本地服务

```bash
npm run serve
```

在另一个 PowerShell 终端调用样例诊断：

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/debug -ContentType application/json -Body '{"caseId":"auth-header"}'
```

这个入口适合本地调用。真实请求还需要配置允许的主机和端口；监听非本机地址时必须配置访问令牌，详细设置见[模型与服务配置](model-setup.md)。

## 6. 验证运行结果

基础检查与两类独立评测：

```bash
npm run check
npm run eval:contract
npm run eval:collaboration
```

报告中的 `passed` 表示符合该案例的预期。对于没有权限、存在风险或无法确认的情况，停止操作也可能是正确结果，不应将它理解为接口已经恢复。

完整检查流程见[验证指南](../verification.md)，模型辅助调查见[模型配置](model-setup.md)。

---

[文档中心](../README.md) · [项目首页](../../README.md)
