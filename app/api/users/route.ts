import { ZodError } from "zod";
import {
  badRequestFromZod,
  isUniqueViolation,
  jsonError,
  jsonOk,
} from "@/lib/api-errors";
import { createUser, listUsers } from "@/lib/users";
import { createUserBody } from "./schema";

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, "invalid JSON body");
  }

  const parsed = createUserBody.safeParse(raw);
  if (!parsed.success) return badRequestFromZod(parsed.error);

  try {
    const user = await createUser(parsed.data.name);
    return jsonOk(201, user);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return jsonError(409, "user name already exists");
    }
    if (err instanceof ZodError) return badRequestFromZod(err);
    throw err;
  }
}

export async function GET(): Promise<Response> {
  const users = await listUsers();
  return jsonOk(200, users);
}
