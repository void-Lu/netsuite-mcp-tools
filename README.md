# NetSuite MCP Tools

用于 Windows 本机 VS Code 的内部扩展：它通过 NetSuite OAuth 2.0 **Authorization Code + PKCE** 在系统浏览器中授权，在本机提供 Streamable HTTP MCP 代理，并为 VS Code Copilot、Claude Code 与 Codex CLI 生成无凭据的本地 MCP 配置。

> 这不是 M2M 或 mTLS 客户端证书代理。扩展使用 NetSuite Public Client Integration，授权码、PKCE verifier、state、access token 与 refresh token 只在当前 VS Code Extension Host 内存中存在。

## 支持范围

- Windows Desktop 上的本地单文件夹工作区
- 当前稳定版 VS Code Copilot、Claude Code CLI 与 Codex CLI
- 官方 NetSuite AI Connector SuiteApp：`com.netsuite.mcpstandardtools`
- NetSuite Public Client Integration 与非 Administrator Role

不支持 WSL、Remote SSH、Dev Container、Codespaces、macOS、Linux、局域网访问、任意 MCP URL、私钥迁移或其他 MCP 客户端。

## 安全模型

- 只监听 `127.0.0.1`；不监听局域网或 IPv6 地址。
- 每个工作区保存 `/.netsuite-mcp/environment.json`。其中只含可共享的非机密连接元数据、固定端口和端口排除清单；仅 `/.netsuite-mcp/logs/` 及两份 MCP 配置自动加入 `.gitignore`。
- `environment.json` 只保存非机密 profile 元数据、Public Client `clientId` 和受控的 loopback Redirect URI。
- 不生成或保存证书、私钥、Client Secret、授权码、PKCE verifier、state、access token 或 refresh token。
- 授权材料、认证头和 HTTP 正文不落盘、不写日志。
- 同一 Windows 用户下的恶意进程理论上可发现 loopback 端口，因此必须使用 NetSuite 最小权限 Role，且不要在不可信共享帐户上运行。

## 状态栏交互

扩展在状态栏左侧显示连接状态。**点击状态栏按钮**是所有操作的主入口，无需通过 Ctrl+Shift+P 搜索命令。

| 状态 | 文案 | 点击行为 |
| --- | --- | --- |
| 未连接（无有效 clientId） | `NetSuite MCP：未连接` | 打开 `environment.json` + 弹出操作下拉框 |
| 未连接（有有效 clientId） | `NetSuite MCP：未连接` | 弹出操作下拉框 |
| 已连接 | `NetSuite MCP：已连接` | 弹出操作下拉框 |
| 需要修复 | `NetSuite MCP：需要修复` | 弹出代理启动失败提示 |

VS Code 重启后，即使 `environment.json` 中 profile 标记为 `verified`，若内存中无 OAuth token，状态栏仍显示"未连接"而非误报"已连接"。

## 安装 VSIX

1. 从发布物取得 `netsuite-mcp-tools-<version>.vsix`。
2. 在 VS Code 执行 **Extensions: Install from VSIX…**，选择该文件。
3. 重新打开一个 Windows 本地文件夹工作区。
4. 点击状态栏的 `NetSuite MCP：未连接` 按钮。

## 首次配置

1. 点击状态栏的 `NetSuite MCP：未连接` 按钮。扩展会创建并打开 `/.netsuite-mcp/environment.json`，同时弹出操作下拉框；之后所有人工配置都在这个文件完成，不会逐字段弹窗询问。
2. 在模板中编辑以下人工配置：
   - 将 `YOUR_NETSUITE_ACCOUNT_ID` 同时替换为 `environments` 的键和其中的 `accountId` 值；两处必须完全一致。
   - 将 `environmentType` 设为 `sandbox` 或 `production`。
   - 填写 Public Client Integration 的 `clientId`。不要手工编辑 `id`、`status`、端口、`allocatedPorts` 或 `workspaceId`；这些是扩展维护的派生状态。打开配置命令会显示由该工作区持久化端口派生的 Redirect URI。
3. 在 NetSuite 创建专用 Integration，并配置：
   - 勾选 **Public Client** 与 **Authorization Code Grant**；
   - 将"打开连接配置"操作显示的 Redirect URI 原样填入 Redirect URI；
   - 启用 **NetSuite AI Connector Service** scope；
   - 使用非 Administrator 的最小权限 Role。该 Role 必须有 **MCP Server Connection**、**OAuth 2.0 Access Tokens**，并在使用 MCP Standard Tools SuiteApp 时具有 **REST Web Services** 权限。
4. 回到 `environment.json` 填写 `clientId` 并保存，然后点击状态栏按钮，从下拉框选择 **启动连接**。扩展会启动仅限 `127.0.0.1` 的临时回调、打开系统浏览器完成 NetSuite 登录/同意，再执行 MCP `initialize` 与 `tools/list` 健康检查，不读取业务数据；健康检查成功后会把档案标记为已验证，并将该工作区固定端口加入共享的 `allocatedPorts` 和当前主机的插件用户级排除清单。
5. 验证后，点击状态栏按钮，从下拉框选择 **生成 Agent 配置**。弹出多选下拉框，选择需要配置的 Agent（VS Code Copilot、Claude Code、Codex CLI，允许多选），确认后写入对应的配置文件。

