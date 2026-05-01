import { z } from "zod";

export const createJobBody = z.object({
  userId: z.string().uuid(),
});

export const listJobsQuery = z.object({
  userId: z.string().uuid().optional(),
});
