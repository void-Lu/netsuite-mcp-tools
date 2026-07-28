# NetSuite MCP Tools

用于 Windows 本机 VS Code 的内部扩展：它通过 NetSuite OAuth 2.0 **Authorization Code + PKCE** 在系统浏览器中授权，在本机提供 Streamable HTTP MCP 代理，并为 VS Code Copilot 与 Claude Code 生成无凭据的本地 MCP 配置。

> 这不是 M2M 或 mTLS 客户端证书代理。扩展使用 NetSuite Public Client Integration，授权码、PKCE verifier、state、access token 与 refresh token 只在当前 VS Code Extension Host 内存中存在。

## 支持范围

- Windows Desktop 上的本地单文件夹工作区
- 当前稳定版 VS Code Copilot 与 Claude Code CLI
- 官方 NetSuite AI Connector SuiteApp：`com.netsuite.mcpstandardtools`
- read/write 分离的 NetSuite Public Client Integration 与非 Administrator Role

不支持 WSL、Remote SSH、Dev Container、Codespaces、macOS、Linux、局域网访问、任意 MCP URL、私钥迁移或其他 MCP 客户端。

## 安全模型

- 只监听 `127.0.0.1`；不监听局域网或 IPv6 地址。
- 每个工作区保存 `/.netsuite-mcp/environment.json`。其中只含可共享的非机密连接元数据、固定端口和端口排除清单；仅 `/.netsuite-mcp/logs/` 及两份 MCP 配置自动加入 `.gitignore`。
- `environment.json` 只保存非机密 profile 元数据、Public Client `clientId` 和受控的 loopback Redirect URI。
- 不生成或保存证书、私钥、Client Secret、授权码、PKCE verifier、state、access token 或 refresh token。
- 授权材料、认证头和 HTTP 正文不落盘、不写日志。
- 本期没有额外本地 HTTP 密钥。同一 Windows 用户下的恶意进程理论上可发现 loopback 端口，因此必须使用 NetSuite 最小权限 Role，且不要在不可信共享帐户上启用。

## 安装 VSIX

1. 从发布物取得 `netsuite-mcp-tools-<version>.vsix`。
2. 在 VS Code 执行 **Extensions: Install from VSIX…**，选择该文件。
3. 重新打开一个 Windows 本地文件夹工作区。
4. 从命令面板运行 **NetSuite MCP：打开连接配置**。

## 首次配置

1. 运行 **NetSuite MCP：打开连接配置**。扩展会创建并打开 `/.netsuite-mcp/environment.json`；之后所有人工配置都在这个文件完成，不会逐字段弹窗询问。
2. 在模板中编辑以下人工配置：
   - 将 `YOUR_NETSUITE_ACCOUNT_ID` 同时替换为 `environments` 的键和其中的 `accountId` 值；两处必须完全一致。
   - 将 `environmentType` 设为 `sandbox` 或 `production`，将 `access` 设为 `read`（推荐）或 `write`。模板预置一个 read 和一个 write 草稿，未使用的 write 草稿可保留；它不会写入 Agent 配置或启用端点。write profile 需要独立的 NetSuite Role。
   - 填写 Public Client Integration 的 `clientId`。不要手工编辑 `id`、`status`、端口、`allocatedPorts` 或 `workspaceId`；这些是扩展维护的派生状态。打开配置命令会显示由该工作区持久化端口派生的 Redirect URI。
3. 在 NetSuite 创建专用 Integration，并配置：
   - 勾选 **Public Client** 与 **Authorization Code Grant**；
   - 将“打开连接配置”命令显示的 Redirect URI 原样填入 Redirect URI；
   - 启用 **NetSuite AI Connector Service** scope；
   - 使用非 Administrator 的最小权限 Role。该 Role 必须有 **MCP Server Connection**、**OAuth 2.0 Access Tokens**，并在使用 MCP Standard Tools SuiteApp 时具有 **REST Web Services** 权限。
