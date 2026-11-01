import { z } from "zod";
import type { Store } from "@/core/store.js";

export const PanelMessageSchema = z.record(z.string(), z.unknown());
export const PanelSessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  mode: z.enum(["work", "build"]),
  /** The project context that was active when this conversation was last saved. */
  // Optional keeps old records distinguishable during migration.  New
  // sessions always write an explicit null when no project is selected.
  projectId: z.string().nullable().optional(),
  activeScenarioId: z.string().nullable().default(null),
  archived: z.boolean().default(false),
  messages: z.array(PanelMessageSchema).max(500),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PanelSession = z.infer<typeof PanelSessionSchema>;

function inferredTitle(session: PanelSession): string {
  if (session.title !== "新对话") return normalizeTitle(session.title);
  const firstUser = session.messages.find((message) => message.role === "user" && typeof message.content === "string");
  const content = typeof firstUser?.content === "string" ? firstUser.content.trim().replace(/\s+/g, " ") : "";
  if (!content || content.startsWith("/")) return session.title;
  return normalizeTitle(content.slice(0, 36));
}

function normalizeTitle(title: string): string {
  const value = title.trim();
  if (/^(?:你敢|你好|嗨|hi|hello|test|测试|嗯|好的?)$/iu.test(value)) return "新任务";
  return value || "新对话";
}

export interface PanelSessionSummary {
  id: string;
  title: string;
  mode: "work" | "build";
  projectId: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export class PanelHistory {
  constructor(private readonly store: Store<PanelSession>) {}

  async create(mode: "work" | "build" = "work", title = "新对话", projectId: string | null = null): Promise<PanelSession> {
    const now = new Date().toISOString();
    const session: PanelSession = { id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title, mode, projectId, activeScenarioId: null, archived: false, messages: [], createdAt: now, updatedAt: now };
    await this.store.set(session.id, session);
    return session;
  }

  async get(id: string): Promise<PanelSession | undefined> {
    const value = await this.store.get(id);
    if (!value) return undefined;
    const session = PanelSessionSchema.parse(value);
    const title = inferredTitle(session);
    if (title !== session.title) {
      session.title = title;
      await this.store.set(id, session);
    }
    return session;
  }

  async save(session: PanelSession): Promise<void> {
    await this.store.set(session.id, PanelSessionSchema.parse(session));
  }

  async list(limit = 40): Promise<PanelSessionSummary[]> {
    const entries = await this.store.entries();
    return entries
      .map(([, raw]) => PanelSessionSchema.parse(raw))
      .map((session) => ({ id: session.id, title: inferredTitle(session), mode: session.mode, projectId: session.projectId ?? null, messageCount: session.messages.length, createdAt: session.createdAt, updatedAt: session.updatedAt, archived: session.archived }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async latest(): Promise<PanelSession | undefined> {
    const entries = await this.store.entries();
    const active = entries
      .map(([, raw]) => PanelSessionSchema.parse(raw))
      .filter((session) => !session.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const latest = active[0];
    if (!latest) return undefined;
    const title = inferredTitle(latest);
    if (title !== latest.title) {
      latest.title = title;
      await this.store.set(latest.id, latest);
    }
    return latest;
  }

  async setArchived(id: string, archived: boolean): Promise<PanelSession | undefined> {
    const session = await this.get(id);
    if (!session) return undefined;
    session.archived = archived;
    session.updatedAt = new Date().toISOString();
    await this.save(session);
    return session;
  }

  async delete(id: string): Promise<boolean> {
    return await this.store.delete(id);
  }
}
