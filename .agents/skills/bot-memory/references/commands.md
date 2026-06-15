# 用户指令说明

## 记忆指令

### /remember <文本>

存入当前 Bot 命名空间的核心记忆。

支持标签：`/remember #PRD #注册 用户注册需要手机验证码`

标签会被提取为独立 tag，剩余文本作为记忆内容。

### /remember --shared <文本>

存入 shared 命名空间，所有 Bot 检索时都能匹配到。

### /fetch <url>

抓取指定 URL 的网页内容，解析正文后存入记忆。

示例：`/fetch https://confluence.example.com/page/12345`

### /scan [目录]

扫描指定目录下的所有支持格式文件（.md .txt .pdf .docx .html），增量索引到记忆中。

- 不指定目录时默认扫描 `workspace/files/`
- 支持格式：Markdown、TXT、PDF、Word、HTML
- 增量模式：已索引的文件不会重复处理

### /memory

显示当前命名空间的记忆统计（总条数、分块数）。

### /forget <关键词>

按关键词匹配 tags 删除记忆。

示例：`/forget 旧版本` — 删除所有带 "旧版本" tag 的记忆。

## 技能指令

### /skill_list

列出 `workspace/files/.agents/skills/` 下所有已安装的技能，显示名称和描述。

### /skill_add <git_url>

从 git 仓库 clone 技能到 skills 目录。如已存在则 git pull 更新。

示例：`/skill_add git@github.com:user/my-skill.git`

### /skill_remove <name>

删除指定技能目录。

示例：`/skill_remove my-skill`

## 会话指令

### /help

显示所有可用指令的完整列表。

### /stop

终止当前正在执行的 AI 任务。

### /new

强制开始新会话（清除当前 session resume 状态）。

### /history

列出历史会话，显示时间、命名、首条消息和消息数。

### /open N

恢复第 N 个历史会话，后续对话将在该会话上下文中继续。

### /name <名称>

给当前会话命名，便于在 /history 中辨识。
