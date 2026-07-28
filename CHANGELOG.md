# 更新日志

本文件记录 NetSuite MCP Tools 扩展的版本变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-07-29

### 新增

- **状态栏路由命令**：点击状态栏按钮的行为现在根据当前连接状态自动切换，无需通过 Ctrl+Shift+P 搜索命令。
  - **未配置**：无有效配置时同时打开 `environment.json` 和操作下拉框；有有效配置时仅弹出下拉框。
  - **只读已连接 / 写入已启用**：点击弹出操作下拉框，展示当前状态下所有可用操作。
  - **需要修复**：点击弹出端口占用错误提示。
- **Token 丢失检测**：状态栏现在区分"磁盘上 verified"与"运行时持有内存 token"。VS Code 重启后若 OAuth 会话丢失，状态栏会回退显示"未配置"而非误报"已连接"。
- **启用写入连接按需创建**：选择"启用写入连接"时，自动为缺少 write profile 的 environment 创建 draft 模板；若 clientId 为空则弹输入框引导填写。
- **清理 MCP 配置操作**：新增轻量操作，扫描 `.vscode/mcp.json`、`.mcp.json` 和 `~/.codex/config.toml`，按 `netsuite-mcp-*` 名称模式删除所有由本扩展托管的条目，保留无关配置。
- **Codex CLI 支持**：生成 Agent 配置时同时写入 `~/.codex/config.toml` 的 `[mcp_servers.<name>]` TOML 表，仅包含 `url` 字段，不含凭据。
- **单 profile 自动选中**：当操作目标仅有一条符合条件的 profile 时，跳过 QuickPick 选择框直接执行。

### 变更

- `configureProfile` 的 InformationMessage 不再阻塞后续操作，文件打开后下拉框立即弹出。
- `enableWrite` 流程增强：支持 draft write profile 的按需创建、clientId 交互输入、未验证时自动发起 OAuth 授权。
- `pickProfile` 在仅一条结果时自动选中，减少不必要的交互步骤。

### 移除

- **移除 `removeProfile` 命令**：不再从命令面板提供"移除连接"操作。如需清理，请手动编辑 `environment.json` 并使用"清理 MCP 配置"操作移除残留的 MCP server 条目。

## [0.1.0] - 2026-07-28

### 新增

- 通过本机浏览器 OAuth 2.0 Authorization Code + PKCE 代理将 NetSuite AI Connector 安全接入 VS Code MCP 客户端。
- 本机 loopback HTTP 代理：自动获取和刷新 access token，注入 `Authorization: Bearer` 头后转发 MCP 请求到 NetSuite SuiteTalk 端点。
- 零数据健康检查：授权后执行 `initialize` → `notifications/initialized` → `tools/list` 四阶段验证，不产生任何业务数据写入。
- `environment.json` 配置模板：自动初始化、迁移 v1 证书配置、字段级校验和补全。
- 只读 / 写入 profile 分离：写入连接每次 VS Code 会话需显式启用，重启后自动关闭。
- MCP 配置写入：自动生成 `.vscode/mcp.json` 和 `.mcp.json`，支持 JSONC 注释，不覆盖非本扩展管理的条目。
- 端口分配隔离：跨工作区端口冲突检测和共享端口索引。
- 脱敏日志：profile ID、token、client ID 等敏感信息在日志中自动脱敏。
