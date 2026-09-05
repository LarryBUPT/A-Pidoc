# 贡献与发布工作流

本项目采用轻量 GitHub Flow，并用 GitHub Actions 做质量门禁、用 Release Please 管理版本与 GitHub Release。

## 需求到完成

1. 新建 Issue，写清场景与可自动验证的验收标准。
2. 从 `main` 创建短生命周期分支：`feat/<issue>-<topic>`、`fix/<issue>-<topic>` 或 `docs/<issue>-<topic>`。
3. 修改代码，同时补充测试；AI 行为变更至少补一个固定评测 Case。
4. 本地运行 `npm ci` 和 `npm run check`。
5. 使用 Conventional Commits 提交，例如 `feat: parse curl input`、`fix: block redirect to untrusted host`。
6. 创建 PR，在正文中填写 `Closes #<issue>`。CI 必须通过后才能合并。
7. PR 合并后关联 Issue 自动关闭；Release Please 更新或创建 Release PR。
8. 合并 Release PR 后自动更新版本与 CHANGELOG、创建 `vX.Y.Z` tag 和 GitHub Release。

PR 被放弃时应直接关闭，并保留 Issue；需求只有在验收完成后才关闭。

## 版本规则

- `fix:` 产生 patch 版本。
- `feat:` 产生 minor 版本。
- 提交正文包含 `BREAKING CHANGE:` 时产生 major 版本。
- `docs:`、`test:`、`ci:`、`chore:` 默认不触发新版本。

当前仓库不发布 npm 包。这里的“发版”是可追溯的 Git tag + GitHub Release；未来有真实部署目标时，再让部署工作流只消费已发布版本。

## AI 变更约束

- 代码、模型/参数、Prompt/Skill、Tool/MCP、评测集/数据应尽量拆成不同 PR。
- V0 的 Tier A Gate 是现有固定案例与安全边界测试，必须 100% 通过。
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
