import { badRequestFromZod, jsonError, jsonOk } from "@/lib/api-errors";
import { getJob } from "@/lib/jobs";
import { jobIdParams } from "./schema";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  const params = await ctx.params;
  const parsed = jobIdParams.safeParse(params);
  if (!parsed.success) return badRequestFromZod(parsed.error);

  const job = await getJob(parsed.data.id);
  if (!job) return jsonError(404, "job not found");
  return jsonOk(200, job);
}
