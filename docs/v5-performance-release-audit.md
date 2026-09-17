# V5 秋招性能补充发布审计

## 改了什么

完整V5基础版本 [v0.17.0](https://github.com/LarryBUPT/A-Pidoc/releases/tag/v0.17.0)已发布。本次性能与收敛治理补充正式发布 [v0.18.0](https://github.com/LarryBUPT/A-Pidoc/releases/tag/v0.18.0)，tag/非draft且非prerelease Release target均为 `a0a7d670dec014235fc2c62e43f797ac6e105220`，仍属于V5，不是V6。长期SLO与生产部署按秋招项目最新范围排除，不能据此判定V5未完成。

独立注册确定性探针默认1、显式最多4并发；宿主三项并行声明、同origin串行、未声明计划独占、slot先保存、禁用/取消/失败排空与tick串行均有反例。调查工作区补充真实已读状态和既有完成合同，压缩保留目标/预算；模型自主选工具，原精确审批、Evidence Gate、Reviewer与NO_PROGRESS_LIMIT保持原标准。

## 为什么

秋招应能说明瓶颈、提出优化并拿出同场景前后数据。受控HTTP并行重叠等待，JSON持久化保持串行；不能把参数1/4批次收益外推为生产吞吐、模型费用或完整跨版本产品收益。

## 怎么证明

| 阶段 | 最新SHA及结果 | 验证流水线 |
| --- | --- | --- |
| Issue69 / [功能PR70](https://github.com/LarryBUPT/A-Pidoc/pull/70) | `4c04cb1d9783d5a85acff0e2e657a6e11a965cf9` required CI success，squash `b0cbed770a741b84c82f6b59471419f3e4319887` | PR [35199925937](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35199925937)；main [35200190073](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35200190073)；Release Please [35200399832](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35200399832)均success |
| [版本PR71](https://github.com/LarryBUPT/A-Pidoc/pull/71) | `9a948bd433da825b2f4e8cc3a858cee400469111` full CI + required commit status success；仅package.json、package-lock.json、manifest、CHANGELOG四文件；squash/tag `a0a7d670dec014235fc2c62e43f797ac6e105220` | [35200421699](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35200421699) success |
| 正式发布 | 四个版本位置（lock两处）与CHANGELOG均0.18.0；本地/远程tag/Release一致 | main [35200660897](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35200660897)；Release Please [35200914862](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35200914862)均success |

版本PR的bot pull_request运行 [35200421229](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35200421229) 实际结论failure，0 jobs；同最新SHA的完整workflow_dispatch成功并发布required status。该状态历史保留，不冒充失败测试已经通过。

173单测（新增8并发与1跨压缩合同），原Pi/Harness三轮/Repository/Contract/Collaboration/54配对、可靠性20合同三轮、业务26、官方registry audit0均通过。CI加入双负载性能语义/容量门禁，不设置机器相关速度阈值，所有评测后git diff复现检查通过。

原方案V5与AR-01～08：固定计划/slot幂等、有界持久队列与资源锁、健康零模型/异常升级、复用ApiHarnessRuntime、自主工具/原轨迹恢复/执行不明接管、small/large/reviewer预算分级、真实合同/趋势与工单、原准确审批/证据冲突接管均保留并回归。与03纠偏的并行要求一致，三项声明来自宿主而非模型；没有第二套模型loop。JD中的时延/吞吐、状态/恢复/工具治理、工程交付与评测新增直接证据；向量RAG、真实企业用户等仍不能据此声称完成。

最终受控40ms场景批次P50 760.91→222.14ms，下降70.81%，配对中位加速3.43倍、中位吞吐提升241.19%；零注入延迟对照下降43.67%。各模式各负载96次HTTP，逐例语义一致、错误/模型调用0；原报告hash `86974981bd63e097b3864979573c586733ff09d1308e3a9051729d690365bb2a`。六组AB/BA、暖身剔除、各类分位数、样本/环境/源码见 [性能说明](v5-performance.md)及[原始配对样本](evidence/v5-performance.json)。

[发布前live](evidence/v5-performance-live.json)最终05真实DeepSeek：健康6探测/0模型、临时故障completed/resolved、10模型/13工具/34555Token/$0.009585515 SDK/39703ms、1准确批准/1本地回执/Reviewer pass；持续Schema异常实际读监控/API证据后NO_PROGRESS_LIMIT接管。原报告hash `1634dab5f6143fbbd85e2e2ae52c67db093608b189acf61043c1f36c78211ab3`。01～04真实失败均保留；04仅goal澄清仍失败，05看板补充后单次成功不证明唯一根因已定位或稳定成功率提升。

旧v0.17.0/[发布审计](v5-release-audit.md)、v0.16.0及其原始公开/private证据不覆盖。各阶段审查只发布代码和脱敏证据，私有方案/题库/凭据不入仓；私有题库112题112简短完整答案连续，104～112追加末尾。

## 尚未解决

本机六批小样本P95是描述性统计；没有生产分布式探针互斥、生产Exactly-once、外部平台账号采纳、付费模型前后对照或真实用户增益。有限Schema/注册loopback后端、本地JSON容量/遗留锁人工恢复边界保留。后续可独立对照减少健康无变更写入、批量持久化、增量日志和背压，必须保留slot/账本/证据恢复合同；长期SLO和生产部署不属本轮未完成要求。
