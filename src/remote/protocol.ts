/** Shared wire contract: length-prefixed JSON headers and a bounded raw body, avoiding base64 CPU overhead. */
export const MAX_BODY = 512 * 1024,
  MAX_REPLY = 2 * 1024 * 1024;
export interface RemotePacket {
  type: "request" | "response";
  id: string;
  method?: string;
  path?: string;
  base?: string;
  headers: Record<string, string>;
  status?: number;
}
export function encodePacket(meta: RemotePacket, body = new Uint8Array()): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify(meta));
  if (header.length > 12000 || body.byteLength > MAX_REPLY)
    throw new Error("Remote packet too large");
  const packet = new Uint8Array(4 + header.length + body.byteLength);
  new DataView(packet.buffer).setUint32(0, header.length);
  packet.set(header, 4);
  packet.set(body, 4 + header.length);
  return packet;
}
export function decodePacket(input: ArrayBuffer | Uint8Array) {
  const packet = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (packet.length < 4 || packet.length > MAX_REPLY + 12004)
    throw new Error("Invalid remote packet");
  const length = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0);
  if (length > 12000 || length + 4 > packet.length) throw new Error("Invalid remote header");
  const meta = JSON.parse(new TextDecoder().decode(packet.subarray(4, 4 + length))) as RemotePacket;
  if (
    !meta ||
    !["request", "response"].includes(meta.type) ||
    !/^[a-f0-9-]{36}$/.test(meta.id) ||
    !meta.headers ||
    typeof meta.headers !== "object" ||
    Array.isArray(meta.headers)
  )
    throw new Error("Invalid remote metadata");
  return { meta, body: packet.subarray(4 + length) };
}
export function remoteAllowed(method: string, raw: string) {
  if (
    !raw.startsWith("/") ||
    raw.length > 500 ||
    /[%\\?#]/.test(raw) ||
    [...raw].some((char) => char.charCodeAt(0) <= 32) ||
    raw.includes("..") ||
    raw.includes("//")
  )
    return false;
  if (method === "GET")
    return (
      [
        "/",
        "/manifest.webmanifest",
        "/sw.js",
        "/offline.html",
        "/api/app/info",
        "/api/app/session",
        "/api/app/jobs",
      ].includes(raw) ||
      /^\/icons\/poros-(192|512)\.png$/.test(raw) ||
      /^\/assets\/[A-Za-z0-9_.-]+\.(js|css)$/.test(raw) ||
      /^\/frame\/[A-Za-z0-9_-]{43}$/.test(raw) ||
      /^\/api\/app\/jobs\/[a-f0-9-]{36}$/.test(raw)
    );
  return (
    method === "POST" &&
    ([
      "/api/app/pair/claim",
      "/api/app/pair/result",
      "/api/app/logout",
      "/api/app/jobs",
      "/api/app/preview-ticket",
    ].includes(raw) ||
      /^\/api\/app\/jobs\/[a-f0-9-]{36}\/cancel$/.test(raw))
  );
}
export const forwardedRequestHeaders = [
  "authorization",
  "content-type",
  "idempotency-key",
] as const;
export const forwardedResponseHeaders = [
  "content-type",
  "cache-control",
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "service-worker-allowed",
] as const;
