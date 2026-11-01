export interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  category: "workspace" | "scenario" | "memory" | "run" | "settings";
}

export const COMMANDS: CommandDefinition[] = [
  { name: "/help", description: "查看可用命令", usage: "/help", category: "workspace" },
  { name: "/work", description: "切换到工作模式", usage: "/work", category: "workspace" },
  { name: "/build", description: "切换到场景构建模式", usage: "/build", category: "workspace" },
  { name: "/new", description: "新建对话", usage: "/new", category: "workspace" },
  { name: "/archive", description: "归档当前对话", usage: "/archive", category: "workspace" },
  { name: "/rename", description: "重命名当前对话", usage: "/rename <标题>", category: "workspace" },
  { name: "/export", description: "导出当前对话", usage: "/export", category: "workspace" },
  { name: "/search", description: "搜索对话、场景、Memory、文件和运行", usage: "/search <关键词>", category: "workspace" },
  { name: "/scenario list", description: "查看场景库", usage: "/scenario list", category: "scenario" },
  { name: "/scenario inspect", description: "查看场景详情", usage: "/scenario inspect <id>", category: "scenario" },
  { name: "/scenario test", description: "用场景做一次干跑", usage: "/scenario test <id>", category: "scenario" },
  { name: "/scenario version", description: "查看场景版本", usage: "/scenario version <id>", category: "scenario" },
  { name: "/use", description: "选择一个场景用于工作", usage: "/use <场景 ID>", category: "scenario" },
  { name: "/memory remember", description: "打开 Memory 写入", usage: "/memory remember", category: "memory" },
  { name: "/memory list", description: "查看 Memory 文件", usage: "/memory list", category: "memory" },
  { name: "/memory search", description: "搜索 Memory", usage: "/memory search <关键词>", category: "memory" },
  { name: "/memory forget", description: "删除一条 Memory", usage: "/memory forget <路径>", category: "memory" },
  { name: "/files list", description: "查看当前项目文件", usage: "/files list", category: "workspace" },
  { name: "/files add", description: "添加文件到当前项目", usage: "/files add", category: "workspace" },
  { name: "/run stop", description: "停止当前运行", usage: "/run stop", category: "run" },
  { name: "/run pause", description: "暂停当前运行", usage: "/run pause", category: "run" },
  { name: "/run resume", description: "继续当前运行", usage: "/run resume", category: "run" },
  { name: "/run retry", description: "重试最近一次运行", usage: "/run retry", category: "run" },
  { name: "/task trigger", description: "触发事件任务", usage: "/task trigger <事件>", category: "run" },
  { name: "/settings", description: "打开运行设置", usage: "/settings", category: "settings" },
  { name: "/model", description: "打开模型设置", usage: "/model", category: "settings" },
  { name: "/connect", description: "打开连接器中心", usage: "/connect", category: "settings" },
];

export function commandSuggestions(input: string): CommandDefinition[] {
  const query = input.trim().toLowerCase();
  if (!query.startsWith("/")) return [];
  return COMMANDS.filter((command) => command.name.startsWith(query) || command.usage.toLowerCase().startsWith(query)).slice(0, 8);
}

export function parseCommand(input: string): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.split(/\s+/);
  const name = parts.slice(0, 2).join(" ");
  if (COMMANDS.some((command) => command.name === name)) return { name, args: parts.slice(name.includes(" ") ? 2 : 1) };
  return { name: parts[0] ?? trimmed, args: parts.slice(1) };
}
