/** Real independent Compose instances. Unique projects; cleanup executes on both success and failure. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
process.env.POROS_DB_PASSWORD ??= "ci-password-0123456789";
const prefix = "poros-iso03-" + randomUUID().slice(0, 8),
  a = prefix + "-a",
  b = prefix + "-b",
  file = "deploy/docker-compose.yml";
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 120000,
    stdio: ["pipe", "pipe", "pipe"],
  });
const exec = (project, code) => docker(["exec", project + "-dsh-1", "node", "-e", code]).trim();
try {
  docker(["image", "inspect", process.env.POROS_DSH_IMAGE || "poros/dsh:0.2.2-rc.1-audit"]);
  for (const p of [a, b]) docker(["compose", "-p", p, "-f", file, "up", "-d", "--no-build", "dsh"]);
  exec(a, "require('fs').writeFileSync('/home/poros/.dsh/iso-marker','A-MARKER')");
  assert.equal(
    exec(b, "console.log(require('fs').existsSync('/home/poros/.dsh/iso-marker'))"),
    "false",
  );
  assert.equal(
    exec(a, "console.log(require('fs').readFileSync('/home/poros/.dsh/iso-marker','utf8'))"),
    "A-MARKER",
  );
  exec(b, "require('fs').writeFileSync('/home/poros/.config/iso-marker','B-MARKER')");
  assert.equal(
    exec(a, "console.log(require('fs').existsSync('/home/poros/.config/iso-marker'))"),
    "false",
  );
  console.log("ISO-03 PASS: independent volumes, reads and configuration; two unique instances");
} finally {
  const failures = [];
  for (const p of [a, b]) {
    assert.ok(p.startsWith(prefix + "-"));
    try {
      docker(["compose", "-p", p, "-f", file, "down", "-v"]);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "ISO-03 cleanup failed");
  console.log("ISO-03 owned temporary projects and volumes removed");
}
