# NetSuite MCP Tools

用于 Windows 本机 VS Code 的内部扩展：它通过 NetSuite OAuth 2.0 Client Credentials 的 **JWT client assertion** 获取短期 access token，在本机提供 Streamable HTTP MCP 代理，并为 VS Code Copilot 与 Claude Code 生成无凭据的本地 MCP 配置。

> 这不是 mTLS 客户端证书代理。NetSuite 会保存公钥证书；扩展使用本机私钥签名 JWT assertion，随后将 access token 仅注入到上游 NetSuite 请求。

## 支持范围

- Windows Desktop 上的本地单文件夹工作区
- 当前稳定版 VS Code Copilot 与 Claude Code CLI
- 官方 NetSuite AI Connector SuiteApp：`com.netsuite.mcpstandardtools`
- read/write 分离的 NetSuite Integration、Role 与证书身份

不支持 WSL、Remote SSH、Dev Container、Codespaces、macOS、Linux、局域网访问、任意 MCP URL、私钥迁移或其他 MCP 客户端。

## 安全模型

- 只监听 `127.0.0.1`；不监听局域网或 IPv6 地址。
- 每个工作区保存本机 `/.netsuite-mcp/environment.json`；该目录和两份 MCP 配置均自动加入 `.gitignore`。
- 公钥证书保存在 `/.netsuite-mcp/certificates/*.public.pem`。
- 私钥保存在同目录的 `*.private.dpapi`，使用 Windows DPAPI `CurrentUser` 加密；从不生成持久的明文私钥。
- JWT assertion、access token、认证头和 HTTP 正文不落盘、不写日志。
- 本期没有额外本地 HTTP 密钥。同一 Windows 用户下的恶意进程理论上可发现 loopback 端口，因此必须使用 NetSuite 最小权限 Role，且不要在不可信共享帐户上启用。

## 安装 VSIX

1. 从发布物取得 `netsuite-mcp-tools-<version>.vsix`。
2. 在 VS Code 执行 **Extensions: Install from VSIX…**，选择该文件。
3. 重新打开一个 Windows 本地文件夹工作区。
4. 从命令面板运行 **NetSuite MCP：配置连接**。

## 首次配置

1. 输入 accountId，例如 sandbox `9832121-sb1`，并确认环境类型。
2. 选择 `read`（推荐）或 `write`。write profile 是可选的，且需要独立的 NetSuite Role。
3. 扩展生成 365 天有效的公钥证书和 DPAPI 加密私钥。上传 `*.public.pem` 到 NetSuite：
   - 创建新的、专用的 Integration 并保存 **Client ID**；
   - 进入 **Setup → Integration → Manage Authentication → OAuth 2.0 Client Credentials (M2M) Setup**；
   - 创建映射，选择 Entity、最小权限 Role、Integration，上传公钥；
   - 保存后复制 **Certificate ID**。
4. 回到 VS Code 输入 Client ID 与 Certificate ID。扩展只执行 token、MCP `initialize` 与 `tools/list` 健康检查，不读取业务数据。
5. 验证后，选择 **NetSuite MCP：生成 Agent 配置**。它会在用户确认后写入：
   - `.vscode/mcp.json`：VS Code Copilot；
   - `.mcp.json`：Claude Code。

生成的配置仅包含 `http://127.0.0.1:<port>/<profile-id>/mcp`，没有 private key、Client ID、Certificate ID、JWT 或 access token。

## 写入操作

- write profile 不会自动创建，也不会自动启用。
- 首先为它显式生成 Agent 配置，然后在每个 VS Code 会话中运行 **NetSuite MCP：启用写入连接**。
- 写入端点在 VS Code 重启/关闭时自动关闭；NetSuite Role 才是最终权限边界。
- 代理不会通过工具名称猜测读写权限，也不会重放网络超时、5xx 或工具业务错误。

## 证书轮换与移除

- 到期前 7 天开始提醒。
- 运行 **NetSuite MCP：轮换证书** 生成新的本机证书；在 NetSuite 创建新的 M2M 映射并验证成功后，手动改用新 profile。
- 扩展不会自动撤销 NetSuite 远端证书或 Integration。移除本机 profile 后，请由管理员按需要撤销 Certificate ID。
- 已过期证书对应的本机文件可安全删除；复制项目到另一个 Windows 用户/设备后必须重新配对。

## 故障处理

| 症状 | 处理方式 |
| --- | --- |
| 健康检查返回 token 拒绝 | 核对专用 Integration、Client ID、Certificate ID、M2M Entity/Role 与 OAuth feature。 |
| MCP 初始化失败 | 确认 SuiteApp 已安装、Role 有正确权限，并仅在 sandbox 运行 Phase 0。 |
| 本地端口冲突 | 运行 **NetSuite MCP：修复本地端口**；扩展会在确认后更新已受管的配置。 |
| 私钥无法解密 | 该项目可能被复制到其他 Windows 用户/电脑；重新生成证书并完成 M2M 映射。 |
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

最后一条命令会生成可通过 VS Code 安装的 `.vsix` 文件。真实 NetSuite 验证只允许最小权限 sandbox，且只执行 token、`initialize` 和 `tools/list`；不要把 production 当作测试环境。
