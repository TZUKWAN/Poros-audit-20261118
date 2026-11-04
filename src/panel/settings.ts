import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Store } from "@/core/store.js";

export const PanelSettingsSchema = z.object({
  baseUrl: z.string().url().default("https://openrouter.ai/api/v1"),
  model: z.string().min(1).default("nvidia/nemotron-3-ultra-550b-a55b:free"),
  plannerModel: z.string().min(1).nullable().default(null),
  fallbackModel: z.string().min(1).nullable().default(null),
  temperature: z.number().min(0).max(2).default(0.1),
  maxTokens: z.number().int().positive().max(128_000).nullable().default(null),
  apiKey: z.string().default(""),
  timeoutMs: z.number().int().min(1_000).max(180_000).default(45_000),
  providerId: z.string().nullable().default(null),
  streaming: z.boolean().default(true),
  syncEndpoint: z.string().url().nullable().default(null),
  syncToken: z.string().default(""),
  useHistory: z.boolean().default(true),
  autoMemory: z.boolean().default(true),
  temporarySession: z.boolean().default(false),
  /** 分寸账本灰度（§16）：legacy 只记不用 / spot 自检启用 / full 双路路由+体检 */
  routingMode: z.enum(["legacy", "spot", "full"]).default("legacy"),
});
export type PanelSettings = z.infer<typeof PanelSettingsSchema>;

export const PanelSettingsPatchSchema = z.object({
  baseUrl: z.string().url().optional(),
  model: z.string().min(1).optional(),
  plannerModel: z.string().min(1).nullable().optional(),
  fallbackModel: z.string().min(1).nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(128_000).nullable().optional(),
  apiKey: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(180_000).optional(),
  providerId: z.string().nullable().optional(),
  streaming: z.boolean().optional(),
  syncEndpoint: z.string().url().nullable().optional(),
  syncToken: z.string().optional(),
  useHistory: z.boolean().optional(),
  autoMemory: z.boolean().optional(),
  temporarySession: z.boolean().optional(),
  routingMode: z.enum(["legacy", "spot", "full"]).optional(),
});
export type PanelSettingsPatch = z.infer<typeof PanelSettingsPatchSchema>;

export interface PublicPanelSettings {
  baseUrl: string;
  model: string;
  plannerModel: string | null;
  fallbackModel: string | null;
  temperature: number;
  maxTokens: number | null;
  timeoutMs: number;
  hasApiKey: boolean;
  apiKeyMasked: string;
  useHistory: boolean;
  autoMemory: boolean;
  temporarySession: boolean;
  routingMode: "legacy" | "spot" | "full";
  providerId: string | null;
  streaming: boolean;
  syncEndpoint: string | null;
  hasSyncToken: boolean;
  syncTokenMasked: string;
}

export class PanelSettingsStore {
  private value: PanelSettings;
  private loaded = false;

  constructor(
    private readonly store: Store<PanelSettings>,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.value = PanelSettingsSchema.parse({
      baseUrl: env.OPENROUTER_BASE_URL ?? undefined,
      model: env.OPENROUTER_MODEL ?? undefined,
      apiKey: env.OPENROUTER_API_KEY ?? "",
      timeoutMs: env.OPENROUTER_TIMEOUT_MS ? Number(env.OPENROUTER_TIMEOUT_MS) : undefined,
      syncEndpoint: env.SYNC_ENDPOINT ?? null,
      syncToken: env.SYNC_TOKEN ?? "",
    });
  }

