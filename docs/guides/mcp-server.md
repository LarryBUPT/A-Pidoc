# MCP Server 使用指南

A-Pidoc 可以通过标准 MCP stdio transport 向 Claude Code、Codex、Pi 等宿主暴露三项能力：

- `read_api_document`：读取宿主预先注册的 OpenAPI/Swagger 文档，返回 operation、method、path、Header 要求和 Request Schema。
- `execute_http`：执行文档中已注册的 operation，并返回状态码、响应 Header、Response、耗时和 Evidence Artifact ID。
- `read_evidence`：按 Artifact ID 读取完整性校验后的脱敏请求、响应和证据元数据。

MCP 只是协议适配层。HTTP 调用仍经过 A-Pidoc 的 Tool Registry、ApiGuardrail、Host/Port 白名单、危险方法判断、超时、禁重定向、响应大小限制、脱敏和 Evidence 工作区。

## 快速验证

```bash
npm run demo:mcp
```

演示会启动一个仅监听 `127.0.0.1` 随机端口的临时诊断接口，再由官方 MCP Client 通过 stdio 完成：

```text
read_api_document
→ execute_http (HTTP 415)
→ read_evidence
→ execute_http (HTTP 200)
```

终端输出包含完整 MCP Trace；原始脱敏轨迹保存在 `.private/mcp-demo/<run-id>/trace.json`。

## 启动配置

MCP Server 不接受 Agent 指定任意文档路径或 URL。宿主进程必须显式注册文档和网络边界：

| 环境变量 | 必填 | 含义 |
| --- | --- | --- |
| `A_PIDOC_MCP_OPENAPI` | 是 | 宿主注册的本地 OpenAPI/Swagger JSON 文件路径 |
| `A_PIDOC_MCP_ALLOWED_HOSTS` | 是 | 逗号分隔的允许 Host |
| `A_PIDOC_MCP_ALLOWED_PORTS` | 是 | 逗号分隔的允许 Port |
| `A_PIDOC_MCP_TRACE_FILE` | 否 | 轨迹文件；默认写入 `.private/mcp/` |
| `A_PIDOC_MCP_ENVIRONMENT` | 否 | `sandbox`、`staging` 或 `production`；默认 `sandbox` |
| `A_PIDOC_MCP_TIMEOUT_MS` | 否 | HTTP 超时，默认 5000，最大 60000 |
| `A_PIDOC_MCP_MAX_RESPONSE_BYTES` | 否 | HTTP 响应体读取上限，默认及最大均为 1000000；完整 ToolResult 仍受共享 Tool Registry 的 32768 字节序列化上限约束，因此结构化输出可能更早返回 `TOOL_OUTPUT_TOO_LARGE` |

配置完成后，MCP 宿主应以仓库根目录为工作目录启动：

```bash
npm run mcp
```

stdout 只承载 MCP JSON-RPC；启动信息和错误写入 stderr。

## 方法安全边界

`GET` operation 默认视为无副作用读取。`POST`、`PUT`、`PATCH` 默认拒绝；只有用于联调验证且确实无副作用的 operation，才可在受信任文档中显式声明：

```json
{
  "x-a-pidoc-side-effect-free": true
}
```

`DELETE` 始终拒绝。首版不从 MCP Tool 参数接收凭据；包含 Authorization、Token、Cookie 等敏感参数的调用会被现有敏感参数边界阻止。企业鉴权、多租户和远程 Gateway 不属于首版范围。

## 审计字段

每次 Tool 调用都会在同一 Harness 轨迹中追加 `mcp_call_trace`，包含：tool name、内部 call ID、MCP protocol request ID、开始/结束时间、耗时、仅字段名级别的 input summary、执行结果、HTTP 状态码、生成的 Artifact ID 和 error code。`tool_call`、`tool_result`、Guardrail policy 与 Evidence 记录同时保留，可用于证明协议调用和真实 HTTP 执行。
