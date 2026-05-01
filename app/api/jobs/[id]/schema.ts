import { z } from "zod";

export const jobIdParams = z.object({
  id: z.string().uuid(),
});
