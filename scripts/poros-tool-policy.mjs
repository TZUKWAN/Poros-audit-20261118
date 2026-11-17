/** Trusted image-owned plugin, exact allowlist at DSH's real dispatch boundary. */
export const name = "poros-pre-execution-policy";
export const inject = ["tools"];
export function apply(ctx) {
  const policy = JSON.parse(process.env.POROS_EXECUTION_POLICY || "{}"),
    allowed = new Set(policy.allowedTools || []),
    context = policy.context || {};
  let calls = 0;
  ctx.on("tools/pre-execute", async (exec, next) => {
    const authorized = Boolean(
      context.organizationId &&
      context.agentId &&
      context.taskId &&
      context.runId &&
      allowed.has(exec.name) &&
      ++calls <= 64,
    );
    process.stdout.write(
      JSON.stringify({
        type: "policy",
        tool: exec.name,
        authorized,
        context,
        reason: authorized ? "frozen-task-grant" : "default-deny",
      }) + "\n",
    );
    return authorized
      ? next()
      : {
          kind: "deny",
          reason: "POROS_TOOL_DENIED: missing exact task capability grant",
          info: { code: "POROS_TOOL_DENIED" },
        };
  });
  ctx.on("tools/execute", async (exec, next) =>
    allowed.has(exec.name)
      ? next()
      : {
          isError: true,
          error: { message: "POROS_TOOL_DENIED" },
          content: [{ type: "text", text: "POROS_TOOL_DENIED" }],
        },
  );
}
