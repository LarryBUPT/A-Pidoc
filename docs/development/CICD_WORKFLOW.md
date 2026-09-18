# 项目 CI/CD 工作流

本文件是 A-Pidoc 的 canonical CI/CD workflow：本仓库维护、验证、PR、合并和发布的唯一规范入口。这里只保存公共工程约定，不保存个人规划、JD、私人对话或实际评审材料。

## 技术选型与边界

- GitHub Flow + GitHub Actions + Conventional Commits + Release Please。
- 当前不使用 semantic-release。语义化版本规则不等于使用 semantic-release 工具；迁移发布工具必须先获得用户明确确认，不因为某个 Skill 的默认流程而更换。
- CI 和 Release Please 的机器配置分别为 `.github/workflows/ci.yml` 与 `.github/workflows/release-please.yml`。版本来源为 `package.json`、`.release-please-manifest.json` 和 `release-please-config.json`；不得手工制造与历史 tag 冲突的版本。
- 当前发布目标为 Git tag + GitHub Release，不是 npm 发布或生产部署。不得把 Release 生成等同于生产可用。
- 项目维护不默认调用 contributor 技能，不搜索其他项目、不 fork 本仓库、不引入求职贡献流程。显式调用边界见根目录 `AGENTS.md`。

## 需求到交付

1. 明确需求和验收范围，检查分支、完整基线 SHA 与工作区差异；保留用户已有改动。只解释/诊断时不实施修改。
2. 在授权进行远端交付时，以 Issue 记录验收标准；从最新 `main` 建独立短分支 `codex/<issue>-<topic>`。仅本地配置任务可先用 `codex/<topic>`，交付 PR 前补关联 Issue，不为了遵守流程擅自远端写入。
3. 实施最小改动并补相应测试；代码、模型参数、Prompt/Skill、Tool/MCP、评测数据尽量分 PR。
4. 按当前 CI 执行本地门禁，记录命令、结果、未执行项与限制。普通开发可做本地自检，不强制额外模型或双 Agent 审计。
5. 若用户要求独立评审，进入下节的固定基线评审；未经确认的问题不直接变为修复需求。
6. 核对待提交 diff、隐私和回滚方式；使用 Conventional Commit。获准后推送功能分支并创建 PR，完整需求使用 `Closes #<issue>`，部分交付使用 `Refs #<issue>`，不提前关闭总需求。
7. PR 在当前 head/base 上通过 required CI、解决讨论且满足 ruleset 后，才可在授权范围内合并，通常使用 squash。CI 通过不等于授权合并。
8. 合并功能 PR 后 Issue 按关联自动关闭，Release Please 汇总待发变更。只有发布获准并合并 Release PR 后，才生成 tag 和 GitHub Release。

## 独立评审与有限修复

此路径仅用于明确要求的评审/验证修复，不是每次实现的前置步骤。

`固定基线 → 问题鉴定 → 独立核实 → 获准的最小修复 → 专项及回归验证 → 有限重试 → 报告/指标 → PR/CI`

- 行动前读取 `docs/review/REVIEW_GUIDE.md` 和指定轮次的 `CURRENT_BASELINE.md`；未指定轮次使用 `.private/review/current/`。缺少基线/问题范围时先请求补充，不重新审计整个项目。
- Claude Code 鉴定和复核；Codex 对确认成立且获准修复的部分实施最小改动，记录 `FIX_REPORT.md`。不能把自己的自检冒称为 Claude 或独立复核。
- 新发现建议单独交人工判断，不擅自追加本轮问题、修复或验收范围；不得改写原报告。
- 本次固化新增默认预算：同一已确认问题最多 2 轮“修复—验证”，用户可以明确指定其他预算。达到预算、同一阻塞反复出现、需要新权限/预算/范围决定时停止并报告；不无限试错，不绕过 CI/ruleset。
- 外部写操作结果不明时先读取实际状态，禁止盲目重发。基础设施失败与真实代码失败分开记录。
- 报告保存基线/差异标识、问题逐项结论、命令结果、实际轮次与残留限制。指标仅引用本轮实际测量；没有运行的检查写“未执行”，不复用历史测试数量。
- 实际报告、Trace、实验和对话存 `.private/` 忽略目录；公开仅提交公共规则、模板与脱敏证据。无明确授权不自动调用 Claude、外部模型或子 Agent。

## 当前 required CI 门禁

Node 要求以 `package.json` engines 为准；当前 CI 使用 Node 22。准确命令以 CI YAML 为准，新增/删除门禁时同步本节与贡献入口。

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

CI 最后运行 `git diff --exit-code` 检查生成物可复现。本地存在待提交改动时比较评测前后差异，不把需求修改本身误判为生成物变化。`npm run check` 只是构建与单测快捷入口，不等于全部 required 门禁。

Tier A 包含单测与三轮离线 Pi 稳定性评测。公网模型/live 评测独立受授权、预算与脱敏约束，不进入 required CI；需要特定版本 live 验收时遵守对应项目规则，不凭空声称已运行。生产依赖安全审计需要联网，不描述为完全离线。

required context 保持 `Build, unit tests, and Tier A eval`，改名需同步 ruleset。主分支保护要求 PR、CI、最新基线、讨论解决，禁止强推和删除；批准数以远端当前配置为准，不在任务中擅自改规则。

## Release Please 发布闭环

`功能 PR 合并 → main CI 成功 → Release Please 创建/更新 Release PR → 版本分支 CI → 发布确认 → 合并 Release PR → main CI 成功 → tag/Release → 核验`

- `fix:` / `feat:` / `BREAKING CHANGE:` 按发布配置产生版本；`docs:`、`test:`、`ci:`、`chore:` 默认不触发新版本。不为纯治理文档变更强制发版。
- Release Please 通过 main CI 的成功 `workflow_run` 触发，保留现有 token fallback；不要读取/打印凭据或把个人 token 自动复制到 Actions Secrets。
- 当前兼容路径：机器人创建/更新版本 PR 后显式 dispatch `ci.yml`；该 CI 全部成功后发布同名 commit status。不得删除这一配套而让版本 PR 缺 required check，也不得手工伪造 success 来合并失败代码。
- 手动 dispatch 发布工作流前，确认对应 main 基线的 CI 已成功；不会因为工作流支持手动触发就跳过门禁。
- 合并前核对版本、CHANGELOG、回滚方式与 head SHA；发布后核验 tag、Release、CI 与本地版本。MVP/预览发布需核验 Pre-release 标记，不能假设发布工具已自动设置。
- 任何合并/发布失败，先诊断实际状态；禁止通过 ruleset bypass、强推或伪造检查补救。授权范围之外停止并请求方向。

## 配置冲突与技能边界

项目指令不能覆盖系统/开发者规则。若宿主仍把“提交 PR”强制路由到 contributor，明确指出该更高层触发条件；不要称 `AGENTS.md` 为技能加载器级禁用开关。需要全局 explicit-only 策略时，单独确认并修改技能源的 `agents/openai.yaml`，不要编辑会被插件更新覆盖的缓存，也不要全局禁用来影响其他项目。

以后涉及 CI/CD 的任务先读取根目录 `AGENTS.md` 和本文件，再按任务范围执行；仅提及 contributor 的误触发问题，不等于显式要求执行 contributor 工作流。
