# 贡献与发布工作流

本项目采用轻量 GitHub Flow，并用 GitHub Actions 做质量门禁、用 Release Please 管理版本与 GitHub Release。

## 需求到完成

1. 新建 Issue，写清场景与可自动验证的验收标准。
2. 从 `main` 创建短生命周期分支：`codex/<issue>-<topic>`；topic 用短横线描述本次唯一目标。
3. 修改代码，同时补充测试；AI 行为变更至少补一个固定评测 Case。
4. 按下方“本地贡献门禁”执行与当前 CI 一致的检查；依赖安装与生产依赖审计使用官方 npm registry。
5. 使用 Conventional Commits 提交，例如 `feat: parse curl input`、`fix: block redirect to untrusted host`。
6. 创建 PR，在正文中填写 `Closes #<issue>`。CI 必须通过后才能合并。
7. PR 合并后关联 Issue 自动关闭；Release Please 更新或创建 Release PR。
8. 合并 Release PR 后自动更新版本与 CHANGELOG、创建 `vX.Y.Z` tag 和 GitHub Release。

PR 被放弃时应直接关闭，并保留 Issue；需求只有在验收完成后才关闭。

## 本地贡献门禁

当前命令以 [.github/workflows/ci.yml](.github/workflows/ci.yml) 为准，在仓库根目录依次运行：

```bash
npm ci --registry=https://registry.npmjs.org
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
npm run build
npm run eval:tier-a
npm run eval:repository
npm run eval:contract
npm run eval:collaboration
npm run eval:harness
npm run eval:agentic
npm run eval:reliability
npm run eval:performance
```

`eval:tier-a` 包含全量单测与三轮离线 Pi 稳定性评测。CI 在全部评测后执行 `git diff --exit-code`，检查已跟踪生成物没有差异；本地尚未提交的修改应核对评测前后差异，不能把待提交修复本身当成生成物错误。公网模型评测不属于上述 required 门禁。

## 版本规则

- `fix:` 产生 patch 版本。
- `feat:` 产生 minor 版本。
- 提交正文包含 `BREAKING CHANGE:` 时产生 major 版本。
- `docs:`、`test:`、`ci:`、`chore:` 默认不触发新版本。

当前仓库不发布 npm 包。这里的“发版”是可追溯的 Git tag + GitHub Release；未来有真实部署目标时，再让部署工作流只消费已发布版本。

秋招项目验收要求可复现的性能指标与优化证据；长期生产SLO和生产部署不属于完成条件。并发探测变更需运行 `npm run eval:performance`，检查同负载的结果一致、错误/模型请求数和并发上限，报告实际耗时/吞吐/单请求P50/P95。CI不使用依赖机器速度的收益阈值；发布材料必须保留完整样本和无延迟对照，不能把受控I/O收益外推为公网模型收益。

## AI 变更约束

- 代码、模型/参数、Prompt/Skill、Tool/MCP、评测集/数据应尽量拆成不同 PR。
- 当前 required Gate 包含“本地贡献门禁”列出的构建、全部自动测试、三轮离线 Pi Tier A，以及 Repository、Contract、Collaboration、Harness、Agentic、Reliability、Performance 评测，必须全部通过。
- Pi 行为变更必须使用官方 Agent 运行时与可控 provider 离线复现；Tier A 至少连续运行 3 次并保持 100%，较大回归集放到 nightly。
- 公网模型只做人工验收或独立的可选评测，不作为 required CI，避免密钥暴露、费用失控和外部服务波动阻断合并。
- 模型与外部服务必须锁定明确版本，Prompt、Skill 和评测集必须进入 Git。
- 每个 PR 都要写受影响范围与回滚方式，禁止把密钥或完整敏感 Trace 写入 Issue/PR。

## 建议的仓库规则

在 GitHub 为 `main` 建立 Ruleset：

- 禁止直接 push，所有变更经 PR。
- 要求 `Build, unit tests, and Tier A eval` 状态检查通过。
- 要求分支与 `main` 保持最新、所有讨论已解决。
- 单人项目可暂不强制批准数；有协作者后设为至少 1 个批准。
- 禁止 force push 和删除 `main`。

工作流在未配置 Secret 时会回退到内置 `GITHUB_TOKEN`。为让 Release Please 创建的 PR 也触发正常 CI，仍建议配置仓库 Secret `RELEASE_PLEASE_TOKEN`：使用只授权本仓库的 fine-grained PAT，并仅授予 Contents 与 Pull requests 的 Read and write 权限。不要把 token 写入代码或 Issue。
## V4.5 增量门禁

Pi 精确锁定 `0.85.1`，运行要求 Node 22.19+。除既有门禁，还须执行 `npm run eval:harness`：三轮离线低层 loop 合同，用 faux provider 验证工具轨迹、awaited sink、暂停/继续与串行边界。完整迁移标准见 [Harness 文档](docs/agentic-harness.md) 与 [Pi RFC](docs/pi-0.85.1-rfc.md)。真实模型验证仍独立受预算执行，不进入 required CI。

V4.5 PR-6 起本地/required CI 增加 `npm run eval:agentic`（54 条 offline 配对结果）。完整 V4.5 发布前须手动 `eval:agentic:live`，凭据和完整轨迹放私有忽略目录；公开仅提交脱敏证据，不把 live 作为每次 PR 的 required network gate。

V5 PR-7起本地/required CI再增加 `npm run eval:reliability`：三轮计划/探测/队列/真实子进程中断恢复合同与faux场景。发布V5前手动 `eval:reliability:live`，保留私有失败预跑、任务轨迹与原报告hash，公开脱敏摘要。Worker复用原Harness，禁止用第二套模型执行loop替代；本地JSON与隔离副作用不作为生产SLO或Exactly-once证据。