4. 回到 `environment.json` 填写 `clientId` 并保存，然后运行 **NetSuite MCP：测试连接**。扩展会启动仅限 `127.0.0.1` 的临时回调、打开系统浏览器完成 NetSuite 登录/同意，再执行 MCP `initialize` 与 `tools/list` 健康检查，不读取业务数据；健康检查成功后会把档案标记为已验证，并将该工作区固定端口加入共享的 `allocatedPorts` 和当前主机的插件用户级排除清单。
5. 验证后，选择 **NetSuite MCP：生成 Agent 配置**。它会在用户确认后写入：
   - `.vscode/mcp.json`：VS Code Copilot；
   - `.mcp.json`：Claude Code。

生成的配置仅包含 `http://127.0.0.1:<port>/<profile-id>/mcp`，没有 Client ID、Client Secret、授权码、PKCE verifier、JWT 或 access token。

`environment.json` 只能保存非机密配置和扩展派生的文件元数据，可由管理员随项目共享给其他用户。`allocatedPorts` 会传递已验证工作区使用过的端口，帮助其他用户初始化新工作区时避让。若文件包含 private key、Client Secret、Certificate ID、JWT、token、认证头或其他未知字段，扩展会拒绝加载它。

若该文件不存在、为空或仅包含空白字符，打开命令会重新初始化完整的 read/write 草稿模板。对于只缺少扩展维护字段的合法 JSON，扩展会安全补全并提示“已补全”，同时保留已有 accountId、环境、access 和 Client ID。JSON 损坏、字段类型错误或包含未知字段时不会覆盖文件，需先手动修复。

## 写入操作

- write profile 不会自动创建，也不会自动启用。
- 首先为它显式生成 Agent 配置，然后在每个 VS Code 会话中运行 **NetSuite MCP：启用写入连接**。
- 写入端点在 VS Code 重启/关闭时自动关闭；NetSuite Role 才是最终权限边界。
- 代理不会通过工具名称猜测读写权限，也不会重放网络超时、5xx 或工具业务错误。

## 重新授权与移除

- 授权态只在当前 VS Code 会话保留；重启、停用扩展或显式移除 profile 后，运行 **NetSuite MCP：测试连接** 重新在浏览器中授权。
- 扩展不会自动撤销 NetSuite 远端 Integration 或其已授予的访问权限。移除本机 profile 后，请由管理员按需要在 NetSuite 管理 Integration 与授权。
- 若复制项目到另一个 Windows 用户/设备，必须使用该设备的浏览器重新授权。

## 故障处理

| 症状 | 处理方式 |
| --- | --- |
| 浏览器授权失败或回调超时 | 核对 Public Client、Redirect URI（必须与模板完全一致）、Authorization Code Grant、AI Connector Service scope 与 OAuth 2.0 feature。 |
| MCP 初始化失败 | 确认 SuiteApp 已安装、使用 MCP `2025-06-18`、Role 为非 Administrator 且具有 MCP Server Connection / OAuth 2.0 Access Tokens / REST Web Services 所需权限，并仅在 sandbox 运行 Phase 0。 |
| 本地端口冲突 | 该工作区的 Redirect URI 已固定。关闭占用该端口的程序后重试；扩展不会自动或手动改换端口。 |
| 本机代理提示需要授权 | 运行 **NetSuite MCP：测试连接**，在系统浏览器中完成当前会话的授权。 |
| Agent 未连接 | 检查 VS Code 是否打开该工作区、read profile 是否已验证，以及 `.vscode/mcp.json` / `.mcp.json` 是否被 Git 跟踪或损坏。 |

日志位于 `/.netsuite-mcp/logs/`，仅保存脱敏事件、状态码和 MCP 方法名，最多保留 7 天或 10 MB。

## 本地开发与打包

```powershell
npm install
npm run typecheck
npm run lint
npm test
npm run package
```

最后一条命令会生成可通过 VS Code 安装的 `.vsix` 文件。真实 NetSuite 验证只允许最小权限 sandbox，且只执行浏览器授权、`initialize` 和 `tools/list`；不要把 production 当作测试环境。
