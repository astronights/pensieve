# Pensieve

Minimal flashcards: Next.js (App Router) + Neon Postgres (drizzle) + ts-fsrs, behind a single passcode.

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
first deploy. Set `SEED_DEMO=1` in Vercel to also load the 20 demo cards (safe to leave on: it
upserts and never resets progress). If `DATABASE_URL_UNPOOLED` is set it is used for migrations.

The app connects with node-postgres (`pg`) everywhere: Neon, local Postgres and CI use the same driver.

## API

Every route requires the session cookie or `Authorization: Bearer $APP_PASSCODE`, except `/login` and `/api/login`.

| Route | |
|---|---|
| `POST /api/login` `{passcode}` | sets the httpOnly session cookie |
| `GET /api/decks` | decks with `due`, `new` (SRS: capped by the daily limit; browse: unseen) and `unseen` |
| `GET /api/next?deck=&category=&season=&exclude=` | next card: due FSRS cards first, then new cards (SRS: import order, daily cap) or a random unseen card (browse). `exclude` skips one card id; the study screen uses it to prefetch the next card |
| `POST /api/review` `{card_id, rating: 1-4}` | runs FSRS, updates `card_state`, appends `review_log`. In browse decks, Hard/Good/Easy on a non-queued card only marks it seen; Again queues it into FSRS |
| `POST /api/review` `{card_id, action: "add_to_review"}` | puts a card in the FSRS review queue (first due in 24h) |
| `POST /api/review` `{card_id, action: "bookmark", value}` | bookmark toggle |
| `POST /api/import` `[cards]` or `{decks, cards}` | upserts by id and never touches progress; max 5000 cards per request |
| `GET` / `PATCH /api/settings` (UI at `/settings`) | `daily_new_limit` (15), `desired_retention` (0.90), `timezone` (UTC) |

Card shape: `{id, deck, front, back, tags?, category?, media?: [{type: image|video|audio, url, side: front|back}], meta?: {season?, ...}}`.

Deck shape: `{id, name?, kind?: srs|browse, parent?}`. Sub-decks are one level deep: `parent` must be a
top-level deck, and a sub-deck always has its parent's `kind` (omit it to inherit). Studying a parent
draws from its own cards and all its sub-decks, its counts include theirs, and the daily new-card limit
is shared across the whole group.
Media are external URLs only. Card text is rendered as plain text (no HTML).

## Content scripts

Raw source material lives in `content/` (gitignored, never committed).

```bash
npx playwright install chromium   # once
npm run zql:scrape                # ZQL question bank → content/zql/{questions,report,sample}.json
npm run zql:scrape -- --headed    # watch the browser; --timeout <s> to wait longer
```

`report.json` describes every field (types, fill rate, values, markup and media hosts in the text) and
`sample.json` holds a representative set of full records, for planning the import mapping.

## Development

```bash
npm run lint && npm run typecheck && npm test   # unit + integration tests (in-memory PGlite, real migrations)
npm run test:e2e                                # Playwright; needs a migrated + seeded DATABASE_URL and APP_PASSCODE
npm run db:generate                             # after editing src/db/schema.ts
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, a migration drift check, tests and the build, plus an
end-to-end job against Postgres 16 with Playwright.
