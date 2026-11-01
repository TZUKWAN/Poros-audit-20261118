import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { PanelSettingsSchema, PanelSettingsStore, type PanelSettings } from "@/panel/settings";

describe("面板设置敏感字段", () => {
  it("API Key 落盘加密，读取后仍可供规划器使用", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "panel-settings-"));
    try {
      const store = jsonStore<PanelSettings>({ filePath: path.join(dir, "settings.json"), schema: PanelSettingsSchema });
      const settings = new PanelSettingsStore(store, { OPENROUTER_API_KEY: "secret-key", OPENROUTER_MODEL: "m" });
      await settings.update({ model: "m2", syncToken: "sync-secret" });
      const raw = await readFile(path.join(dir, "settings.json"), "utf8");
      expect(raw).not.toContain("secret-key");
      expect(raw).not.toContain("sync-secret");
      const loaded = new PanelSettingsStore(jsonStore<PanelSettings>({ filePath: path.join(dir, "settings.json"), schema: PanelSettingsSchema }), {});
      expect((await loaded.get()).apiKey).toBe("secret-key");
      expect((await loaded.get()).syncToken).toBe("sync-secret");
      expect((await loaded.public()).syncTokenMasked).not.toContain("sync-secret");
      expect((await loaded.toPlannerEnv({ apiKey: "provider-secret" })).OPENROUTER_API_KEY).toBe("provider-secret");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
