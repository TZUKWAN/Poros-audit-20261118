import { createServer, type Server } from "node:http";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";

/**
 * 4.3.3 pi-reactor 长驻触发桥：
 *  - cron：`pi-reactor trigger add <id> --schedule <cron> --agent <agent> --task <task>`（触发后 `trigger rm` 注销）
 *  - webhook：`pi-reactor webhook --port <p>` 起监听；本桥同时内置本地 webhook 接收器（可测试的真实 HTTP 路径）
 *  pi-reactor 为独立守护进程（DECISIONS D5：子进程 CLI 集成）；桥的可注入 runner 供测试断言命令，
 *  本地 webhook 监听器是真实 HTTP 实现。
 */

export interface CliRunner {
  run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface TriggerSpec {
  id: string;
  schedule: string;
  agent: string;
  task: string;
}

export class ReactorBridge {
  constructor(private runner: CliRunner) {}

  async addCronTrigger(spec: TriggerSpec): Promise<void> {
    const r = await this.runner.run("pi-reactor", [
      "trigger", "add", spec.id,
      "--schedule", spec.schedule,
      "--agent", spec.agent,
      "--task", spec.task,
    ]);
    if (r.code !== 0) {
      throw new ScenarioError({
        code: ScenarioErrorCode.INVOKE_FAILED,
        message: `pi-reactor trigger add failed: ${r.stderr.slice(0, 200)}`,
        phase: "executing",
      });
    }
  }

  async removeTrigger(id: string): Promise<void> {
    const r = await this.runner.run("pi-reactor", ["trigger", "rm", id]);
    if (r.code !== 0) {
      throw new ScenarioError({
        code: ScenarioErrorCode.INVOKE_FAILED,
        message: `pi-reactor trigger rm failed: ${r.stderr.slice(0, 200)}`,
        phase: "executing",
      });
    }
  }

  async startWebhookDaemon(port: number): Promise<void> {
    // 分离式守护进程（不等待退出）
    const r = await this.runner.run("pi-reactor", ["webhook", "--port", String(port)]);
    if (r.code !== 0 && !r.stdout.includes("listening")) {
      throw new ScenarioError({
        code: ScenarioErrorCode.INVOKE_FAILED,
        message: `pi-reactor webhook failed: ${r.stderr.slice(0, 200)}`,
        phase: "executing",
      });
    }
  }
}

export interface LocalWebhookOptions {
  port?: number; // 0 = 随机
  /** 收到 POST 后的回路启动器 */
  onStart(payload: unknown): void | Promise<void>;
  /** 鉴权 token（header x-scenario-token 可选校验） */
  token?: string;
}

export interface LocalWebhookServer {
  port: number;
  close(): Promise<void>;
  /** 触发一次后自动关闭（cron/webhook 一次性语义） */
  url: string;
}

/** 本地 webhook 监听器：真实 HTTP POST → onStart 回调；带一次性触发自动注销 */
export function startLocalWebhook(options: LocalWebhookOptions): Promise<LocalWebhookServer> {
  return new Promise((resolve) => {
    let fired = false;
    const server: Server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (options.token && req.headers["x-scenario-token"] !== options.token) {
        res.writeHead(401).end();
        return;
      }
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: true, alreadyFired: fired }));
        if (fired) return; // 一次性：重复 POST 忽略
        fired = true;
        let payload: unknown = null;
        try {
          payload = JSON.parse(body);
        } catch {
          payload = body;
        }
        void Promise.resolve(options.onStart(payload)).finally(() => {
          setTimeout(() => server.close(), 50);
        });
      });
    });
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/hook`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
