# 外部 API 基准与真实模型评测

本能力把 A-Pidoc 从“仅使用仓库内固定题”扩展为一个受限、可追溯的外部评测入口，同时保持原有 safety、evidence 和 approval 边界。它是可选验证面，不是 required CI，也不把 Schemathesis/Hurl 当成根因裁判。

验证状态（2026-09-21）：锁定 APIs.guru 样本的探针已经实跑；Directus、Hurl、Schemathesis 仅提供固定资产和命令，因开发机 Docker daemon 未运行而尚未执行 live 验证。以下能力分工描述设计职责，不代表真实产品闭环已经通过。

## 能力分工

| 组件 | 本轮职责 | 不负责 |
| --- | --- | --- |
| APIs.guru manifest | 提供仓库外 OpenAPI 文档；锁 URL、版本、字节数、hash 和许可边界 | 不调用清单内生产 API |
| 兼容性探针 | 区分 fetch、integrity、unsupported、invalid、parsed | 不自动修复解析器 |
| Directus | 提供独立真实 HTTP、鉴权、CRUD 和动态 OAS | 不作为 A-Pidoc 的产品依赖 |
| Schemathesis | 在白名单本地环境生成、缩减和重放失败 | 不产生 hidden oracle |
| Hurl | 固化 seed 与多步确定性回归，输出机器报告 | 不替代 A-Pidoc 的诊断逻辑 |
| 外部评测器 | 相同 case 下运行确定性臂和可选 Pi 臂，随后由物理分离的 oracle 评分 | 不把 runner 文案传成根因 |

## 机器契约

`src/benchmark/contracts.ts` 使用严格、带版本的 JSON 合同：未知字段、重复 ID、越界样本数、绝对/逃逸回执路径、哈希不匹配、case/oracle ID 不一致都会 fail closed。

外部 case 记录来源和环境镜像摘要、seed、唯一 Host/Port、只读 DebugTask、已观察 artifact hash、生成者和仲裁者。hidden oracle 单独记录可接受根因/状态、尝试范围和 evidence policy；执行代码只把 `case.task` 传给 orchestrator，得到 report 后才读取对应 oracle 评分。

V1 配对评测只接受 `GET` 且 `sideEffectFree: true`。这不是声称 A-Pidoc 只能诊断 GET，而是避免同一真实环境被 A/B 两臂按不同顺序修改。写入型真实评测需要“每 arm 独立 reset”的后续环境工厂。

## 报告解释

外部报告包含：实际计算的 case/oracle hash、case 声明但未由 evaluator 加载验证的 `declaredManifestSha256`、每臂 runtime metadata、oracle 标签/裁定版本/理由 hash、声明型 observation、A-Pidoc report/Trace、实际根因/状态/尝试数/evidence、耗时、模型 token/费用以及 runner 回执/原报告 hash。单个 case 失败会以 `case_error` 保留，已完成结果不会丢失。`runnerReceipts.outcome=passed` 只是来源证据；最终 `score.passed` 只由 hidden oracle 对 A-Pidoc report 的外部判分产生。

V1 报告会披露 `labelStatus`，但当前总 `passed` 仍对 oracle 中全部条目执行同一评分，不自动把 `invalid-case` 或 `environment-failure` 排除出质量分母。非 gold 标签如何进入聚合指标仍是后续评分契约，不能把当前结果解释为已实现 FR-10 的无效案例率。

完整复现命令、固定镜像和三条 Hurl 链见 [`benchmarks/external-api/README.md`](../../benchmarks/external-api/README.md)。联网、容器和付费模型运行必须由操作方显式启用并把产物写入 `.private/`。
