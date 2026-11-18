import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

export class ProviderError extends Error {
  constructor(
    readonly reason: string,
    readonly http?: number,
    readonly providerCode?: string,
  ) {
    super(reason);
  }
}

// Deny internal, documentation, multicast and reserved networks, including mapped IPv6.
const nonPublic = new BlockList();
for (const [network, size] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  nonPublic.addSubnet(network, size);
for (const [network, size] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  nonPublic.addSubnet(network, size, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const unbracket = (host: string) => host.replace(/^\[|\]$/g, "");

function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !nonPublic.check(address);
  return family === 6 && globalV6.check(address, "ipv6") && !nonPublic.check(address, "ipv6");
}

function parseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ProviderError("URL_INVALID");
  }
  if (url.username || url.password || url.hash || !["http:", "https:"].includes(url.protocol))
    throw new ProviderError("URL_INVALID");
  return url;
}

export function canonicalModelBase(input: string): string {
  const url = parseUrl(input);
  if (url.search || /[^a-zA-Z0-9/_~.-]/.test(url.pathname)) throw new ProviderError("URL_INVALID");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function permittedLoopback(base: string, url: URL): boolean {
  const host = unbracket(url.hostname);
  if (host !== "127.0.0.1" && host !== "::1") return false;
  return (process.env.POROS_LOCAL_MODEL_BASES || "").split(",").some((item) => {
    try {
      return canonicalModelBase(item.trim()) === base;
    } catch {
      return false;
    }
  });
}

function checkPublicUrl(url: URL): void {
  const host = unbracket(url.hostname).replace(/\.$/, "").toLowerCase();
  if (
    url.protocol !== "https:" ||
    (!isIP(host) &&
      (!host.includes(".") ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(host))) ||
    (isIP(host) && !isPublicIp(host))
  )
    throw new ProviderError("ENDPOINT_NOT_ALLOWED");
}

export function checkModelBase(base: string): void {
  const url = parseUrl(base);
  if (!permittedLoopback(base, url)) checkPublicUrl(url);
}

async function publicAddresses(url: URL) {
  const host = unbracket(url.hostname);
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address)))
    throw new ProviderError("ENDPOINT_NOT_ALLOWED");
  return addresses;
}

/** TinyFetch accepts only public HTTPS URLs. This does not make a request to the target. */
export async function checkPublicTarget(value: string): Promise<string> {
  const url = parseUrl(value);
  checkPublicUrl(url);
  await publicAddresses(url);
  return url.href;
}

interface ProviderRequest {
  method: "GET" | "POST";
  headers: Record<string, string>;
  signal: AbortSignal;
  body?: string;
}

/** Connect to the validated addresses while still checking TLS against the original host. */
export async function requestModel(
  base: string,
  endpoint: "/models" | "/chat/completions",
  init: ProviderRequest,
): Promise<Response> {
  const url = new URL(base + endpoint);
  checkModelBase(base);
  const addresses = permittedLoopback(base, url) ? undefined : await publicAddresses(url);
  init.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: init.method,
        headers: { ...init.headers, "accept-encoding": "identity" },
        signal: init.signal,
        agent: false,
        lookup: addresses
          ? (_hostname, options, callback) => {
              if (options.all) callback(null, addresses);
              else callback(null, addresses[0]!.address, addresses[0]!.family);
            }
          : undefined,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        if (status < 200 || status >= 600) {
          incoming.destroy();
          reject(new ProviderError("INVALID_RESPONSE", status));
          return;
        }
        const hasBody = ![204, 205, 304].includes(status);
        if (!hasBody) incoming.resume();
        resolve(
          new Response(hasBody ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : null, {
            status,
            headers: {
              "content-type": incoming.headers["content-type"] ?? "application/octet-stream",
            },
          }),
        );
      },
    );
    req.once("error", reject);
    req.end(init.body);
  });
}

export async function readProviderText(res: Response, limit = 2 * 1024 * 1024): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0,
    output = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return output + decoder.decode();
      size += value.byteLength;
      if (size > limit) throw new ProviderError("RESPONSE_TOO_LARGE", res.status);
      output += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function checkProviderResponse(res: Response, model = false): Promise<void> {
  if (res.ok) return;
  if (model) {
    const details = await readProviderText(res, 32768).catch(() => "");
    if (/VALIDATION_REQUIRED|Verify your account to continue/i.test(details))
      throw new ProviderError("ACCOUNT_VALIDATION_REQUIRED", res.status);
    if (/auth_unavailable|no auth available/i.test(details))
      throw new ProviderError("UPSTREAM_AUTH_UNAVAILABLE", res.status);
  } else {
    await res.body?.cancel().catch(() => {});
  }
  throw new ProviderError(
    res.status === 401 || res.status === 403
      ? "AUTH_REJECTED"
      : res.status === 429
        ? "RATE_LIMITED"
        : res.status < 400
          ? "REDIRECT_REJECTED"
          : "UPSTREAM_FAILURE",
    res.status,
  );
}

export async function* providerEvents(res: Response): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new ProviderError("INVALID_RESPONSE", res.status);
  const decoder = new TextDecoder();
  let size = 0,
    pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new ProviderError("RESPONSE_TOO_LARGE", res.status);
      pending += decoder.decode(value, { stream: true });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop()!;
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
