import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSink {
  write(line: string): Promise<void>;
}

/** 文件 sink：append，超过 maxSizeBytes 自动轮转为 .1（tmp+rename 原子） */
export class FileSink implements LogSink {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string, private maxSizeBytes = 5 * 1024 * 1024) {}

  write(line: string): Promise<void> {
    this.queue = this.queue.then(() => this.writeSync(line));
    return this.queue;
  }

  private async writeSync(line: string): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const s = await stat(this.filePath);
      if (s.size + Buffer.byteLength(line) > this.maxSizeBytes) {
        await rename(this.filePath, `${this.filePath}.1`);
      }
    } catch {
      // 文件不存在 → 直接写
    }
    await appendFile(this.filePath, line);
  }
}

/** 内存 sink：测试与面板快照用 */
export class MemorySink implements LogSink {
  readonly lines: string[] = [];
  write(line: string): Promise<void> {
    this.lines.push(line);
    return Promise.resolve();
  }
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  /** 子 logger：固定阶段标签 */
  forPhase(phase: string): Logger;
  flush(): Promise<void>;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  phase?: string;
  sinks?: LogSink[];
  /** stderr 镜像（默认 warn 以上输出；测试可关） */
  mirrorStderr?: boolean;
  now?: () => Date;
}

function formatLine(level: LogLevel, phase: string, message: string, context: Record<string, unknown> | undefined, now: Date): string {
  const ctx = context && Object.keys(context).length > 0 ? ` ${safeJson(context)}` : "";
  return `${now.toISOString()} [${level.toUpperCase()}] [${phase}] ${message}${ctx}\n`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => {
      if (val instanceof Error) return `${val.name}: ${val.message}`;
      return val;
    }) ?? "";
  } catch {
    return String(v);
  }
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const {
    level = "info",
    phase = "app",
    sinks = [],
    mirrorStderr = true,
    now = () => new Date(),
  } = options;
  const minOrder = LEVEL_ORDER[level];
  const pending: Promise<void>[] = [];

  const log = (lvl: LogLevel) => (message: string, context?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lvl] < minOrder) return;
    const line = formatLine(lvl, phase, message, context, now());
    for (const sink of sinks) pending.push(sink.write(line));
    if (mirrorStderr && LEVEL_ORDER[lvl] >= LEVEL_ORDER.warn) {
      process.stderr.write(line);
    }
  };

  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    forPhase: (p: string) => createLogger({ level, phase: p, sinks, mirrorStderr, now }),
    flush: async () => {
      await Promise.all(pending);
    },
  };
}

/** 默认落盘路径：build-log/run-<ts>.log（相对项目根或绝对路径均可） */
export function defaultRunLogPath(buildLogDir: string, now = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return path.join(buildLogDir, `run-${ts}.log`);
}
