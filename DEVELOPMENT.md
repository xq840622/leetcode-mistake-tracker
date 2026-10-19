# 开发（Development）

## 构建与自测

```bash
npm install
npm run compile            # tsc 编译到 out/
node scripts/selftest.cjs  # 88 项断言（纯函数/解析/驱动/DAP/提交协议/树结构/仪表盘口径/文件识别/AI 提示词）
```

自测在纯 Node 环境跑（`scripts/vscode-stub.cjs` 提供 VSCode API 桩），不依赖 VSCode 窗口；部分用例检测到有效 Cookie 时会跳过失效路径（避免真实提交）。

## 打包与本地安装

```bash
npx @vscode/vsce package
code --install-extension leetcode-mistake-tracker-<版本>.vsix
```

（`code` 不在 PATH 时，在 VSCode 里 `Cmd+Shift+P → Extensions: Install from VSIX…` 选择生成的 .vsix）

`.vscodeignore` 已排除源码、脚本、本地文档与历史 vsix；安装包内代码仅 `out/` + `media/` + `data/top100.json`（官方热题 100 公开索引）+ README/CHANGELOG。

## 首次发布到商店

1. （一次性）登录 GitHub CLI 并创建公开仓库、推送：

   ```bash
   gh auth login            # 浏览器授权
   gh repo create leetcode-mistake-tracker --public --source=. --push
   ```

   `package.json` 已填好 `repository` / `bugs` / `homepage`（`xq840622/leetcode-mistake-tracker`）。

2. （一次性）注册 publisher 并登录 vsce：

   - 在 https://marketplace.visualstudio.com/manage 用 GitHub 账号登录，创建 publisher（或 `npx @vscode/vsce create-publisher <名字>`）
   - 把 `package.json` 的 `publisher` 从 `liuqiang-local` 改为该 ID
   - `npx @vscode/vsce login <名字>`（粘贴 Personal Access Token，见 https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token）

3. 发布：`npx @vscode/vsce publish`（minor 版本号自动 +1，或手动改 `package.json`）
