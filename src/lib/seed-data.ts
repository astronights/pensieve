import type { ImportPayload } from "./import";

// Public, stable sample media. One URL is intentionally broken to exercise the fallback.
const IMG_DOG = "https://picsum.photos/id/237/480/320";
const IMG_MOUNTAIN = "https://picsum.photos/id/29/480/320";
const VIDEO = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
const AUDIO = "https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3";
const BROKEN = "https://example.invalid/missing.jpg";

export const SEED: ImportPayload = {
  decks: [
    { id: "demo-spanish", name: "Spanish (demo)", kind: "srs", parent: null },
    { id: "demo-spanish-basics", name: "Basics", parent: "demo-spanish" },
    { id: "demo-spanish-media", name: "With media", parent: "demo-spanish" },
    { id: "demo-trivia", name: "Trivia (demo)", kind: "browse", parent: null },
  ],
  cards: [
    ...(
      [
        ["hola", "hello"],
        ["gracias", "thank you"],
        ["perro", "dog", [{ type: "image", url: IMG_DOG, side: "back" }]],
        ["montaña", "mountain", [{ type: "image", url: IMG_MOUNTAIN, side: "front" }]],
        ["flor", "flower", [{ type: "video", url: VIDEO, side: "back" }]],
        ["rugido", "roar", [{ type: "audio", url: AUDIO, side: "front" }]],
        ["gato", "cat", [{ type: "image", url: BROKEN, side: "front" }]],
        ["agua", "water"],
        ["libro", "book"],
        ["casa", "house"],
        ["comer", "to eat"],
        ["dormir", "to sleep"],
      ] as const
    ).map(([front, back, media], i) => ({
      id: `demo:es:${String(i + 1).padStart(2, "0")}`,
      deck: media ? "demo-spanish-media" : "demo-spanish-basics",
      front,
      back,
      tags: ["demo", "spanish"],
      category: "vocab",
      media: media ? [...media] : [],
      meta: null,
    })),
    ...(
      [
        ["Which planet is known as the Red Planet?", "Mars", "science", "S1", []],
        ["What is the chemical symbol for gold?", "Au", "science", "S1", []],
        ["Who painted the Mona Lisa?", "Leonardo da Vinci", "art", "S1", []],
        ["What animal is this?", "A dog", "animals", "S2", [{ type: "image", url: IMG_DOG, side: "front" }]],
        ["What flower is in this clip?", "A daisy-like flower", "nature", "S2", [{ type: "video", url: VIDEO, side: "front" }]],
        ["Which dinosaur makes this sound (in the sample)?", "T. rex", "animals", "S2", [{ type: "audio", url: AUDIO, side: "front" }]],
        ["What is the largest ocean?", "Pacific", "geography", "S1", []],
        ["How many sides does a hexagon have?", "Six", "math", "S2", []],
      ] as const
    ).map(([front, back, category, season, media], i) => ({
      id: `demo:trivia:S${season.slice(1)}:${i + 1}`,
      deck: "demo-trivia",
      front,
      back,
      tags: ["demo"],
      category,
      media: [...media],
      meta: { season },
    })),
  ],
};