## 权限模型

每个工作区只有一个 MCP 连接和一份 profile。实际的读写权限完全由 NetSuite Role 控制，本地不再区分 read/write profile。只要 Role 具有相应权限，同一 MCP 连接既可读取也可写入。这简化了配置流程，同时将权限边界保持在 NetSuite 服务端。

## 生成的 MCP 配置

生成的配置仅包含 `http://127.0.0.1:<port>/<profile-id>/mcp`，没有 Client ID、Client Secret、授权码、PKCE verifier、JWT 或 access token。

**VS Code Copilot**（工作区级）：配置写入 `.vscode/mcp.json`，server 名称为 `netsuite-mcp-<workspaceId>`。

**Claude Code**（工作区级）：配置写入 `.mcp.json`，server 名称为 `netsuite-mcp-<workspaceId>`。

**Codex CLI**（用户级）：配置写入 `~/.codex/config.toml` 的 `[mcp_servers.netsuite-mcp-<workspaceId>]` 表，仅包含 `url` 字段。由于 Codex 不支持工作区级 MCP 配置，每个工作区会在用户级配置中生成一个独立条目。生成 Codex 配置时，扩展会扫描已有的 `netsuite-mcp-*` 条目，检测其 URL 中的端口是否仍在当前机器的 `allocatedPorts` 列表中；不在列表中的条目被视为陈旧残留，会提示用户清理。

`environment.json` 只能保存非机密配置和扩展派生的文件元数据，可由管理员随项目共享给其他用户。`allocatedPorts` 会传递已验证工作区使用过的端口，帮助其他用户初始化新工作区时避让。若文件包含 private key、Client Secret、Certificate ID、JWT、token、认证头或其他未知字段，扩展会拒绝加载它。

若该文件不存在、为空或仅包含空白字符，打开命令会重新初始化完整的草稿模板。对于只缺少扩展维护字段的合法 JSON，扩展会安全补全并提示"已补全"，同时保留已有 accountId、环境和 Client ID。JSON 损坏、字段类型错误或包含未知字段时不会覆盖文件，需先手动修复。

## 断开连接与重新授权

- **断开连接**：在已连接状态下，从下拉框选择 **断开连接**。扩展会清除当前工作区的内存 token、停止本机代理服务器，并将 profile 状态回退为 `registered`。已生成的 MCP 配置不会被自动清理，用户可在后续重新启动连接。
- **重新授权**：在已连接状态下，从下拉框选择 **重新授权**。扩展会打开浏览器完成新一轮 OAuth 授权；在新的授权完成之前，旧的 token 仍然有效，不会提前清除。
- 扩展不会自动撤销 NetSuite 远端 Integration 或其已授予的访问权限。
- **清理 MCP 配置**操作会弹出多选下拉框，选择需要清理的 Agent 后，扫描对应配置文件，删除所有由本扩展托管（名称以 `netsuite-mcp-` 开头）的 server 条目，保留无关配置。
- 若复制项目到另一个 Windows 用户/设备，必须使用该设备的浏览器重新授权。

## 故障处理

| 症状 | 处理方式 |
| --- | --- |
| 浏览器授权失败或回调超时 | 核对 Public Client、Redirect URI（必须与模板完全一致）、Authorization Code Grant、AI Connector Service scope 与 OAuth 2.0 feature。 |
| MCP 初始化失败 | 确认 SuiteApp 已安装、使用 MCP `2025-06-18`、Role 为非 Administrator 且具有 MCP Server Connection / OAuth 2.0 Access Tokens / REST Web Services 所需权限，并仅在 sandbox 运行 Phase 0。 |
| 本地端口冲突 | 扩展会自动分配新的回调端口并更新 `environment.json`。由于 NetSuite 对 loopback Redirect URI 不校验端口（RFC 8252），无需在 Integration 中更新 Redirect URI。仅在多次自动分配均失败时，需关闭占用高位端口的程序后重试。 |
| 本机代理提示需要授权 | 点击状态栏，从下拉框选择 **启动连接** 或 **重新授权**，在系统浏览器中完成当前会话的授权。 |
| Agent 未连接 | 检查 VS Code 是否打开该工作区、profile 是否已验证，以及 `.vscode/mcp.json` / `.mcp.json` 是否被 Git 跟踪或损坏。 |

日志位于 `/.netsuite-mcp/logs/`，仅保存脱敏事件、状态码和 MCP 方法名，最多保留 7 天或 10 MB。

## 从 v0.2.x 升级

v0.3.0 移除了 read/write profile 区分。升级后，已有的 `environment.json`（schema v2）会自动迁移到 v3：

- 每个 environment 的 read 和 write profile 合并为一个（优先保留已验证的，其次保留有 clientId 的）。
- `access` 字段被移除。
- MCP 配置中的旧命名 `netsuite-mcp-<accountId>-<access>` 不再被自动清理，请手动执行 **清理 MCP 配置** 后重新生成。

## 本地开发与打包

```powershell
npm install
npm run typecheck
npm run lint
npm test
npm run package
```

最后一条命令会生成可通过 VS Code 安装的 `.vsix` 文件。真实 NetSuite 验证只允许最小权限 sandbox，且只执行浏览器授权、`initialize` 和 `tools/list`；不要把 production 当作测试环境。
