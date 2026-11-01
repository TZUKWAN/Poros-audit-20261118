import { describe, expect, it } from "vitest";
import { PanelServer } from "@/panel/server";

describe("PanelServer 生命周期", () => {
  it("未启动时 stop 是幂等的，不会悬挂宿主退出", async () => {
    await expect(new PanelServer().stop()).resolves.toBeUndefined();
  });
});
