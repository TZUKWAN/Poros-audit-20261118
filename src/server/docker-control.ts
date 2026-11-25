import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Resolve the same local endpoint selected by Docker CLI, without reading TLS/private credentials. */
export async function localSocket(): Promise<string | null> {
  if (process.env.POROS_DOCKER_SOCKET) return process.env.POROS_DOCKER_SOCKET;
  const configRoot = process.env.DOCKER_CONFIG || path.join(homedir(), ".docker");
  let currentContext = "default";
  try {
    currentContext =
      (
        JSON.parse(await readFile(path.join(configRoot, "config.json"), "utf8")) as {
          currentContext?: string;
        }
      ).currentContext || "default";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let endpoint =
    !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST ? process.env.DOCKER_HOST : "";
  const context = process.env.DOCKER_CONTEXT || currentContext;
  if (!endpoint && context !== "default") {
    const root = path.join(configRoot, "contexts", "meta");
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const meta = JSON.parse(await readFile(path.join(root, item.name, "meta.json"), "utf8")) as {
        Name?: string;
        Endpoints?: { docker?: { Host?: string } };
      };
      if (meta.Name === context) {
        endpoint = meta.Endpoints?.docker?.Host || "";
        break;
      }
    }
    if (!endpoint) return null;
  }
  endpoint ||=
    process.platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock";
  if (endpoint.startsWith("npipe://"))
    return endpoint.slice("npipe://".length).replaceAll("/", "\\");
  if (endpoint.startsWith("unix://")) return endpoint.slice("unix://".length);
  return null; // Remote TLS/SSH contexts continue through the existing CLI adapter.
}

export async function localDockerControl(
  method: "GET" | "DELETE",
  resource: string,
): Promise<{ status: number; data: unknown } | null> {
  const socketPath = await localSocket();
  if (!socketPath) return null;
  if (!/^\/(?:containers|networks)\/[A-Za-z0-9_.-]+(?:\/json)?(?:\?force=1)?$/.test(resource))
    throw new Error("Invalid Docker control resource");
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, agent: false, path: resource, method },
      (response) => {
        let text = "",
          bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) request.destroy(new Error("Docker metadata exceeds limit"));
          else text += chunk.toString("utf8");
        });
        response.on("end", () => {
          try {
            resolve({ status: response.statusCode || 500, data: text ? JSON.parse(text) : null });
          } catch {
            reject(new Error("Invalid Docker control response"));
          }
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(6000, () => request.destroy(new Error("Docker control request timed out")));
    request.on("error", reject);
    request.end();
  });
}
