# 外部 API 基准资产

这里是可选的真实环境竖切，不属于 required CI。它不修改 Directus，也不授权请求 APIs.guru 清单中的生产 API；OpenAPI 探针只下载并解析已锁定的文档。

> 验证状态（2026-09-21）：OpenAPI 探针已经对锁定的 APIs.guru 样本实跑；Compose 只通过了静态 `config` 校验。由于开发机 Docker daemon 未运行，Directus、Hurl 和 Schemathesis 的 live 命令均未执行，其镜像拉取、CLI 参数和端到端可运行性仍属未验证。下面内容是复现资产与待执行步骤，不是 live 通过记录。

## 固定依赖与边界

- `versions.json` 同时锁定版本和多架构镜像摘要。
- Directus 只绑定 `127.0.0.1`，使用内部 Docker 网络和 `tmpfs` 一次性数据；`docker compose down` 后数据消失。
- 所有凭据必须通过当前进程环境变量传入。`env.example` 只有名称和无效占位值，不能直接当凭据使用。
- A-Pidoc 外部评测还要求显式 `--allow-host` 和 `--allow-port`。V1 配对运行只接受 GET，避免两臂共享环境时产生写副作用。
- 原始 runner 报告、变量和回执放在 `.private/benchmark-artifacts/<run-id>/`，不提交 Git。

## 1. 语料探针

```bash
npm run benchmark:probe -- --manifest benchmarks/external-api/openapi-manifest.example.json --allow-host api.apis.guru
```

Manifest 每项记录来源、版本、许可边界、原始字节数和 SHA-256。下载主机必须由操作方通过一个或多个 `--allow-host` 明确授权；manifest 自己不能扩大网络范围，私网解析仍由现有 RequestPolicy 阻断。下载失败、完整性失败、不支持特性和无效文档使用不同的阶段/错误码；批次不会因单项失败中止。探针绝不调用文档中的业务 operation。

## 2. 启动一次性 Directus

先为 `A_PIDOC_DIRECTUS_SECRET`、`A_PIDOC_DIRECTUS_ADMIN_PASSWORD` 和 `A_PIDOC_DIRECTUS_ADMIN_TOKEN` 生成每轮不同的随机值，并设置其余 `env.example` 变量。然后：

```bash
docker compose -f benchmarks/external-api/compose.yaml up -d --wait
docker compose -f benchmarks/external-api/compose.yaml ps
```

端口默认 `18055`；需要改端口时在启动前设置 `A_PIDOC_DIRECTUS_PORT`。Docker 会在端口冲突时明确失败。建议由外层 job 设置 15 分钟超时，并保存 `docker compose ... logs --no-color`、`docker compose ... images` 和 `docker version` 到私有 artifact 目录。

## 3. Seed 与三条 Hurl 链

使用已锁定 Hurl 镜像运行，`base_url` 是普通变量，Token 必须以 secret 注入。先在全新的 Directus 实例运行 seed，再运行三条业务链：身份/读取、CRUD、无效 Token。

```bash
docker run --rm --network a-pidoc-external-benchmark_benchmark -v "$PWD/benchmarks/external-api/hurl:/work:ro" ghcr.io/orange-opensource/hurl@sha256:0fafe31238304394bcba7ab49509dcbb4356798b6a99973d41ef722f6cbbb1e9 --test --variable base_url=http://directus:8055 --secret admin_token="$A_PIDOC_DIRECTUS_ADMIN_TOKEN" /work/00-seed-orders.hurl
```

三条业务链分别运行，输出目录彼此隔离；第三条链的故意无效 Token 也作为 secret 注入：

