import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
export const systemBinary = (name: string) =>
  path.join(process.env.SystemRoot || "C:\\Windows", "System32", name);
export function hostCommand(
  binary: string,
  args: string[],
  options: {
    input?: string | Readable;
    timeoutMs?: number;
    signal?: AbortSignal;
    encoding?: BufferEncoding;
    limit?: number;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn(binary, args, {
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      settled = false,
      stopError: Error | undefined;
    let termination: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (process.platform === "win32" && child.pid)
        spawn(systemBinary("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(termination);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(stdout.toString(options.encoding || "utf8"));
    };
    const stop = (message: string) => {
      if (stopError) return;
      stopError = new Error(message);
      kill();
      termination = setTimeout(() => finish(stopError), 5000);
      termination.unref();
    };
    const abort = () => stop("操作已取消");
    const timer = setTimeout(() => stop("运行环境准备超时"), options.timeoutMs || 60000);
    timer.unref();
    child.on("error", finish);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > (options.limit || 4 * 1024 * 1024)) {
        stop("命令输出超出限制");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-12000);
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) =>
      finish(
        stopError ||
          (code === 0
            ? undefined
            : new Error(
                "运行环境命令失败: " +
                  stderr.toString("utf8") +
                  stdout.toString(options.encoding || "utf8").slice(-2000),
              )),
      ),
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (typeof options.input === "string") child.stdin.end(options.input);
    else if (options.input) {
      options.input.on("error", (error) => {
        kill();
        finish(error);
      });
      options.input.pipe(child.stdin);
    } else child.stdin.end();
  });
}
