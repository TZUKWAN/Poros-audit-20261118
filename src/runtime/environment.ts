import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { localSocket } from "../server/docker-control.js";
import { dockerJson } from "../server/docker-session.js";
export async function ensureRuntimeImage(input: {
  imageId: string;
  archive: string;
  sha256: string;
}) {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.imageId) || !/^[a-f0-9]{64}$/.test(input.sha256))
    throw new Error("运行组件标识无效");
  const socketPath = await localSocket();
  if (!socketPath) throw new Error("当前安装器需要本机 Linux Engine；请先准备运行环境");
  const existing = await dockerJson(
    socketPath,
    "GET",
    "/images/" + encodeURIComponent(input.imageId) + "/json",
  );
  if (existing.status === 200 && (existing.data as { Id?: string }).Id === input.imageId) return;
  if (existing.status !== 404) throw new Error("无法核验本机执行环境");
  const details = await stat(input.archive);
  if (!details.isFile() || details.size > 2 * 1024 * 1024 * 1024)
    throw new Error("运行组件文件无效");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(input.archive)) hash.update(chunk);
  if (hash.digest("hex") !== input.sha256) throw new Error("运行组件校验失败，未载入");
  await new Promise<void>((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        agent: false,
        path: "/v1.47/images/load?quiet=1",
        method: "POST",
        headers: { "content-type": "application/x-tar", "content-length": details.size },
      },
      (response) => {
        let result = "";
        response.on("data", (chunk) => {
          result += chunk;
          if (result.length > 2 * 1024 * 1024) request.destroy(new Error("运行组件返回过大"));
        });
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error("运行组件载入失败"));
            return;
          }
          try {
            for (const line of result.split("\n").filter(Boolean))
              if (JSON.parse(line).error) throw new Error("Engine 拒绝运行组件");
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(120000, () => request.destroy(new Error("载入运行组件超时")));
    request.on("error", reject);
    const stream = createReadStream(input.archive);
    stream.on("error", (error) => request.destroy(error));
    stream.pipe(request);
  });
  const loaded = await dockerJson(
    socketPath,
    "GET",
    "/images/" + encodeURIComponent(input.imageId) + "/json",
  );
  if (loaded.status !== 200 || (loaded.data as { Id?: string }).Id !== input.imageId)
    throw new Error("载入后的运行组件不匹配");
}
