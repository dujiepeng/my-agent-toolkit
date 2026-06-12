# 项目 Agent 指南

本仓库维护个人使用的 Agent 技能。

## 当前技能

```text
.agents/skills/wecom-cli-bot
```

企业微信 CLI 机器人框架技能。生成的项目将企业微信智能机器人长连接消息桥接到本地 AI CLI 工具（Codex CLI、Claude Code、Kimi Code、Kiro CLI 或自定义 CLI）。

## 维护规则

- 技能修改仅在 `.agents/skills/wecom-cli-bot` 下进行。
- 不要在仓库根目录创建重复副本。
- 不要在仓库中存储真实的 WeCom Bot ID、Secret、API Key 或用户凭证。
- `.env.example` 文件仅保留占位符。
- 优先使用 Docker 模式验证模板。
- 除非明确要求，否则不要在宿主机全局安装 CLI 工具。

## 验证

修改技能后执行：

```bash
python3 /Users/dujiepeng/.codex/skills/.system/skill-creator/scripts/quick_validate.py /Users/dujiepeng/Project/AI/my-agent-toolkit/.agents/skills/wecom-cli-bot
```

模板验证：将 `assets/wecom-cli-bots-template/` 复制到临时目录，通过 Docker 构建验证。测试脚手架时清空 Provider CLI 安装参数。
