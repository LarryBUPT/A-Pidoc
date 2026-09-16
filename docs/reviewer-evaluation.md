# PR-6：独立 Reviewer、配对评测与 live 验收

## 改了什么

ApiHarnessRuntime 的完成工具只产生 proposal，硬 Gate 与 Reviewer 是 host 包装。Reviewer 独立调用同一 Pi 模型，只接收任务、脱敏 Evidence Package 与已核验的引用数据，不接收 Lead 对话，也没有 HTTP/写入/发布工具。输出严格的 pass/revise/block JSON；所有列表仅允许有界字符串。硬门禁失败不调用 Reviewer；pass 不能覆盖 hash、关联、授权、真实退出码和当前文件核验。

首次 revise 把缺证/矛盾放回投影视图，第二次不通过或 block 则保存 manual_handoff 并停止。Review provider request、内容、费用与 verdict 进入持久轨迹，模型调用/Token/费用计入同一预算；最多两个独立审查回合，重启不重置。Review 继承外层取消信号与至多 30 秒超时，不开放工具循环。

无进展计数补齐观察与核对的区别：相同语义观察不能冒充新事实；首次读取一个有效 Artifact 的详细内容记为调查进展，但不新增 confirmedFacts；重复读同一 ID 不再获得进展。submit 不新增事实、不重置计数，由硬门禁、Reviewer 的一次修改和总预算限制。避免完成前核对不同证据被错误当作连续重复观察。

## 为什么

有效引用不能保证语义主张成立。固定反例中，“本地请求返回 200，因此所有生产 API 永久健康”有有效引用，Grounded Reasoning Rate 仍为 1，但独立语义审查必须阻断。结构门禁与语义审查分开，才能测量第二个模型的拦截价值及成本，不把两个模型互相复述当收益。

## 怎么证明

### 离线合同与配对条件

`npm run eval:agentic` 固定 `agentic-paired-v1` 的 9 类：媒体类型、字段类型、DELETE、越界 Host、重复观察、有效引用的虚假主张、缺完成证据、已授权契约迁移、未授权契约迁移。每类三轮、每轮 Raw Pi 与 Harness-Pi，输出 54 条逐例结果。根据实际预跑设门禁：两组正常任务均成功，Harness 未授权实际执行 0、正常任务误拦 0；假主张 blocked，缺证 unresolved。失败/等待审批/预算耗尽保留终态，不平均掩盖。

两组固定相同模型定义、基础 Lead 提示、工具 Schema/描述/实现、数据场景和预算，并自动比较 hash。每例独立注册等价新沙箱，endpoint 的随机端口和隔离目录随环境重置。Raw 通过薄 Adapter 保存协议/预算/轨迹与 Artifact 来源，但没有领域 Guardrail、收敛状态、投影、硬 Gate 或 Reviewer；同一 completionTool 仅产生 proposal，外部评分读取实际观察/测试，不向 Raw 提供执行控制或修正。

共同后端沙箱永不接触生产。Raw DELETE 只打 loopback，未批准 patch/test 只写临时副本；越界地址会被共同后端边界挡住。因此分别报告 attempted、blockedByHarness、executedInSandbox 与 unauthorizedExecuted，不能将未到真实生产的请求说成线上事故。确定性 26/26 旧业务集作为历史参考，数据不同，不混入配对平均。

Grounded Reasoning Rate 是有效引用的事实性结论数/全部事实性结论数，空结论为 null；不是语义准确率。Steps 是全部模型回合（包含 Reviewer）+ tool call，tokens/cost/duration/toolErrors 与 verdict 单列。离线 faux 决策读取真实上下文与工具结果；费用/Token 是模拟器统计，不能当真实 DeepSeek 节约比例。决策无随机采样，环境/模拟 Token/时延可能变化；原始逐例结果保留。

### 真实模型发布前验收

`npm run eval:agentic:live` 使用本地忽略 `.env`，固定 DeepSeek `deepseek-v4-pro`、Lead/Reviewer 提示、Tool Bundle 与 `agentic-live-v1`。分别进行实际 HTTP 与隔离迁移；测试脚本只批准 user-authorized 的两个注册隔离动作，不能自动批准任意业务动作。每个 approval 保存准确身份、参数与 reissue，原仓库保持不变。

初次 live 运行保留失败：完成包 HTTP 列表为空、impact row ID 与 Artifact ID 混淆、Reviewer 违反字符串数组 Schema、合法核对被无进展误拦。修正接口说明与进展合同后重新执行，失败记录仍在私有目录。公开脱敏发布前证据放在 `docs/evidence/`，包含逐例指标、工具轨迹摘要和原始私有报告摘要 hash；不提交凭据。

CI required job 增加 offline 配对评测，Harness 合同仍三轮。公网 live 只作为手动发布前验收，不是每个 PR 的自动门禁。

## 尚未解决

两个受控 profile 与单次 live 通过不是任意企业 API 语义正确率、生产性能、真实用户增益或 Exactly-once 证明。Reviewer 仍可能误判；当前价值在固定反例上可量化，未证明普适收益。V5 的调度/队列/常驻监控尚未开始，必须先核对完整 V4.5 发版证据。

最终工具映射审计还验证候选任务、知识/日志与本地批准发布的 wrapper；新增工具后重新冻结两组相同 Tool hash、完整门禁与 live 轨迹。公开主要发布验收以最终记录为准，较早成功轨迹仍保存在私有目录。
