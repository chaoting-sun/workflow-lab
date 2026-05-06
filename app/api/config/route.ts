import { jsonOk } from "@/lib/api-errors";
import { getConfig } from "@/lib/config";
import type { SlotCaps } from "@/lib/types";

// Public, non-secret slot caps for the dashboard fairness panel.
export async function GET(): Promise<Response> {
  const cfg = getConfig();
  const body: SlotCaps = {
    globalCpuSlots: cfg.GLOBAL_CPU_SLOTS,
    globalSshSlots: cfg.GLOBAL_SSH_SLOTS,
    globalTrainingSlots: cfg.GLOBAL_TRAINING_SLOTS,
  };
  return jsonOk(200, body);
}
