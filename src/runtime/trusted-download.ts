import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { hostCommand, systemBinary } from "./host-process.js";
export async function fileHash(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
const script = `$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$p=[Console]::In.ReadToEnd()|ConvertFrom-Json
Invoke-WebRequest -UseBasicParsing -Uri $p.url -OutFile $p.file -TimeoutSec 120
`;
/** Callers supply fixed official HTTPS origins. TLS validation is never disabled. */
export async function trustedDownload(
  url: string,
  file: string,
  sha256?: string,
  signal?: AbortSignal,
) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    !["dl-cdn.alpinelinux.org", "github.com"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password
  )
    throw new Error("下载来源不在官方允许列表");
  await mkdir(path.dirname(file), { recursive: true });
  if (sha256 && (await fileHash(file).catch(() => "")) === sha256) return;
  const temporary = file + ".download-" + randomUUID();
  try {
    if (process.platform === "win32") {
      const scriptFile = path.join(
        path.dirname(file),
        "poros-download-" + createHash("sha256").update(script).digest("hex").slice(0, 12) + ".ps1",
      );
      await writeFile(scriptFile, script, { mode: 0o600 });
      await hostCommand(
        systemBinary("WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile],
        { input: JSON.stringify({ url, file: temporary }), timeoutMs: 130000, signal },
      );
    } else {
      const response = await fetch(url, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
          : AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error("官方下载失败: " + response.status);
      await writeFile(temporary, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    }
    if (sha256 && (await fileHash(temporary)) !== sha256) throw new Error("下载校验不匹配，未使用");
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
