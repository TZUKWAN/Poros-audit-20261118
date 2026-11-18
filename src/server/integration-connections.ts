import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { IntegrationConnection, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Principal } from "./auth.js";
import { env } from "./env.js";
import { canonicalModelBase, checkModelBase, ProviderError } from "./provider-http.js";

export const providers = ["model", "kdocs", "ima", "tinyfish"] as const;
export const providerSchema = z.enum(providers);
export type Provider = z.infer<typeof providerSchema>;
export const personalModelSource = "personal-openai-compatible:";
export const modelId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/);
const keyText = z
  .string()
  .trim()
  .min(1)
  .max(6000)
  .regex(/^[\x21-\x7e]+$/);
const credentialBody = z
  .object({
    apiKey: keyText,
    baseUrl: z.string().trim().min(1).max(300).optional(),
    model: modelId.optional(),
    clientId: keyText.optional(),
  })
  .strict();
type Owner = Pick<Principal, "organizationId" | "userId">;
export interface ModelConnection {
  baseUrl: string;
  model: string;
  apiKey: string;
}

function settingsKey(): Buffer {
  const key = process.env.POROS_SETTINGS_KEY;
  if (key && /^[0-9a-f]{64}$/i.test(key)) return Buffer.from(key, "hex");
  if (key || process.env.NODE_ENV === "production") throw new Error("Invalid POROS_SETTINGS_KEY");
  return createHash("sha256").update("poros-dev-settings:v1:").update(env.jwtSecret()).digest();
}

const address = (p: Owner, provider: Provider) => ({
  organizationId: p.organizationId,
  userId: p.userId,
  provider,
});
const aad = (row: Owner & { provider: string; revision: string }) =>
  Buffer.from(JSON.stringify([row.organizationId, row.userId, row.provider, row.revision]));
function seal(
  row: Owner & { provider: string; revision: string },
  value: { apiKey: string; clientId?: string },
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", settingsKey(), iv);
  cipher.setAAD(aad(row));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function connectionSecret(row: IntegrationConnection): {
  apiKey: string;
  clientId?: string;
} {
  try {
    const [iv, tag, data] = row.encryptedKey
      .split(".")
      .map((value) => Buffer.from(value, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", settingsKey(), iv!);
    decipher.setAAD(aad(row));
    decipher.setAuthTag(tag!);
    return JSON.parse(Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8"));
  } catch {
    throw new ProviderError("CREDENTIAL_UNREADABLE");
  }
}

export function connectionView(row: IntegrationConnection) {
  return {
    provider: row.provider,
    settings: row.settings,
    testedAt: row.testedAt,
    testCode: row.testCode,
    updatedAt: row.updatedAt,
    verified: row.testCode === "OK",
  };
}

export function findConnection(db: Prisma.TransactionClient, p: Owner, provider: Provider) {
  return db.integrationConnection.findUnique({
    where: { organizationId_userId_provider: address(p, provider) },
  });
}

export function deleteConnection(db: PrismaClient, p: Owner, provider: Provider) {
  return db.integrationConnection.deleteMany({ where: address(p, provider) });
}

export async function saveConnection(
  db: PrismaClient,
  p: Owner,
  provider: Provider,
  body: unknown,
) {
  const input = credentialBody.parse(body);
  let settings: Record<string, string> = {};
  if (provider === "model") {
    if (!input.baseUrl || !input.model || input.clientId)
      throw new ProviderError("SETTINGS_INCOMPLETE");
    const baseUrl = canonicalModelBase(input.baseUrl);
    checkModelBase(baseUrl);
    settings = { baseUrl, model: input.model };
  } else if (input.baseUrl || input.model || (provider === "ima") !== Boolean(input.clientId)) {
    throw new ProviderError("SETTINGS_INCOMPLETE");
  }
  const identity = address(p, provider),
    revision = randomUUID();
  const data = {
    revision,
    settings,
    encryptedKey: seal(
      { ...identity, revision },
      { apiKey: input.apiKey, clientId: input.clientId },
    ),
    testedAt: null,
    testCode: null,
  };
  return db.integrationConnection.upsert({
    where: { organizationId_userId_provider: identity },
    create: { ...identity, ...data },
    update: data,
  });
}

export function recordConnectionCheck(
  db: Prisma.TransactionClient,
  row: IntegrationConnection,
  code: string,
) {
  return db.integrationConnection.updateMany({
    where: {
      organizationId: row.organizationId,
      userId: row.userId,
      provider: row.provider,
      revision: row.revision,
    },
    data: { testedAt: new Date(), testCode: code },
  });
}

export function modelConnection(row: IntegrationConnection): ModelConnection {
  const parsed = z.object({ baseUrl: z.string(), model: modelId }).safeParse(row.settings);
  if (!parsed.success) throw new ProviderError("SETTINGS_INCOMPLETE");
  return { ...parsed.data, apiKey: connectionSecret(row).apiKey };
}

export async function readyPersonalModel(
  db: PrismaClient,
  p: Owner,
  pinned?: { source: string; name: string; revision?: string },
) {
  const row = await findConnection(db, p, "model");
  if (!row) return null;
  if (row.testCode !== "OK") throw new ProviderError(row.testCode || "NOT_VERIFIED");
  const model = modelConnection(row);
  if (
    pinned &&
    (pinned.source !== personalModelSource + model.baseUrl ||
      pinned.name !== model.model ||
      (pinned.revision !== undefined && pinned.revision !== row.revision))
  )
    throw new ProviderError("MODEL_BINDING_CHANGED");
  return { model, revision: row.revision };
}