  async load(): Promise<PanelSettings> {
    if (this.loaded) return { ...this.value };
    const saved = await this.store.get("settings");
    if (saved) {
      // R1 审计#9：仅当落盘记录确有该字段时才覆盖 env 注入值；解密失败
      // （返回空串）时保留 env 值并告警，防止旧数据/解密异常永久清除凭据
      const merged: PanelSettings = { ...this.value, ...saved, apiKey: decryptSecret(saved.apiKey), syncToken: decryptSecret(saved.syncToken ?? "") };
      if (!merged.apiKey && this.value.apiKey) {
        merged.apiKey = this.value.apiKey;
        console.warn("[settings] 落盘 API Key 解密为空，已回退为环境变量注入值");
      }
      if (!merged.syncToken && this.value.syncToken) {
        merged.syncToken = this.value.syncToken;
        console.warn("[settings] 落盘 Sync Token 解密为空，已回退为环境变量注入值");
      }
      this.value = PanelSettingsSchema.parse(merged);
      if ((saved.apiKey && !saved.apiKey.startsWith(SECRET_PREFIX)) || (saved.syncToken && !saved.syncToken.startsWith(SECRET_PREFIX))) await this.store.set("settings", { ...this.value, apiKey: encryptSecret(this.value.apiKey), syncToken: encryptSecret(this.value.syncToken) });
    }
    this.loaded = true;
    return { ...this.value };
  }

  async update(patch: PanelSettingsPatch): Promise<PanelSettings> {
    await this.load();
    this.value = PanelSettingsSchema.parse({ ...this.value, ...patch });
    await this.store.set("settings", { ...this.value, apiKey: encryptSecret(this.value.apiKey), syncToken: encryptSecret(this.value.syncToken) });
    return { ...this.value };
  }

  async get(): Promise<PanelSettings> {
    await this.load();
    return { ...this.value };
  }

  async toPlannerEnv(overrides?: { baseUrl?: string; model?: string; timeoutMs?: number; apiKey?: string }): Promise<NodeJS.ProcessEnv> {
    const value = await this.get();
    return {
      ...process.env,
      OPENROUTER_BASE_URL: overrides?.baseUrl ?? value.baseUrl,
      OPENROUTER_MODEL: overrides?.model ?? value.plannerModel ?? value.model,
      ...(value.fallbackModel ? { OPENROUTER_FALLBACK_MODEL: value.fallbackModel } : {}),
      OPENROUTER_TEMPERATURE: String(value.temperature),
      ...(value.maxTokens ? { OPENROUTER_MAX_TOKENS: String(value.maxTokens) } : {}),
      OPENROUTER_API_KEY: overrides?.apiKey ?? value.apiKey,
      OPENROUTER_TIMEOUT_MS: String(overrides?.timeoutMs ?? value.timeoutMs),
      OPENROUTER_STREAM: value.streaming ? "1" : "0",
    };
  }

  async public(): Promise<PublicPanelSettings> {
    const value = await this.get();
    return {
      baseUrl: value.baseUrl,
      model: value.model,
      plannerModel: value.plannerModel,
      fallbackModel: value.fallbackModel,
      temperature: value.temperature,
      maxTokens: value.maxTokens,
      timeoutMs: value.timeoutMs,
      hasApiKey: value.apiKey.length > 0,
      apiKeyMasked: maskSecret(value.apiKey),
      useHistory: value.useHistory,
      autoMemory: value.autoMemory,
      temporarySession: value.temporarySession,
      routingMode: value.routingMode,
      providerId: value.providerId,
      streaming: value.streaming,
      syncEndpoint: value.syncEndpoint,
      hasSyncToken: value.syncToken.length > 0,
      syncTokenMasked: maskSecret(value.syncToken),
    };
  }

  static filePath(dataRoot: string): string {
    return path.join(dataRoot, "panel-settings.json");
  }
}

function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "••••••";
  return `${value.slice(0, 3)}••••••${value.slice(-3)}`;
}

const SECRET_PREFIX = "enc:v1:";
function localSecretKey(): Buffer {
  const identity = `${process.env.USERPROFILE ?? process.env.HOME ?? "unknown"}|pi-scenario-panel-settings`;
  return createHash("sha256").update(identity).digest();
}

function encryptSecret(value: string): string {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", localSecretKey(), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${body.toString("base64url")}`;
}

function decryptSecret(value: string): string {
  if (!value || !value.startsWith(SECRET_PREFIX)) return value;
  try {
    const [ivText, tagText, bodyText] = value.slice(SECRET_PREFIX.length).split(".");
    if (!ivText || !tagText || !bodyText) return "";
    const decipher = createDecipheriv("aes-256-gcm", localSecretKey(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(bodyText, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // 旧版本明文或跨机器密钥失效时，拒绝继续把不可解密内容当 API Key 使用。
    return "";
  }
}