```bash
docker run --rm --network a-pidoc-external-benchmark_benchmark -v "$PWD/benchmarks/external-api/hurl:/work:ro" -v "$PWD/.private/benchmark-artifacts:/artifacts" ghcr.io/orange-opensource/hurl@sha256:0fafe31238304394bcba7ab49509dcbb4356798b6a99973d41ef722f6cbbb1e9 --test --variable base_url=http://directus:8055 --secret admin_token="$A_PIDOC_DIRECTUS_ADMIN_TOKEN" --report-json /artifacts/hurl-identity-json --report-junit /artifacts/hurl-identity.xml /work/01-identity-read.hurl
docker run --rm --network a-pidoc-external-benchmark_benchmark -v "$PWD/benchmarks/external-api/hurl:/work:ro" -v "$PWD/.private/benchmark-artifacts:/artifacts" ghcr.io/orange-opensource/hurl@sha256:0fafe31238304394bcba7ab49509dcbb4356798b6a99973d41ef722f6cbbb1e9 --test --variable base_url=http://directus:8055 --secret admin_token="$A_PIDOC_DIRECTUS_ADMIN_TOKEN" --report-json /artifacts/hurl-crud-json --report-junit /artifacts/hurl-crud.xml /work/02-orders-crud.hurl
docker run --rm --network a-pidoc-external-benchmark_benchmark -v "$PWD/benchmarks/external-api/hurl:/work:ro" -v "$PWD/.private/benchmark-artifacts:/artifacts" ghcr.io/orange-opensource/hurl@sha256:0fafe31238304394bcba7ab49509dcbb4356798b6a99973d41ef722f6cbbb1e9 --test --variable base_url=http://directus:8055 --secret invalid_token="deliberately-invalid-token" --report-json /artifacts/hurl-invalid-token-json --report-junit /artifacts/hurl-invalid-token.xml /work/03-invalid-token.hurl
```

不要把登录响应或未声明为 secret 的 Token 写进报告；这里使用 Directus bootstrap 的固定一次性 admin token，使 Hurl 能按 exact-match 脱敏。runner 使用 Compose 创建的 internal network，不使用主机网络，也不能借此访问公网。

## 4. Schemathesis 的受限发现

只针对本地 Directus，默认只读 GET、固定 seed、固定案例数和最大时长。示例命令中的报告目录必须是 `.private`：

```bash
docker run --rm --network a-pidoc-external-benchmark_benchmark -v "$PWD/.private/benchmark-artifacts:/artifacts" ghcr.io/schemathesis/schemathesis@sha256:6ef578fb45f5dc228d693676f66d7b240245e2bc0144e86326fb780215241d44 run http://directus:8055/server/specs/oas --header "Authorization: Bearer $A_PIDOC_DIRECTUS_ADMIN_TOKEN" --include-method GET --max-examples 20 --seed 20260921 --max-time 300 --output-sanitize true --report junit --report-junit-path /artifacts/schemathesis-junit.xml
```

若要允许写 operation，必须为每个 arm 创建独立的一次性 Directus 环境；本轮提供的 A-Pidoc 配对执行器会拒绝非 GET case。

## 5. 统一 runner 回执与配对评测

runner 原始文本不是根因标签。先保存原始报告，再生成只包含身份、退出码、计数和原始报告哈希的规范化回执：

```bash
npm run benchmark:receipt -- --runner hurl --runner-version 6.1.1 --case-id auth-format --raw-report .private/benchmark-artifacts/hurl-json/report.json --exit-code 0 --requests 2 --failures 0 --output .private/benchmark-artifacts/hurl-receipt.json
```

case 与 hidden oracle 必须是两个文件，且 case 中只能引用回执哈希。评测会保留已完成 case，并把单个 case 的 preflight/执行失败记录为 `case_error`，而不是丢弃整批报告。运行确定性基线：

```bash
npm run eval:external -- --cases .private/benchmark-artifacts/cases.json --oracle .private/benchmark-artifacts/oracle.json --allow-host 127.0.0.1 --allow-port 18055
```

追加 `--model` 才会加载现有 Pi provider 配置并加入 B 臂。两臂使用相同可见 case、Host/Port policy 和外部 oracle；oracle 只在 report 生成后评分。模型不可用时命令明确失败，不回退成“真实模型已通过”。

## 6. 清理

```bash
docker compose -f benchmarks/external-api/compose.yaml down --remove-orphans
```

不要加 `-v` 或依赖持久卷：本配置的业务数据位于 `tmpfs`，容器删除即完成 reset。私有 artifact 是否保留由评测轮次的证据策略决定。
