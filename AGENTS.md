# Typesense-MongoDB Indexer

Runtime: **Deno** (v1.42+). TypeScript single-entrypoint app. No `node_modules` — uses `npm:` and `jsr:` imports via deno.json.

## Commands

| Cmd | What |
|-----|------|
| `deno task start` | CDC mode (listen change streams) |
| `deno task rebuild` | Full rebuild of all collections |
| `deno task rebuild --collection invoices` | Rebuild single collection |
| `DEBUG=true deno task start` | Verbose debug logging |
| `deno task test` | Integration tests via `scripts/run-tests.sh` |

Raw `deno run` needs all five `--allow-*` flags (`--allow-net --allow-read --allow-env --allow-ffi --allow-sys`). Task wrappers include them.

## Testing

**Integration-only** — requires Docker. `scripts/run-tests.sh` does everything:
1. Starts `docker-compose.test.yml` (MongoDB RS, Typesense 30.2, Redis 7)
2. Copies `config.test.ts` → `config.ts`
3. Runs `deno test tests/` with all permissions
4. Restores original `config.ts` and tears down containers on exit

All tests use `sanitizeResources: false, sanitizeOps: false` (long-lived async connections). No unit tests.

## Config

- `config.ts` is gitignored — copy from `config.example.ts` or `config.test.ts`
- Exports `CONFIG: IndexerConfig` (`src/types.ts`)
- `config.test.ts` uses ports: MongoDB 27018, Typesense 8109, Redis 6380, HTTP 3132

## Architecture

```
main.ts → connectDatabases → [rebuild if --rebuild] → startCDC per collection → startHttpServer
```

- **src/core/cdc.ts**: MongoDB Change Stream → batch buffer (50 docs or 500ms) → BullMQ queue
- **src/core/rebuild.ts**: Drop Typesense collection → recreate schema → find all docs → queue batches of 500
- **src/core/reindex.ts**: Same as rebuild but filtered by date range or ObjectId range
- **src/lib/worker.ts**: BullMQ worker (global concurrency: 1) — consumes `typesense-sync`, reloading MongoDB documents on every upsert attempt
- **src/lib/http.ts**: `Deno.serve` on port 3131 — endpoints: `/health`, `/ready`, `/queue`, `/rebuild` POST, `/reindex` POST
- **src/lib/db.ts**: MongoDB connections tracked in `Map<string, MongoClient>`; checkpoints in Redis key `checkpoint:<db>:<collection>`

## Key Details

- MongoDB requires a **replica set** (Change Streams requirement)
- Resume tokens stored in Redis — if oplog window expires, must run `--rebuild`
- `transform` function in config maps MongoDB → Typesense document shape
- BullMQ default: 5 retries, exponential backoff
- Queue jobs: `upsert` (single), `upsert-bulk` (array via import), `delete` (by id)
- Upsert jobs carry original MongoDB `_id` values in `sourceIds`, encoded as canonical Extended JSON strings; transformed Typesense IDs are independent.
- Imports: `npm:mongodb@^6`, `npm:bullmq@^5`, `npm:ioredis@^5`, `npm:typesense@^1`, `jsr:@std/cli`, `jsr:@std/assert`

## Editor

VS Code: enable Deno extension, set `denoland.vscode-deno` as default formatter. See `.vscode/settings.json`.

## Docker

- Base: `denoland/deno:alpine-1.42.0`
- Entry: `CMD ["task", "start"]` — override: `docker run ... task rebuild --collection invoices`
- Mount `config.ts` at `/app/config.ts`
- Pre-built at `ghcr.io/mgyugcha/typesense-mongodb-indexer`
