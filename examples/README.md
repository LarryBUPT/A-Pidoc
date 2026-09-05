# V1 本地复现示例

先在终端 A 启动只监听本机的 Mock API：

```bash
node examples/mock-api.mjs
```

终端 B 编译项目并诊断错误 curl。初始请求会得到 415，A-Pidoc 根据规范修正 `Content-Type`，第二次请求成功：

```bash
npm run build
node dist/src/cli.js curl --input examples/order.curl --spec examples/order-spec.json --allow-host 127.0.0.1 --allow-port 3001
```

也可以从 OpenAPI operation 生成并执行请求：

```bash
node dist/src/cli.js openapi --document examples/order-openapi.json --path /orders --method POST --allow-host 127.0.0.1 --allow-port 3001
```

验证危险 Host 被拒绝：

```bash
node dist/src/cli.js curl --command "curl https://example.com" --spec examples/order-spec.json --allow-host 127.0.0.1 --allow-port 443
```

报告中的 Authorization、Cookie、token、secret、password、常见自由文本密钥和基础个人信息会显示为 `[REDACTED]`。

## 切换到真实 Pi Agent

Pi 模式默认使用 Pi 内置的 DeepSeek provider 和 `deepseek-v4-pro` 模型。请在自己的终端手动设置密钥，不要写入仓库：

```powershell
$env:A_PIDOC_REASONER = "pi"
$env:DEEPSEEK_API_KEY = "<your-api-key>"
npm run build
node dist/src/cli.js curl --input examples/order.curl --spec examples/order-spec.json --allow-host 127.0.0.1 --allow-port 3001
```

若要在模型不可用时保留确定性诊断，可额外设置 `$env:A_PIDOC_PI_FALLBACK = "deterministic"`。不设置时，模型错误会明确阻断任务，不会静默声称 Pi 已执行成功。
