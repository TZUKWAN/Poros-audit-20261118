import { describe, expect, it } from "vitest";
import { commandSuggestions, parseCommand, COMMANDS } from "@/panel/commands";

describe("前端命令注册表", () => {
  it("提供核心工作台命令并支持补全", () => {
    expect(COMMANDS.some((command) => command.name === "/scenario list")).toBe(true);
    expect(commandSuggestions("/sce").map((command) => command.name)).toContain("/scenario list");
    expect(commandSuggestions("hello")).toHaveLength(0);
  });

  it("解析带子命令和参数的命令", () => {
    expect(parseCommand("/scenario inspect sc-1")).toEqual({ name: "/scenario inspect", args: ["sc-1"] });
    expect(parseCommand("/use sc-1")).toEqual({ name: "/use", args: ["sc-1"] });
    expect(parseCommand("普通需求")).toBeNull();
  });
});

