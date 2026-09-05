# V1 本地复现示例

先在终端 A 启动只监听本机的 Mock API：

```bash
node examples/mock-api.mjs
```

终端 B 编译项目并诊断错误 curl。初始请求会得到 415，A-Pidoc 根据规范修正 `Content-Type`，第二次请求成功：

```bash
npm run build
node dist/src/cli.js curl --input examples/order.curl --spec examples/order-spec.json --allow-host 127.0.0.1
```

也可以从 OpenAPI operation 生成并执行请求：

```bash
node dist/src/cli.js openapi --document examples/order-openapi.json --path /orders --method POST --allow-host 127.0.0.1
```

验证危险 Host 被拒绝：

```bash
node dist/src/cli.js curl --command "curl https://example.com" --spec examples/order-spec.json --allow-host 127.0.0.1
```

报告中的 Authorization、Cookie、token、secret 和 password 字段会显示为 `[REDACTED]`。
