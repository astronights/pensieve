# Pensieve

Minimal flashcards: Next.js (App Router) + Neon Postgres (drizzle), behind a single passcode.

## How studying works

Two answers, no daily limit:

- **Again**: the card comes back after 5 other cards, and its count of Goods in a row resets to 0.
- **Good**: the card comes back after 15 cards, then 30 (the gap doubles each time). The third Good
  in a row marks it **learned**, and it isn't shown again.
- **Missed cards** (Again at any point) aren't learned yet after those 3 Goods: they come back every
  50 cards and need 3 more Goods in a row first. Again during that review keeps them there (back
  after 50 cards) and the 3 review Goods start again.

Cards are placed by how many answers ago they came up, not by time, so you can study as many
cards in a sitting as you like. Each turn shows the card being learned whose turn has come, else
the next new card, else the next card being learned (early). The numbers are in Settings.

Browse decks show unseen cards in random order: **Next** just marks a card seen, and **Again**
puts it into the Again/Good loop above.

## Setup (Vercel CLI, no Git integration)

```bash
npm i -g vercel@latest
vercel login
vercel link                      # create project "pensieve"; don't connect a Git repo
vercel integration add neon      # Marketplace Neon DB → injects DATABASE_URL
vercel env add APP_PASSCODE production   # repeat for preview / development
vercel env pull .env.local

npm install
npm run db:migrate               # apply ./drizzle migrations
npm run seed                     # 20 demo cards (idempotent)
npm run dev
vercel --prod                    # deploy
```

### Migrations on deploy

Vercel runs the `vercel-build` script, which applies any pending migrations in `./drizzle`
(`npm run db:deploy`) and then runs `next build`, so a fresh Neon database gets its tables on the
first deploy. Set `SEED_DEMO=1` to also load the 20 demo cards (CI does this for the end-to-end tests).
Migration `0003_remove_demo` deleted the demo decks from existing databases. If `DATABASE_URL_UNPOOLED` is set it is used for migrations.

The app connects with node-postgres (`pg`) everywhere: Neon, local Postgres and CI use the same driver.

## Install on a phone

Pensieve is an installable web app (PWA). On Android, open it in Chrome and tap **Install app** in
Settings, or use Chrome's **⋮ → Add to Home screen**. It then opens full screen from its own icon and
stays logged in (the session lasts a year). The manifest (`src/app/manifest.ts`) and icons
(`public/`, drawn from `public/icon.svg`) are served without the passcode so the browser can read them.

## API

Every route requires the session cookie or `Authorization: Bearer $APP_PASSCODE`, except `/login` and `/api/login`.

| Route | |
|---|---|
| `POST /api/login` `{passcode}` | sets the httpOnly session cookie |
| `GET /api/decks` | decks with `learning`, `new` (never seen), `learned` and `total` card counts |
| `GET /api/next?deck=&category=&season=&exclude=` | next card (see above) plus `outcomes`: what Again and Good would do. `exclude` skips one card id; the study screen uses it to prefetch the next card |
| `POST /api/review` `{card_id, answer: "again" \| "good"}` | updates `card_state` and appends `review_log` (browse: Good on a card not being learned only marks it seen) |
| `POST /api/review` `{card_id, action: "bookmark", value}` | bookmark toggle |
| `POST /api/import` `[cards]` or `{decks, cards}` | upserts by id and never touches progress; max 5000 cards per request |
| `GET` / `PATCH /api/settings` (UI at `/settings`) | `again_gap` (5), `good_gap` (15), `learned_after` (3), `review_gap` (50) |

Card shape: `{id, deck, front, back, tags?, category?, media?: [{type: image|video|audio, url, side: front|back}], meta?: {season?, ...}}`.

Deck shape: `{id, name?, kind?: srs|browse, parent?}`. Sub-decks are one level deep: `parent` must be a
top-level deck, and a sub-deck always has its parent's `kind` (omit it to inherit). Studying a parent
draws from its own cards and all its sub-decks, and its counts include theirs.
Media are external URLs only. Card text (`front`, `back`) is **Markdown** (bold, italics, lists, links;
raw HTML is never rendered). Optional extras in `meta` enrich the back of a card: `notes` (marking
guidance, shown small under the answer), `explanation`, and `info` (`[{label, value}]` lines in the
footer, shown with the category). `meta.raw` can hold the untouched source record; it is stored but
never sent to the browser. `tags` are shown under the question.

## Content scripts

Raw source material lives in `content/` (gitignored, never committed).

```bash
npx playwright install chromium   # once
npm run zql:scrape                # ZQL question bank → content/zql/{questions,report,sample}.json
npm run zql:scrape -- --headed    # watch the browser; --timeout <s> to wait longer
```

`report.json` describes every field (types, fill rate, values, markup and media hosts in the text) and
`sample.json` holds a representative set of full records, for planning the import mapping.

```bash
npm run zql:convert                                   # dry run → content/zql/cards.json + convert-report.json
npm run zql:convert -- --upload --url https://<app>   # import (passcode from APP_PASSCODE or --passcode)
```

ZQL questions go into a **ZQL** deck (Seasons 1–7) and a **Cultish** deck (Season 0 = CQL S1, Season 1),
type `srs`, with ids like `zql:S01:GW08a:R3:P2:Q1` (sorted in game order). The question and its
`imageurl` (plus any video/audio in it) are the front; the answer is split into answer, `notes`
("Accept: …", "Prompt: …") and `explanation` (after the first `;`), with answer images on the back.
Topic, source and qid are shown in the back footer; everything, including the raw record, is kept in
`meta`. Re-running the import only updates content; progress is never reset.

## Development

```bash
npm run lint && npm run typecheck && npm test   # unit + integration tests (in-memory PGlite, real migrations)
npm run test:e2e                                # Playwright; needs a migrated + seeded DATABASE_URL and APP_PASSCODE
npm run db:generate                             # after editing src/db/schema.ts
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, a migration drift check, tests and the build, plus an
end-to-end job against Postgres 16 with Playwright.
