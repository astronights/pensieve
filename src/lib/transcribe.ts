import { HttpError, badRequest } from "./errors";

/**
 * Server-side speech-to-text with Gemini 3.5 Transcribe (Interactions API), for voice study on
 * phones where Chrome's own recogniser keeps restarting. Needs GEMINI_API_KEY.
 */
export const GEMINI_MODEL = "gemini-3.5-transcribe";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

/** Clips are a few seconds of 16 kHz WAV; this is about a minute, far more than an answer needs. */
const MAX_AUDIO_BYTES = 2_000_000;
const MIME_TYPES = new Set(["audio/wav", "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"]);
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export type TranscribeInput = { audio: string; mime_type: string; languages: string[] };

export const geminiConfigured = () => !!process.env.GEMINI_API_KEY;

export function parseTranscribeInput(body: unknown): TranscribeInput {
  if (!body || typeof body !== "object") throw badRequest("Expected a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.audio !== "string" || !b.audio) throw badRequest("audio (base64) is required");
  if (b.audio.length > (MAX_AUDIO_BYTES * 4) / 3) throw badRequest("audio is too long");
  const mime = typeof b.mime_type === "string" ? b.mime_type.split(";")[0] : "audio/wav";
  if (!MIME_TYPES.has(mime)) throw badRequest(`Unsupported audio type: ${mime}`);
  const languages = Array.isArray(b.languages)
    ? b.languages.filter((l): l is string => typeof l === "string" && LANG.test(l)).slice(0, 4)
    : [];
  return { audio: b.audio, mime_type: mime, languages };
}

/** The Interactions request: verbatim (no rewording of what was said), not stored by Google. */
export function geminiRequest({ audio, mime_type, languages }: TranscribeInput) {
  return {
    model: GEMINI_MODEL,
    input: [{ type: "audio", data: audio, mime_type }],
    generation_config: {
      transcription_config: {
        mode: { type: "verbatim" },
        ...(languages.length ? { language_codes: languages } : {}),
      },
    },
    store: false,
  };
}

type Step = { type?: string; content?: { type?: string; text?: string }[] };

/** The transcript: text from the model's output steps (or `output_text` if that's all there is). */
export function transcriptFrom(response: unknown): string {
  const r = (response ?? {}) as { steps?: Step[]; output_text?: string };
  const text = (r.steps ?? [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join(" ");
  return (text || r.output_text || "").replace(/\s+/g, " ").trim();
}

export async function transcribe(input: TranscribeInput, fetchImpl: typeof fetch = fetch): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new HttpError(503, "Gemini isn't set up: add GEMINI_API_KEY to the app's environment.");
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(geminiRequest(input)),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    // Don't pass Google's status through: a 401/403 from Gemini isn't the user's session failing.
    throw new HttpError(502, `Gemini transcription failed: ${message}`);
  }
  return transcriptFrom(body);
}
