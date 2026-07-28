import { describe, expect, it } from "vitest";
import { buildNetSuiteEndpoints, inferEnvironmentType, normalizeAccountId } from "../net/endpoints";

describe("NetSuite endpoint construction", () => {
  it("normalizes sandbox account ids without accepting a custom host", () => {
    expect(normalizeAccountId(" 9832121_SB1 ")).toBe("9832121-sb1");
    expect(buildNetSuiteEndpoints("9832121_SB1")).toEqual({
      accountId: "9832121-sb1",
      host: "9832121-sb1.suitetalk.api.netsuite.com",
      authorizationUrl: "https://9832121-sb1.app.netsuite.com/app/login/oauth2/authorize.nl",
      tokenUrl: "https://9832121-sb1.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token",
      mcpUrl: "https://9832121-sb1.suitetalk.api.netsuite.com/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools"
    });
  });

  it("rejects an account id that could inject an arbitrary host", () => {
    expect(() => normalizeAccountId("9832121.example.com")).toThrow("accountId");
    expect(() => normalizeAccountId("https://example.com")).toThrow("accountId");
  });

  it("uses the sandbox suffix only as an environment suggestion", () => {
    expect(inferEnvironmentType("9832121-sb2")).toBe("sandbox");
    expect(inferEnvironmentType("9832121")).toBe("production");
  });
});
