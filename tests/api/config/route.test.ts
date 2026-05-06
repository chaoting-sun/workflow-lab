import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/config/route";
import { getConfig } from "@/lib/config";
import type { SlotCaps } from "@/lib/types";

describe("GET /api/config", () => {
  it("returns 200 with the public slot caps", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as SlotCaps;
    const cfg = getConfig();
    expect(body.globalCpuSlots).toBe(cfg.GLOBAL_CPU_SLOTS);
    expect(body.globalSshSlots).toBe(cfg.GLOBAL_SSH_SLOTS);
    expect(body.globalTrainingSlots).toBe(cfg.GLOBAL_TRAINING_SLOTS);
  });
});
