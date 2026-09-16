# V5 完整受控版本发布审计

## 改了什么

V5正式版本为 [v0.17.0](https://github.com/LarryBUPT/A-Pidoc/releases/tag/v0.17.0)，tag/Release target对应 `423142eb59e0f9023ecddee465d43c957f4afa56`。Issue #64 → [功能PR #65](https://github.com/LarryBUPT/A-Pidoc/pull/65) → squash `f3c181d220dc82d01a522fbc548b47bec3f12e9d` → [版本PR #66](https://github.com/LarryBUPT/A-Pidoc/pull/66) → release commit。V4.5 `v0.16.0@9d59bd3`及其最终07封版保持历史原证据。

V5增加固定计划、有界确定性探测、合法/缺required负例、响应Schema/契约header/状态/时延异常、同租户聚类、本地Bug/回归工单、持久Queue/Worker、取消/超时/预算和恢复。复杂事件复用原Pi Harness，高风险本地草稿准确批准，原监控合同复查后才verified；流程见 [持续可靠性](reliability-v5.md)。

## 为什么

健康探测不需要每次付费调用模型。队列将触发与调查解耦，原Harness继续治理工具、权限、事实和结论。历史快照不能冒充当前健康，已resolved run恢复也不能跳过原监控复查。功能合并不能代替版本PR、tag和真实Release。

## 怎么证明

功能最新head `2520e023f89ed543e5a7da75838166df767d3b8e` 的 [required CI](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35125778299)成功；功能main的 [CI](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35126123735)和 [Release Please](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35126346634)成功。版本PR最新head `42efee3acfa114d6eb86b914cbf04922340700b1` 的 [required CI](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35126376012)成功，dispatch status成功；仅package/lock/manifest/CHANGELOG四文件变更，版本一致。发布commit的 [main CI](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35126676412)/[Release Please](https://github.com/LarryBUPT/A-Pidoc/actions/runs/35126884717)成功，tag、非draft/prerelease Release及四个版本文件一致。

版本PR的bot pull_request运行35126375646未创建job并显示failure；既定Release Please工作流另对相同SHA触发完整workflow_dispatch，35126376012全部门禁和required status成功后才合并。保留该自动运行记录，不把未启动的job写成测试失败或隐去记录。

164项总测试，20项V5专项连续三轮；全部旧Pi/Harness/Repository/Contract/Collaboration门禁、54同条件配对、业务26/26、生产依赖audit0继续通过。[离线摘要](evidence/v5-offline.json)明确faux，并包含实际HTTP/文件/子进程中断与单回执恢复；[真实模型摘要](evidence/v5-live.json)对应DeepSeek最终04：健康6探测/0模型，临时故障completed/1准确审批/1本地回执/Reviewer pass，10模型/14工具/34,085 Token/$0.00933191 SDK/24,842ms。Schema调查得到实际监控/API规范后NO_PROGRESS阻断，保留manual_handoff，不声称模型修复了字段。

最终04原报告SHA-256 `27af76a281e74ceecb84e5b1d375fb2799db58a3103ff08fce75c78ba15f7037`；失败01与较早成功02/03保留私有。早期专项复查偶发失败保留，补诊断后20次定向检查、最终三轮及required CI通过；根因未复现，不编造已定位修复。私有103题按1～103排列，逐题附参考答案；私有材料与凭据不入仓。

## 尚未解决

本地JSON/注册loopback/本地草稿是受控验收范围，不证明真实企业平台写回或生产SLO。派发崩溃可能缺测、retention有界；共享写锁遗留需停止所有相关进程后人工备份核验，不抢锁。无生产DB/分布式Queue/部署、向量RAG、端边云、用户增益或生产Exactly-once；补偿仅待新批准建议。后续迭代仍需独立Issue与相同交付流程。
