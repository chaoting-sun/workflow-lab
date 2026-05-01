import { z } from "zod";

export const createUserBody = z.object({
  name: z.string().trim().min(1).max(120),
});
