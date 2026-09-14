import { describe, expect, it } from "vitest";
import { isolatedBrowserCommands, isolatedBrowserProfileDir } from "../util/isolated-browser";

const authorizationUrl = "https://9832121-sb1.app.netsuite.com/app/login/oauth2/authorize.nl?state=test";

describe("isolatedBrowserCommands", () => {
  it("launches Edge/Chrome with a dedicated user-data-dir and the authorize URL", () => {
    const previous = {
      ProgramFiles: process.env.ProgramFiles,
      x86: process.env["ProgramFiles(x86)"],
      local: process.env.LOCALAPPDATA
    };
    process.env.ProgramFiles = "C:\\Program Files";
    process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
    delete process.env["ProgramFiles(x86)"];
    try {
      const profileDir = isolatedBrowserProfileDir();
      expect(profileDir).toBe("C:\\Users\\test\\AppData\\Local\\netsuite-mcp-tools\\browser-profile");
      const args = [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", authorizationUrl];
      expect(isolatedBrowserCommands(authorizationUrl)).toEqual([
        { command: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", args },
        { command: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", args },
        { command: "C:\\Users\\test\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe", args },
        { command: "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe", args }
      ]);
    } finally {
      process.env.ProgramFiles = previous.ProgramFiles;
      if (previous.x86 === undefined) {
        delete process.env["ProgramFiles(x86)"];
      } else {
        process.env["ProgramFiles(x86)"] = previous.x86;
      }
      if (previous.local === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = previous.local;
      }
    }
  });
});
