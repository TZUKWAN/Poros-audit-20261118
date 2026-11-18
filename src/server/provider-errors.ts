import { z } from "zod";
import { ProviderError } from "./provider-http.js";

export const messages: Record<string, string> = {
  ACCOUNT_VALIDATION_REQUIRED: "上游要求验证账号。已发送实际请求，生成未通过。",
  UPSTREAM_AUTH_UNAVAILABLE: "网关没有可用的上游账号授权。",
  AUTH_REJECTED: "服务拒绝凭证或当前授权范围。",
  RATE_LIMITED: "服务达到限流，请稍后重试。",
  UPSTREAM_FAILURE: "上游服务请求失败。",
  ENDPOINT_NOT_ALLOWED:
    "端点不在允许的范围。使用公网 HTTPS，或由部署管理员放行确切的本机模型端点。",
  REDIRECT_REJECTED: "端点返回重定向。请填写最终 API 地址。",
  CREDENTIAL_UNREADABLE: "已保存的凭证无法解密，请重新保存。",
  SETTINGS_INCOMPLETE: "请填写当前服务需要的全部配置。",
  URL_INVALID: "API 地址格式不正确。",
  STREAM_REQUIRED: "端点未返回 OpenAI 兼容的流式响应。",
  PROBE_MISMATCH: "服务返回了流式响应，但未正确完成验证请求。",
  PROVIDER_REQUEST_REJECTED: "服务未执行此请求，请检查权限及额度。",
  RESPONSE_TOO_LARGE: "服务响应超过大小限制。",
  INVALID_RESPONSE: "服务返回了无法解析的响应。",
  NOT_VERIFIED: "请先在设置中验证连接。",
  MODEL_BINDING_CHANGED: "模型端点、模型名或凭证已变更，请重新提交任务。",
  ACTION_NOT_SUPPORTED: "当前连接不支持该操作。",
  TIMEOUT: "连接超时。",
  NETWORK_ERROR: "连接失败，请检查服务地址和网络。",
};

export function describeProviderError(error: unknown) {
  const code =
    error instanceof ProviderError
      ? error.reason
      : error instanceof z.ZodError || error instanceof SyntaxError
        ? "INVALID_RESPONSE"
        : error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
          ? "TIMEOUT"
          : "NETWORK_ERROR";
  const http = error instanceof ProviderError ? error.http : undefined;
  return {
    code,
    http,
    message:
      (messages[code] || messages.NETWORK_ERROR) +
      (http ? " HTTP " + http : "") +
      (error instanceof ProviderError && error.providerCode ? " · " + error.providerCode : ""),
  };
}
