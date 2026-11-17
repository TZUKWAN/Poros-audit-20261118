/** Dedicated disposable fixture, no host DSH or existing Compose projects touched. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const name = "poros-iso05-" + randomUUID();
const docker = (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 30000 });
try {
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "none",
    "--user",
    "10001:10001",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/home/poros:uid=10001,gid=10001,mode=0700",
    "poros/dsh:0.2.2-rc.1-audit",
    "sleep",
    "infinity",
  ]);
  const meta = JSON.parse(docker(["inspect", name]))[0];
  assert.equal(meta.Config.User, "10001:10001");
  assert.equal(meta.HostConfig.Privileged, false);
  assert.equal(meta.HostConfig.ReadonlyRootfs, true);
  assert.equal(meta.HostConfig.NetworkMode, "none");
  assert.ok(meta.Mounts.every((m) => m.Type !== "bind"));
  assert.ok(meta.HostConfig.CapDrop.includes("ALL"));
  const root = docker(["exec", name, "ls", "/"]);
  for (const dir of ["Users", "host", "c"]) assert.ok(!root.split(/\s+/).includes(dir));
  assert.equal(docker(["exec", name, "id", "-u"]).trim(), "10001");
  console.log("ISO-05 PASS: no host mounts, no root/capabilities, read-only root, private network");
} finally {
  docker(["rm", "-f", name]);
}
