# 更新日志

本文件记录 NetSuite MCP Tools 扩展的版本变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.1] - 2026-07-29

### 变更

- **端口占用自动恢复**：当 `environment.json` 中持久化的 `listener.port` 被其他进程占用时，扩展不再要求用户手动释放端口，而是自动分配一个新的高位端口并更新 `environment.json`。由于 NetSuite 遵循 RFC 8252 对 loopback Redirect URI 不校验端口，OAuth 授权不受影响，无需在 Integration 中更新 Redirect URI。
- **MCP 配置自动刷新**：端口变更后，扩展自动调用 `refreshExisting` 同步更新已生成的 MCP 配置（`.vscode/mcp.json`、`.mcp.json`、`~/.codex/config.toml`）中的 URL，确保 Agent 连接地址与当前监听端口一致。刷新失败不影响代理启动，用户仍可通过"生成 Agent 配置"手动更新。
- **代理启动竞态重试**：`ensureProxyStarted` 在 `proxy.start` 遇到 `EADDRINUSE` 竞态时自动重试（最多 3 次），每次重试会通过 `getOrAllocate` 检测到旧端口被占用并分配新端口，而非直接报错。
- **UI 提示更新**：状态栏"需要修复"状态、`oauth-callback-unavailable` 错误及故障处理表中涉及"请释放端口"的文案已更新为"请重试"，反映端口冲突现在被自动处理。

## [0.3.0] - 2026-07-29

### 新增

- **断开连接**：已连接状态下可从下拉框选择"断开连接"，清除当前工作区的内存 token、停止本机代理服务器，并将 profile 状态回退为 `registered`。已生成的 MCP 配置不会被自动清理，方便后续重新启动连接。
- **Agent 多选**：生成 Agent 配置和清理 MCP 配置时，弹出多选下拉框选择目标 Agent（VS Code Copilot、Claude Code、Codex CLI），允许多选，空选静默返回。
- **Codex 陈旧条目检测**：生成 Codex 配置时，扫描已有的 `netsuite-mcp-*` 条目，检查其 URL 中的端口是否仍在当前机器的 `allocatedPorts` 列表中。不在列表中的条目被视为陈旧残留，提示用户清理。
- **重新授权保留旧 token**：点击"重新授权"时不再提前清除当前 token。旧 token 在新授权完成前继续有效，避免授权中途或失败导致连接意外中断。
- **Schema v3 迁移**：`environment.json` 从 v2 自动迁移到 v3，将 read/write 两个 profile 合并为一个（优先保留已验证的，其次保留有 clientId 的），移除 `access` 字段。

### 变更

- **移除 read/write 区分**：每个工作区只有一个 profile 和一个 MCP 连接。实际读写权限完全由 NetSuite Role 控制，本地不再做 read/write 区分。移除了 `AccessMode` 类型、`enableWrite`/`disableWrite` 命令、`writeEnabled` 状态栏状态、`ensureWriteProfilesForReadEnvironments` 等全部 write 相关逻辑。
- **MCP 命名改为 workspaceId**：JSON 和 Codex 配置统一使用 `netsuite-mcp-<workspaceId>` 命名，不再区分 read/write，不再包含 accountId。
- **"测试连接"改名为"启动连接"**：未连接状态下的操作菜单中，"测试连接"改名为"启动连接"；已连接状态下保留"重新授权"。
- **状态栏文案更新**："未配置"改为"未连接"，"只读已连接"改为"已连接"，tooltip 根据 clientId 是否已填写区分"点击启动连接"和"点击配置连接"。
- **代理路由判断**：`resolveProxyRoute` 的启用条件改为 `profile.status === "verified" && hasActiveSession`，移除了 `ProxyRoute.enabled` 字段。
- **`beginAuthorization` 清理旧 pending**：开始新的授权流程时，自动清理同一 profileId 的旧 pending authorization，避免连续点击产生竞态。

### 移除

- **移除 `enableWrite` / `disableWrite` 命令**：不再提供"启用写入连接"和"关闭写入连接"操作。
- **移除 `getCodexConflictUrl`**：新命名以 workspaceId 保证唯一性，不再需要冲突检测。
- **移除 `codexServerName` 函数**：统一使用 `managedServerName(workspaceId)`。
- **移除 `ProfileStatus` 中的 `"active"`**：当前代码未使用此值。

## [0.2.0] - 2026-07-29

### 新增

- **状态栏路由命令**：点击状态栏按钮的行为现在根据当前连接状态自动切换，无需通过 Ctrl+Shift+P 搜索命令。
  - **未配置**：无有效配置时同时打开 `environment.json` 和操作下拉框；有有效配置时仅弹出下拉框。
  - **只读已连接 / 写入已启用**：点击弹出操作下拉框，展示当前状态下所有可用操作。
  - **需要修复**：点击弹出端口占用错误提示。
- **Token 丢失检测**：状态栏现在区分"磁盘上 verified"与"运行时持有内存 token"。VS Code 重启后若 OAuth 会话丢失，状态栏会回退显示"未配置"而非误报"已连接"。
- **启用写入连接按需创建**：选择"启用写入连接"时，自动为缺少 write profile 的 environment 创建 draft 模板；若 clientId 为空则弹输入框引导填写。
- **清理 MCP 配置操作**：新增轻量操作，扫描 `.vscode/mcp.json`、`.mcp.json` 和 `~/.codex/config.toml`，按 `netsuite-mcp-*` 名称模式删除所有由本扩展托管的条目，保留无关配置。
- **Codex CLI 支持**：生成 Agent 配置时同时写入 `~/.codex/config.toml` 的 `[mcp_servers.netsuite-mcp-<access>]` TOML 表（简化名称，不带 accountId，全局唯一 read/write 各一个）。切换工作区重新生成时若检测到已有条目指向不同 URL，弹窗确认是否覆盖。
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
