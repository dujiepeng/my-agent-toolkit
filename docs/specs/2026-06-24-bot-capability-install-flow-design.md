# Bot Capability Install Flow Design

## 目标

本次重新收敛 bot 私有 capability 设计，目标只有三件事：

1. 不影响宿主机 `kiro-cli` 登录态
2. 把 skill / mcp 安装流程做成可信的安装状态流
3. 把 skill 查询结果严格收口到 bot 私有登记结果

本次不做 runtime 隔离，不改宿主机 `HOME` / 登录态继承方式。

## 设计前提

新的优先级为：

1. 宿主机 `kiro-cli` 登录态最高优先级，不能受影响
2. 宿主机不额外安装 skill
3. bot 私有 skill/mcp 继续由平台登记和管理
4. bot 对“我有哪些 skill”的回答必须只基于 bot 私有登记结果

这意味着本次不推进 runtime 隔离方案。

## 非目标

本次不做：

- `llm-runner` 的 `HOME` / `CODEX_HOME` / `KIRO_HOME` 隔离
- 完整外部 skill 仓库 clone / 依赖安装 / runtime 加载
- 独立任务中心页面
- 安装日志流式查看

## 当前问题

### 1. 安装表单体验不可信

当前问题：

- 空表单也能点提交
- 用户提交后立即跳转，像是“已经成功”
- 没有 `installing` 状态
- 没有安装失败的明确反馈

### 2. 安装状态模型缺失

当前虽然页面可以触发安装，但缺少完整状态流。用户无法区分：

- 已受理
- 安装中
- 安装成功
- 安装失败

### 3. 自然语言 skill 查询会串到宿主机认知

即使 `/skill` 已经能走 bot 私有数据，普通自然语言提问：

- 我掌握了哪些 skill
- 有哪些技能

仍可能落到 LLM 自由回答，进而暴露宿主机 skill 认知。

## 方案

采用“最小可信安装闭环”方案。

### A. 表单校验

WebUI 在 `Bot 能力管理` 页中：

#### Skill 安装

必须校验：

- `name` 必填
- `source_ref` 必填

#### MCP 安装

必须校验：

- `name` 必填
- `source_ref` 必填

校验失败时：

- 不发请求
- 直接在页面提示用户补齐字段

### B. 安装状态流

skill / mcp 安装统一采用三态：

- `installing`
- `installed`
- `failed`

#### 提交流程

1. 用户在 WebUI 提交安装表单
2. `control-api` 调用 `capability-runner`
3. `capability-runner` 先把记录写成 `installing`
4. 执行最小安装动作
5. 成功则更新为 `installed`
6. 失败则更新为 `failed`，并记录错误摘要

### C. 页面反馈

能力页需要增加：

- 安装中提示
- 成功提示
- 失败提示

并且页面刷新或轮询后，用户仍能看到真实状态，而不是只看到一次 toast。

#### 页面行为

- 提交后立即禁用提交按钮，避免重复提交
- 列表中立刻出现 `installing`
- 安装完成后自动刷新为 `installed` 或 `failed`
- 如果失败，列表里保留失败项和错误摘要

### D. 查询收口

skill 查询必须优先走 bot 私有登记结果。

#### 命令式查询

- `/skill`
- `/mcp`
- `/capability`

继续走结构化 bot 私有数据。

#### 自然语言查询

对以下表达增加前置识别：

- 我掌握了哪些 skill
- 有哪些 skill
- 有哪些技能
- 我有哪些 mcp

这些问法不能再交给 LLM 自由发挥，而是直接路由到：

- `skills_summary`
- `mcps_summary`

因此 bot 回复只基于：

- `bot_skills`
- `bot_mcps`

而不是宿主机上下文。

## 服务边界

### control-api

负责：

- WebUI 表单校验
- 提交安装请求
- 展示当前状态
- 成功/失败页面反馈

### capability-runner

负责：

- 把 skill/mcp 安装先写成 `installing`
- 执行最小安装动作
- 结果写回 `installed` 或 `failed`
- 保留失败摘要

### data-service

负责：

- skill/mcp 状态真值存储
- 列表查询
- 删除操作

### bot-host

负责：

- 命令式 capability 查询
- 自然语言 capability 查询前置识别
- 回复 bot 私有 skill/mcp 摘要

### llm-runner

本次不改。

原因：

- 当前优先级下，不能影响宿主机 `kiro-cli` 登录态
- 本次目标是安装流程和查询边界，不是 runtime 隔离

## 最小安装语义

本次安装仍然采用“最小安装”定义：

- 在 bot 私有目录落一个占位元数据文件
- 在 `data-service` 中登记状态

例如 skill：

```text
runtime/bots/<bot_id>/skills/<skill_name>/skill.json
```

例如 mcp：

```text
runtime/bots/<bot_id>/mcp/<mcp_name>/mcp.json
```

这次不要求仓库真正 clone 完毕并可执行。

## 失败处理

如果安装失败：

- 状态更新为 `failed`
- 错误摘要写入 `last_error`
- 页面可见失败状态
- 用户收到明确失败提示
- 不保留误导性的“成功已安装”展示

## 测试

### control-api

增加测试：

- 空表单不应成功提交
- 安装中状态展示
- 失败状态展示

### capability-runner

增加测试：

- 提交后先写 `installing`
- 成功写 `installed`
- 失败写 `failed`

### bot-host

增加测试：

- “我掌握了哪些 skill” -> `skills_summary`
- “有哪些技能” -> `skills_summary`
- “我有哪些 mcp” -> `mcps_summary`

## 验收标准

满足以下条件即可视为完成：

- 空 skill / mcp 表单不能提交
- skill / mcp 有明确的 `installing / installed / failed` 状态
- 页面能看到安装中、成功、失败结果
- skill 自然语言查询只返回 bot 私有登记结果
- 宿主机 `kiro-cli` 登录态不受影响

## 后续阶段

后续如果要继续做更完整能力模型，再进入：

- 外部仓库真实 clone / 安装
- bot 私有 skill runtime 真加载
- runtime 隔离与登录态桥接
