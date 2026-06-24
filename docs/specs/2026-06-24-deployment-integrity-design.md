# 本地部署可信性设计

## 目标

解决本地联调时“代码已经更新，但 Docker 仍在运行旧容器，导致联调结果失真”的问题。

系统需要满足：

- 每个核心服务都能暴露自己的构建版本信息。
- 本地重建脚本在镜像构建失败时必须直接退出，不能让旧容器继续被误当成新版本。
- 启动完成后，必须自动校验运行中服务的版本是否等于当前仓库 `HEAD`。
- 文档要明确本地联调必须通过统一脚本进行，不再鼓励直接裸跑 `docker compose up -d`。

## 根因

当前问题由两个条件叠加造成：

1. 服务镜像依赖 `node:22-alpine` / `node:22-bookworm-slim` 等远端基础镜像；当 Docker Hub metadata 拉取超时时，新镜像构建失败。
2. 构建失败时，已有旧容器仍然保持健康运行；由于健康接口只返回 `service` 和 `status`，无法判断当前容器是否对应最新代码。

因此会出现“代码已变更，但联调实际仍打到旧服务”的情况。

## 方案

### 1. 版本可见性

为核心服务 `/health` 增加以下字段：

- `service`
- `status`
- `git_sha`
- `build_time`

至少覆盖：

- `control-api`
- `bot-api`
- `wecom-worker`
- `data-service`
- `llm-runner`
- `capability-runner`

要求：

- `git_sha` 来自构建时注入的环境变量。
- `build_time` 来自构建时注入的环境变量。
- 如果没有注入值，也要返回稳定占位值，例如 `unknown`。

### 2. 构建时版本注入

相关 Dockerfile 增加：

- `ARG BUILD_SHA`
- `ARG BUILD_TIME`
- `ENV APP_BUILD_SHA=$BUILD_SHA`
- `ENV APP_BUILD_TIME=$BUILD_TIME`

`docker-compose.yml` 中对应服务的 `build.args` 需要传入：

- `BUILD_SHA`
- `BUILD_TIME`

### 3. 强制重建与版本校验脚本

新增本地脚本，例如：

- `scripts/dev-redeploy.sh`

职责：

1. 计算当前 `git rev-parse HEAD`
2. 生成当前 UTC 构建时间
3. 执行目标服务镜像构建
4. 如果任意构建失败，立即退出并报错
5. 仅在构建全部成功后执行：
   - `docker compose up -d --force-recreate`
6. 轮询各服务 `/health`
7. 校验所有服务的 `git_sha` 等于当前 `HEAD`
8. 只要有一个服务版本不匹配，就直接失败

### 4. 文档约束

README 与 compose README 需要明确：

- 本地联调前必须使用统一重建脚本。
- 不建议直接使用裸的 `docker compose up -d` 来判断代码是否已生效。
- 判断部署是否成功，以 `/health` 返回的 `git_sha` 为准。

## 非目标

- 不解决 Docker Hub 网络可用性本身。
- 不在这一轮引入私有镜像仓库或本地镜像代理。
- 不改动业务功能逻辑。

## 验证

至少需要验证：

- 服务测试更新后，`/health` 返回新增字段。
- 脚本在构建失败时退出非零状态。
- 脚本在服务版本不匹配时退出非零状态。
- 脚本在服务全部匹配时返回成功。
