# 已停用的上游工作流

这里的文件**不会被执行**：GitHub 只认 `.github/workflows/` 下的工作流。放在这里是为了留住上游的实现，
需要时（例如你配好了自己的 secrets）把对应文件移回 `.github/workflows/` 即可。

移走的原因：这些工作流依赖发布凭据（`DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`、`DEEPSEEK_API_KEY`、
`AUR_SSH_PRIVATE_KEY` / `AUR_REPO_SSH_URL`），而 secrets 不会随 fork 复制，所以在 fork 里它们只会失败；
其中 `nightly-pre-release` 还是**每天 02:00 定时**跑，会持续报错。

| 文件 | 原触发条件 | 缺什么 | 移回前要改什么 |
| --- | --- | --- | --- |
| `electron-release.yml` | 改 `realeco-release` 文件 / 手动 | `AUR_SSH_PRIVATE_KEY`、`AUR_REPO_SSH_URL` | 版本校验规则、发布目标仓库、AUR 包名 |
| `canary-pre-release.yml` | 手动 | 同上 | 同上 |
| `release-candidate.yml` | 手动 | 同上 | 同上 |
| `nightly-pre-release.yml` | 每天 02:00 | 同上 | 同上；不打算做每日版就保持停用 |
| `docker-stack-publish.yml` | 改 `deploy/docker/VERSION` / 手动 | `DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN` | 镜像名 |
| `sync-server-docker-publish.yml` | 改 `sync-server/package.json` / 手动 | 同上 | 镜像名 |
| `triage-issues.yml` | 有 issue | `DEEPSEEK_API_KEY` | 提示词与规则在 `.github/triage/`，其中引用了上游的下载渠道 |
| `triage-pr.yml` | 有 PR | 无（纯确定性逻辑） | 标题前缀规则按需调整 |
| `triage-stale.yml` | 每天 03:00 | 无 | 处置时限按需调整 |

仍然启用的四个（不需要发布凭据，在 fork 里能正常跑）：

- `.github/workflows/pr-unit-tests.yml` — PR 跑单测
- `.github/workflows/docker-stack-check.yml` — 改 Docker 相关文件时校验编排
- `.github/workflows/linux-arm64-package-check.yml` — 改打包相关文件时校验 Linux arm64 包
- `.github/workflows/codemap-sync.yml` — main 落地后重新生成 `docs/CODEMAP.md` 并提交

注意：工作流停用与应用运行无关。本地 `npm run dev` / `build:electron` 不读 `.github`；
会影响已安装应用的是 `package.json` 的 `build.publish`（写进 `app-update.yml`，决定更新去哪个仓库查）。
