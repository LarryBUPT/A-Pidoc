# 模型与服务配置

本地入门演示不需要模型密钥。想在请求诊断中使用模型，或体验复杂任务调查时，再配置 Pi 模式。下面的命令都在仓库根目录运行。

## 配置密钥

复制配置模板。已有 `.env` 时直接编辑现有文件，避免覆盖自己的设置。

```powershell
Copy-Item .env.example .env
```

用编辑器打开 `.env`，把 `DEEPSEEK_API_KEY` 的占位值替换为自己的密钥。该文件已被 Git 忽略，请勿提交或分享。

确认配置后，可选择以下入口：

```bash
npm run test:pi:live
npm run serve:pi
```

第一条命令运行一次真实模型冒烟检查；第二条加载 `.env` 并启动本地服务。两者都会使用真实模型，可能产生费用。普通的 `npm run demo`、`npm run check` 和离线评测不加载 `.env`，也不调用公网模型。

## 常用设置

| 变量 | 用途 |
| --- | --- |
| `A_PIDOC_REASONER=pi` | 在请求诊断中启用模型 |
| `DEEPSEEK_API_KEY` | DeepSeek 密钥；也可使用 `A_PIDOC_PI_API_KEY` |
| `A_PIDOC_PI_PROVIDER` | 指定模型服务，项目默认 `deepseek` |
| `A_PIDOC_PI_MODEL` | 指定模型，项目默认 `deepseek-v4-pro` |
| `A_PIDOC_PI_FALLBACK` | `none` 为默认；`deterministic` 允许请求诊断在模型不可用时使用内置规则 |
| `A_PIDOC_PI_TIMEOUT_MS` | 单次请求诊断的模型等待时间，默认 30000 毫秒 |
| `A_PIDOC_PI_MAX_OUTPUT_TOKENS` | 单次请求诊断的输出上限，默认 2048 |
| `A_PIDOC_PI_MAX_PROMPT_BYTES` | 请求诊断输入脱敏后的大小上限，默认 32768 字节 |

默认值以仓库配置为准。内置规则降级只适用于支持它的请求诊断入口；复杂任务调查不自动降级。

## 体验模型辅助调查

配置 `.env` 并编译后，可运行内置的本地 HTTP 调查样例：

```powershell
npm run build
node --env-file=.env dist/src/cli.js agent-run --profile runtime-api --run .private/runs/runtime-demo.json
```

这里使用注册的本地验证服务，并非任意公网接口入口。模型会根据观察结果选择工具，报告保留结果与依据。每次体验请使用新的运行文件名。

仓库迁移调查及审批操作见[模型辅助调查说明](../api-tool-bundles.md)。其中需要批准的操作必须使用报告给出的准确审批 ID；运行结束并不必然表示问题已解决。

## 真实 HTTP 与服务访问

| 设置 | 用途 |
| --- | --- |
| CLI 的 `--allow-host` / `--allow-port` | 指定请求诊断允许访问的目标 |
| `A_PIDOC_ALLOWED_HOSTS` / `A_PIDOC_ALLOWED_PORTS` | 配置 HTTP 服务允许访问的目标；默认允许端口为 `80,443` |
| `A_PIDOC_API_TOKEN` | 为 `/api/debug` 配置访问令牌；监听非本机地址时必需，至少 16 字符 |

配置访问令牌后，调用方通过 `Authorization: Bearer <token>` 发送它。该令牌用于访问本地服务，与模型密钥用途不同。客户端请求不能扩大服务端设置的访问范围。

服务默认拒绝带 `Origin` 的浏览器请求，并限制请求频率和同时执行的任务数。真实 HTTP 请求还受超时、大小与重定向等限制；诊断输出会对常见敏感字段脱敏。

---

[使用指南](getting-started.md) · [文档中心](../README.md)
