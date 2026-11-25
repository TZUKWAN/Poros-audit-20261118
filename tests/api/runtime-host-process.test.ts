import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostCommand } from "../../src/runtime/host-process.js";
it("cancels a real owned host process tree before returning", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "poros-host-cancel-")),
    file = path.join(directory, "pids.json"),
    controller = new AbortController();
  try {
    const script =
      'const{spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{windowsHide:true,stdio:"ignore"});require("node:fs").writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setTimeout(()=>{},60000)';
    const work = hostCommand(process.execPath, ["-e", script, file], { signal: controller.signal });
    let pids: number[] = [];
    for (let i = 0; i < 100; i++) {
      try {
        pids = JSON.parse(await readFile(file, "utf8"));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    expect(pids).toHaveLength(2);
    const result = expect(work).rejects.toThrow("操作已取消");
    controller.abort();
    await result;
    for (const pid of pids) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      expect(alive, "owned descendant still running: " + pid).toBe(false);
    }
  } finally {
    const resolved = path.resolve(directory);
    if (
      !resolved.startsWith(path.resolve(tmpdir()) + path.sep) ||
      !path.basename(resolved).startsWith("poros-host-cancel-")
    )
      throw new Error("Unsafe cleanup path");
    await rm(resolved, { recursive: true, force: true });
  }
}, 15000);
