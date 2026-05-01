import { badRequestFromZod, jsonError, jsonOk } from "@/lib/api-errors";
import { getConfig } from "@/lib/config";
import {
  createJob,
  listJobs,
  InvalidPipelinesCountError,
  UserNotFoundError,
} from "@/lib/jobs";
import { createJobBody, listJobsQuery } from "./schema";

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, "invalid JSON body");
  }

  const parsed = createJobBody.safeParse(raw);
  if (!parsed.success) return badRequestFromZod(parsed.error);

  // Snapshot PIPELINES_PER_JOB at request time. Boot-time config validation
  // already enforces the 1..1000 range; the explicit check here surfaces a
  // 400 instead of a 500 if the bound is ever loosened.
  const pipelinesCount = getConfig().PIPELINES_PER_JOB;

  try {
    const result = await createJob({
      userId: parsed.data.userId,
      pipelinesCount,
    });
    return jsonOk(201, result);
  } catch (err) {
    if (err instanceof UserNotFoundError) {
      return jsonError(404, "user not found");
    }
    if (err instanceof InvalidPipelinesCountError) {
      return jsonError(400, err.message);
    }
    throw err;
  }
}

export async function GET(req: Request): Promise<Response> {
  const userId = new URL(req.url).searchParams.get("userId") ?? undefined;
  const parsed = listJobsQuery.safeParse({ userId });
  if (!parsed.success) return badRequestFromZod(parsed.error);

  const jobs = await listJobs(parsed.data);
  return jsonOk(200, jobs);
}
