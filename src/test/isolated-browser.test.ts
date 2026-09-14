import { describe, expect, it } from "vitest";
import { isolatedBrowserCommands } from "../util/isolated-browser";

const authorizationUrl = "https://9832121-sb1.app.netsuite.com/app/login/oauth2/authorize.nl?state=test";

describe("isolatedBrowserCommands", () => {
  it("launches Edge/Chrome with an isolated profile and the authorize URL", () => {
    const previous = {
      ProgramFiles: process.env.ProgramFiles,
      x86: process.env["ProgramFiles(x86)"],
      local: process.env.LOCALAPPDATA
    };
    process.env.ProgramFiles = "C:\\Program Files";
    delete process.env["ProgramFiles(x86)"];
    delete process.env.LOCALAPPDATA;
    try {
      const commands = isolatedBrowserCommands(authorizationUrl);
      expect(commands).toEqual([
        { command: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", args: ["--inprivate", authorizationUrl] },
        { command: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", args: ["--incognito", authorizationUrl] }
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
