import { afterAll, describe, expect, it } from "vitest";
import { stop } from "esbuild";
import { compileProject } from "../../src/agent-project/compiler.js";
import { starterProject } from "../../src/agent-project/contract.js";
import { runProgram, withMcp } from "../../src/agent-project/sandbox.js";
afterAll(() => stop());

describe("IDE real isolated programs and standard MCP", () => {
  it("executes actual source with private credentials absent and bridges only explicit calls", async () => {
    const files = starterProject("AGENT", "Actual calculator");
    files["agent.ts"] =
      'import {defineAgent} from "@poros/sdk"; export default defineAgent(async(input,ctx)=>({value:Number(input)*3,asset:await ctx.asset("README.md")}));';
    const build = await compileProject(files);
    expect(build.status, build.diagnostics.join("\n")).toBe("READY");
    const output = await runProgram(build.bundles.agent!, 7, {
      call: async (method, args) => {
        expect(method).toBe("asset");
        expect(args).toEqual(["README.md"]);
        return files["README.md"];
      },
    });
    expect(output).toEqual({ value: 21, asset: files["README.md"] });
    expect(
      await runProgram(
        "exports.default=()=>({uid:process.getuid(),key:process.env.POROS_SETTINGS_KEY ?? null});",
        null,
      ),
    ).toEqual({ uid: 10001, key: null });
  }, 120000);
  it("discovers and calls a real generated MCP server with official SDK handshake and schema errors", async () => {
    const build = await compileProject(starterProject("MCP", "MCP protocol test"));
    expect(build.status, build.diagnostics.join("\n")).toBe("READY");
    await withMcp(build.bundles.mcp!, {}, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("echo");
      const called = await client.callTool({
        name: "echo",
        arguments: { text: "ACTUAL-MCP-EXECUTION" },
      });
      expect(called.structuredContent).toEqual({ text: "ACTUAL-MCP-EXECUTION" });
      await expect(client.callTool({ name: "echo", arguments: { text: 42 } })).rejects.toThrow(
        "Invalid tool input",
      );
    });
  }, 120000);
  it("terminates cancelled isolated code and reports failure", async () => {
    await expect(
      runProgram(
        "exports.default=async()=>{await new Promise(r=>setTimeout(r,60000));return 1;};",
        null,
        { timeoutMs: 1500 },
      ),
    ).rejects.toThrow(/取消|超时/);
  }, 30000);
  it("fails on an event observer error and still removes its real container", async () => {
    await expect(
      runProgram(
        'exports.default=async(input,ctx)=>{ctx.emit("sample",1);await new Promise(r=>setTimeout(r,60000));return 1;};',
        null,
        {
          timeoutMs: 15000,
          event: (type) => {
            if (type === "program.event") throw new Error("explicit-observer-failure");
          },
        },
      ),
    ).rejects.toThrow("explicit-observer-failure");
  }, 30000);
});
