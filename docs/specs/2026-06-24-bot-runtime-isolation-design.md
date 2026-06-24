# Bot Runtime Isolation Design

## 目标

本次只解决一个问题：`kiro-cli` 运行时不再读取宿主机的公共 skill / 配置上下文。

完成后，每个 bot 在运行 `kiro-cli` 时：

- 看不到宿主机 `HOME` 下的技能与配置
- 看不到宿主机 `.codex/skills`、`.agents/skills` 等公共上下文
- 继续支持 bot 私有环境变量注入
- 暂不要求 bot 私有 skill 已能被 runtime 真加载执行

这是一次“隔离止血”改动，不是完整的 bot 私有 skill runtime 集成。

## 非目标

本次不做：

- 从 GitHub 真正 clone 并安装 skill 的完整执行器
- 让 bot 私有 skill 自动被 `kiro-cli` 加载和执行
- 容器级一 bot 一沙箱
- 公共 skill 与私有 skill 的混合继承策略

本次策略是严格隔离：bot 完全看不到宿主机公共 skill。

## 当前问题

当前 `llm-runner` 通过 `spawn(config.command, args, { env: { ...process.env, ...config.env } })` 直接启动 `kiro-cli`。

当前缺陷：

- 未设置 bot 私有 `cwd`
- 未设置 bot 私有 `HOME`
- 未设置 bot 私有 `CODEX_HOME` / `KIRO_HOME`
- 默认继承宿主机用户态配置

结果：

- bot 在自然语言问答中会暴露宿主机 skill 认知
- runtime 实际能力边界与 bot 私有能力模型不一致
- 即使 WebUI 已登记 bot 私有 skill，runtime 仍优先落在宿主机上下文中

## 方案

采用“运行时进程隔离”方案。

### 目录模型

每个 bot 使用独立 runtime home：

```text
runtime/bots/<bot_id>/
  env/
  skills/
  mcp/
  cache/
  logs/
  tmp/
  home/
  runtime/
```

其中：

- `home/`：给 CLI 使用的私有 home
- `runtime/`：给 CLI 作为当前工作目录使用
- 其他目录沿用现有 bot 私有能力布局

### 启动模型

`llm-runner` 启动 `kiro-cli` 时，必须显式设置：

- `cwd = runtime/bots/<bot_id>/runtime`
- `HOME = runtime/bots/<bot_id>/home`
- `CODEX_HOME = runtime/bots/<bot_id>/home/.codex`
- `KIRO_HOME = runtime/bots/<bot_id>/home/.kiro`（如果 runtime 识别）

同时继续注入：

- bot 私有环境变量

但不再允许默认落回宿主机用户目录。

### 继承策略

这次采用“完全不继承宿主机 skill”的严格策略：

- 不复制宿主机 `.codex/skills`
- 不复制宿主机 `.agents/skills`
- 不挂宿主机公共 skill 路径
- 不给 runtime 访问宿主机默认 home

这样会导致一个短期结果：

- 如果 bot 私有 skill 还未真正接入 runtime，加完隔离后，runtime 侧可能看不到任何 skill

这是允许且正确的结果。本次目标是隔离，而不是保留宿主机能力。

## 服务边界

### capability-runner

继续负责：

- bot 私有 workspace 创建
- bot 私有 skill/mcp 目录维护

本次需要补：

- 确保 `home/` 与 `runtime/` 目录存在

### llm-runner

本次是主要改动点：

- 在调用 CLI runtime 前，根据 `bot_id` 解析 bot 私有 runtime 路径
- 把私有 `cwd/home` 注入到 `spawn`
- 保持现有 bot 私有 env 注入逻辑

### bot-host

不承担隔离逻辑，但要保留：

- `/skill` 走 bot 私有 skill 列表
- 自然语言“我有哪些 skill”应优先走 bot 私有 skill 摘要，而不是交给 LLM 自由发挥

## 数据流

1. `bot-host` 收到用户消息
2. 需要调用 `kiro` runtime 时，请求 `llm-runner`
3. `llm-runner` 解析 `bot_id`
4. 获取：
   - bot 私有 env
   - bot 私有 runtime home/cwd
5. 用 bot 私有上下文启动 `kiro-cli`
6. CLI 输出返回给 `bot-host`

重点是第 4 步之后，runtime 不能再落回宿主机默认上下文。

## 错误处理

如果 bot 私有 runtime 目录不存在：

- `llm-runner` 负责自动创建最小目录结构
- 不把“目录不存在”暴露给用户作为失败原因

如果 bot 私有 home 初始化失败：

- 返回 runtime error
- 不回退到宿主机 `HOME`

禁止回退是硬规则。否则隔离会失效。

## 测试

### 单元测试

为 `llm-runner` 增加：

- 启动 CLI 时会带 bot 私有 `cwd`
- 启动 CLI 时会带 bot 私有 `HOME`
- 启动 CLI 时会带 bot 私有 `CODEX_HOME` / `KIRO_HOME`
- bot env 仍能继续注入
- 不再直接把宿主机 `HOME` 透传给 CLI

### 集成验证

至少验证：

1. 真实 bot 询问“我有哪些 skill”
   - 不再返回宿主机那套 skill 列表
2. `/skill` 仍返回 bot 私有 skill 登记结果
3. bot 私有 env 注入不回归

## 验收标准

满足以下条件即可视为本轮完成：

- `kiro-cli` 运行时不再读取宿主机公共 skill 上下文
- bot 自然语言问答中不再暴露宿主机 skill 列表
- `/skill` 仍按 bot 私有 skill 数据返回
- bot 私有 env 注入不受影响
- 不引入宿主机 fallback

## 后续阶段

本轮完成后，下一阶段再做：

- bot 私有 skill 真正接入 runtime 加载路径
- 私有 skill 的真实 clone / 安装 / 依赖管理
- 私有 mcp 的 runtime 使用接入
