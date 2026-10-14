import { getDb } from "@/db";
import { badRequest } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
import { getSettings, updateSettings } from "@/lib/settings";

export async function GET() {
  return handle(async () => getSettings(getDb()));
}

export async function PATCH(req: Request) {
  return handle(async () => {
    const body = await readJson(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw badRequest("Expected a JSON object of settings");
    }
    return updateSettings(getDb(), body as Record<string, unknown>);
  });
}
