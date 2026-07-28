import { NetSuiteEndpoints, NetSuiteMcpError } from "../domain/types";

const ACCOUNT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MCP_PATH = "/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools";

export function normalizeAccountId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (!ACCOUNT_ID_PATTERN.test(normalized)) {
    throw new NetSuiteMcpError("invalid-account-id", "accountId 只能包含字母、数字和连字符，例如 9832121-sb1。");
  }
  return normalized;
}

export function inferEnvironmentType(accountId: string): "sandbox" | "production" {
  return /-sb\d+$/.test(accountId) ? "sandbox" : "production";
}

export function buildNetSuiteEndpoints(accountIdInput: string): NetSuiteEndpoints {
  const accountId = normalizeAccountId(accountIdInput);
  const host = `${accountId}.suitetalk.api.netsuite.com`;
  return {
    accountId,
    host,
    tokenUrl: `https://${host}/services/rest/auth/oauth2/v1/token`,
    mcpUrl: `https://${host}${MCP_PATH}`
  };
}
