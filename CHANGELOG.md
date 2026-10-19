# Changelog

## 0.20.0

面向上架 VSCode 扩展商店的发布版。

- README 重写为商店风格（Features / Quick Start / Usage / Commands / Settings / Privacy）
- 新增 CHANGELOG 与 DEVELOPMENT 文档；打包清单瘦身（`.gitignore`、`package-lock.json` 等不再进包）
- 完善商店元数据（categories / keywords）
- 明确数据边界：插件不内置任何付费/企业题单内容，账号题单由用户自己的 Cookie 实时拉取、仅存本机

## 0.19.0

- AI 归因提示词可自定义：新设置 `lmt.aiPrompt`（留空用内置默认），侧边栏「设置 → AI 提示词」支持编辑 / 复制默认全文 / 恢复默认
- 内置默认提示词升级：五类错误按序判定、WA 错误用例代入法、对照 AC 代码 diff 归因、boundary/logic 与 syntax/logic 判别线、更严格的 JSON 输出约束

## 0.18.0

- 导出目标从 Obsidian vault 改为**普通错题 md 目录**：去掉 vault 自动发现，未配置时弹「选择文件夹」并记住
- 新设置 `lmt.notesDirPath`；旧 `obsidianVaultPath`（+子目录）自动沿用，无需迁移
- 命令更名：`lmt.exportNotes`（导出错题 markdown）/ `lmt.configNotesDir`（配置错题 md 目录）
- 导出成功通知新增「预览」（VSCode 内置 markdown 预览）与「打开目录」；单题自动整理通知改为「预览笔记」

## 0.17.0

- 「我的题单」自动同步 LeetCode 账号收藏夹 / VIP 自建题单，「收藏的题单」同步收藏的他人/官方题单（需 Cookie，网页端改动跟随）
- 仪表盘支持按题单切换统计口径（全部 / 热题 100 / 我的题单 / 收藏的题单 / 导入题单）
- 全量题库缓存拉取（4000+ 题离线搜索）；新命令「刷新 LeetCode 题单」

## 0.16.0

- 题单树最终形态：「我的题单」（LeetCode 侧自动同步）与「导入题单」（本地导入，独立层级）分列，热题 100 / 难度 / 全部题目保留

## 0.15.9

- 题单导入两步引导（剪贴板识别预览 / 文件）
- 报错三段式引导与一键补救
- ↩️ 重置代码区：恢复初始模板，题干与用例不动，Cmd+Z 可撤销

## 0.15.6

- 题单读剪贴板导入（题号、题名、slug、URL、markdown 表格、JSON 混贴识别）
- 失败判定详情：WA 出错用例三件套 / RE 完整栈，供 AI 归因与复盘
- 概览视图：错题率、Cookie 登录态剩余天数、最近错题

## 0.15.0 – 0.15.5

- 提交判定、题单视图、笔记导出等持续迭代

## 0.14.2

- 一站式基线：打开题目（含会员题）、编辑器内提交、断点调试、执行回放、错题自动记录、AI 归因、笔记导出、题单管理；与 labuladong 插件完全独立、文件格式互认
