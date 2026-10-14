import { getDb } from "@/db";
import { handle, readJson } from "@/lib/http";
import { applyReview, parseReviewInput } from "@/lib/review";

export async function POST(req: Request) {
  return handle(async () => applyReview(getDb(), parseReviewInput(await readJson(req))));
}
