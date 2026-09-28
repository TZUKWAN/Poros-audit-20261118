import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSink, MemorySink, createLogger, defaultRunLogPath } from "@/core/log";

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("createLogger 分级与格式", () => {
  it("行格式：时间 [LEVEL] [phase] message {json}", async () => {
    const mem = new MemorySink();
    const fixed = new Date("2026-09-29T00:00:00.000Z");
    const log = createLogger({ level: "debug", phase: "retrieving", sinks: [mem], mirrorStderr: false, now: () => fixed });
    log.info("扇出完成", { sources: 8 });
    expect(mem.lines).toHaveLength(1);
    expect(mem.lines[0]).toBe("2026-09-29T00:00:00.000Z [INFO] [retrieving] 扇出完成 {\"sources\":8}\n");
  });

  it("低于设定级别不输出", async () => {
    const mem = new MemorySink();
    const log = createLogger({ level: "warn", sinks: [mem], mirrorStderr: false });
    log.debug("x");
    log.info("y");
    log.warn("z");
    expect(mem.lines).toHaveLength(1);
    expect(mem.lines[0]).toContain("[WARN]");
  });

  it("forPhase 派生 logger 保留级别与 sink、替换阶段", async () => {
    const mem = new MemorySink();
    const log = createLogger({ level: "info", sinks: [mem], mirrorStderr: false });
    log.forPhase("executing").error("失败");
    expect(mem.lines[0]).toContain("[ERROR] [executing] 失败");
  });

  it("Error 实例在 context 中序列化为 name: message", async () => {
    const mem = new MemorySink();
    const log = createLogger({ sinks: [mem], mirrorStderr: false });
    log.warn("带错误", { err: new TypeError("nope") });
    expect(mem.lines[0]).toContain('"err":"TypeError: nope"');
  });

  it("flush 等待文件 sink 写完", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pilog-"));
    const file = path.join(dir, "run.log");
    const log = createLogger({ sinks: [new FileSink(file)], mirrorStderr: false });
    log.info("one");
    log.info("two");
    await log.flush();
    const content = await readFile(file, "utf8");
    expect(content).toContain("one");
    expect(content).toContain("two");
  });
});

describe("FileSink 落盘", () => {
  it("目录自动创建 + 追加写", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pilog-"));
    const file = path.join(dir, "nested", "run.log");
    const sink = new FileSink(file);
    await sink.write("a\n");
    await sink.write("b\n");
    const content = await readFile(file, "utf8");
    expect(content).toBe("a\nb\n");
  });

  it("超过 maxSize 轮转为 .1", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pilog-"));
    const file = path.join(dir, "run.log");
    const sink = new FileSink(file, 16);
    await sink.write("11111111111111111111\n"); // 21 bytes > 16
    await sink.write("2222\n");
    expect(await readFile(`${file}.1`, "utf8")).toContain("11111111111111111111");
    expect(await readFile(file, "utf8")).toBe("2222\n");
  });
});

describe("defaultRunLogPath", () => {
  it("生成 build-log/run-<ts>.log 形态", () => {
    const p = defaultRunLogPath("build-log", new Date("2026-09-29T01:02:03.004Z"));
    expect(p).toMatch(/build-log[\\/]run-2026-09-29T01-02-03-004Z\.log$/);
  });
});
