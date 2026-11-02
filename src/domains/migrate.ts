import { readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { ScenarioRecordSchema, type ScenarioLibrary, type ScenarioRecord } from "@/scenario/library.js";

/**
 * SceneFlow 领域场景库迁移：把 ares/metis 两仓遗留库一次性并入统一 scenarios.json。
 * - 非破坏：原数据根文件只读不动。
 * - 幂等：来源库中每条记录按 id 判重，已存在同 id 记录即跳过（含以前迁移过的）；
 *   id 冲突但内容不同（同毫秒 panel- 前缀碰撞）时换 `ares-`/`metis-` 前缀重排再入库。
 * - 旧记录是 pi schema 的子集（v2），zod default 补齐新字段，打上 domain 标。
 */

const LEGACY_SOURCES: Array<{ domain: "ares" | "metis"; file: string; domainPrefix: string }> = [
  { domain: "ares", file: path.join(homedir(), ".pi", "ares-scenario", "scenarios.json"), domainPrefix: "ares" },
  { domain: "metis", file: path.join(homedir(), ".pi", "metis-scenario", "metis-scenarios.json"), domainPrefix: "metis" },
];

export async function migrateDomainLibraries(
  library: ScenarioLibrary,
  sources: Array<{ domain: "ares" | "metis"; file: string; domainPrefix: string }> = LEGACY_SOURCES,
): Promise<{ imported: number; skipped: number; rekeyed: number }> {
  let imported = 0;
  let skipped = 0;
  let rekeyed = 0;
  for (const source of sources) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(source.file, "utf8"));
    } catch {
      continue; // 来源库不存在/损坏 → 跳过该领域（首次安装的常态）
    }
    // 遗留库存量形态：{ id: record } map 或 record[]，两种都兜住
    const entries: unknown[] = Array.isArray(raw) ? raw : Object.values((raw ?? {}) as Record<string, unknown>);
    for (const entry of entries) {
      const parsed = ScenarioRecordSchema.safeParse(entry);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const record: ScenarioRecord = { ...parsed.data, domain: source.domain };
      let id = record.id;
      const existing = await library.get(id).catch(() => undefined);
      const rekeyedId = `${source.domainPrefix}-${id}`;
      if (existing) {
        // 同 id 已在统一库中：内容相同视为已迁移；不同则是历史 id 碰撞 → 重排
        if (existing.goal === record.goal && existing.pinnedVersion === record.pinnedVersion) {
          skipped += 1;
          continue;
        }
        // 上一次迁移已用重排 id 入库（幂等）→ 跳过
        const rekeyedExisting = await library.get(rekeyedId).catch(() => undefined);
        if (rekeyedExisting && rekeyedExisting.goal === record.goal && rekeyedExisting.pinnedVersion === record.pinnedVersion) {
          skipped += 1;
          continue;
        }
        id = rekeyedId;
        rekeyed += 1;
      }
      try {
        await library.save({ ...record, id });
        imported += 1;
      } catch {
        skipped += 1;
      }
    }
  }
  if (imported > 0) console.log(`[sceneflow] 领域场景库迁移完成：新增 ${imported}，跳过 ${skipped}，重排 ${rekeyed}`);
  return { imported, skipped, rekeyed };
}

/** 迁移单元测试/校验用：来源文件清单（不读取内容） */
export function legacyDomainLibraryPaths(): Array<{ domain: string; file: string }> {
  return LEGACY_SOURCES.map(({ domain, file }) => ({ domain, file }));
}
