import { describe, expect, it } from "vitest";
import { mcpHttpRequest } from "@/execution/capability-runtime";

describe("MCP Streamable HTTP request", () => {
  it("performs initialize, initialized notification and carries the session id", async () => {
    const requests: Array<{ method: string; headers: Headers }> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      requests.push({ method: body.method, headers: new Headers(init?.headers) });
      if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-1" } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "read" }] } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const out = await mcpHttpRequest("https://mcp.example.test", "tools/list", {}, { fetchImpl, secret: "secret", timeoutMs: 5_000 });
    expect(out.ok).toBe(true);
    expect((out.payload as { result: { tools: Array<{ name: string }> } }).result.tools[0]?.name).toBe("read");
    expect(requests.map((request) => request.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(requests[2]?.headers.get("mcp-session-id")).toBe("session-1");
    expect(requests[2]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(requests[2]?.headers.get("authorization")).toBe("Bearer secret");
  });

  it("falls back to a legacy direct call only for an explicit unsupported handshake", async () => {
    const methods: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      methods.push(body.method);
      if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } }), { status: 200 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), { status: 200 });
    };
    const out = await mcpHttpRequest("https://legacy.example.test", "tools/call", { name: "echo", arguments: {} }, { fetchImpl });
    expect(out.ok).toBe(true);
    expect(methods).toEqual(["initialize", "tools/call"]);
  });
});

