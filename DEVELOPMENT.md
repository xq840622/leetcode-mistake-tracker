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

### 主路线：Open VSX（无需信用卡）

2026 年起官方 Marketplace 的新发布流程要求新建 Azure DevOps 组织必须绑定 Azure 订阅（免费试用也需信用卡验证），暂不可行；Open VSX（Eclipse 基金会，Cursor / VSCodium / Windsurf / Gitpod 等从中拉取扩展）用 GitHub 账号即可发布：

1. 打开 https://open-vsx.org → 登录（GitHub 授权，自动关联 Eclipse Foundation 账号）
2. 若提示 claim namespace，认领 `xq840622`（与 `package.json` 的 `publisher` 一致）
3. 头像 → Settings → Access Tokens → 生成 token
4. 发布：

   ```bash
   npm run compile && npx @vscode/vsce package
   npx ovsx publish leetcode-mistake-tracker-<版本>.vsix -p <token>
   ```

   （token 只出现一次；也可 `npx ovsx login` 存到本机钥匙串后直接 `npx ovsx publish`）

### 补充渠道：GitHub Release 挂 vsix（官方 VSCode 用户手动安装）

`gh auth login` 后：

```bash
gh release create v<版本> leetcode-mistake-tracker-<版本>.vsix --title "v<版本>" --notes "见 CHANGELOG.md"
```

### 官方 Marketplace（等有信用卡后补）

1. https://marketplace.visualstudio.com/manage 用 Microsoft 账号创建 publisher（流程会引导开通 Azure DevOps 组织，需 Azure 免费试用/订阅验证信用卡；上架后永久免费，无持续扣费）
2. Azure DevOps → Personal Access Tokens：Organization 选 "All accessible organizations"，Scopes 勾 `Marketplace → Manage`
3. `npx @vscode/vsce login xq840622`（粘贴 PAT）→ `npx @vscode/vsce publish`
