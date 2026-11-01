#!/usr/bin/env node
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2);
const value = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? fallback : fallback; };
const endpoint = process.env.SCENARIO_HOST_ENDPOINT ?? "http://127.0.0.1:4320/api/host-context";
const token = process.env.SCENARIO_HOST_TOKEN ?? "";
const kind = value("--kind", "terminal");
const origin = value("--origin", "terminal");
const label = value("--label", "终端输出");
const content = args.includes("--file") ? await readFile(value("--file", ""), "utf8") : await new Promise((resolve) => { let data = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { data += chunk; }); process.stdin.on("end", () => resolve(data)); });
const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-scenario-host-token": token }, body: JSON.stringify({ kind, origin, label, content }) });
if (!response.ok) { console.error(await response.text()); process.exit(1); }
process.stdout.write((await response.text()) + "\n");
