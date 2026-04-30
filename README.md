# Typesense-MongoDB Indexer

A high-performance, real-time background synchronizer that mirrors your MongoDB
collections to Typesense. Built with Deno, Redis (Valkey), BullMQ, and MongoDB
Change Streams.

## Features

- **Real-Time CDC (Change Data Capture)**: Listens to MongoDB Change Streams and
  instantly updates Typesense.
- **Bulk Rebuilds**: Rebuild your entire Typesense index from MongoDB
  efficiently using batch imports.
- **Queue System**: Built on BullMQ for resilient job processing, retries, and
  checkpointing.
- **Graceful Shutdown**: Intercepts termination signals to safely close
  connections and save checkpoints without data loss.
- **Resume Capabilities**: Remembers where it left off. If the indexer goes
  offline, it will process all missed changes when it comes back up (as long as
  they are still in MongoDB's oplog).
- **Custom Transformers**: Apply code-level transformations to your documents
  before they reach Typesense.

## Prerequisites

- [Deno](https://deno.com/) (v1.40+) OR [Docker](https://www.docker.com/)
- A MongoDB Replica Set (Change Streams require a Replica Set)
- A Valkey or Redis instance
- A Typesense server

## Quick Start (Local Deno)

1. Clone the repository.
2. Copy the example configuration:
   ```bash
   cp config.example.ts config.ts
   ```
3. Edit `config.ts` to match your infrastructure and define your collection
   mappings. The file uses the strict `IndexerConfig` type to provide
   autocomplete in modern editors.
4. Run the indexer:
   ```bash
   deno task start
   ```

## Using Docker

You can run the indexer securely isolated in a Docker container.

### 1. Build the image

```bash
docker build -t typesense-mongodb-indexer .
```

### 2. Run the container

You must mount your custom `config.ts` into the container at runtime.

```bash
docker run -d \
  --name my-indexer \
  --network host \
  -v $(pwd)/config.ts:/app/config.ts \
  typesense-mongodb-indexer
```

> Note: `--network host` is used here for simplicity if your
> database/redis/typesense are on localhost. Adjust networking as needed for
> your Docker setup.

## Commands & Usage

### Start CDC (Default)

To listen for real-time changes continuously:

```bash
deno task start
```

### Rebuild Collections

To wipe the existing Typesense collections and import all documents from
MongoDB:

```bash
deno task rebuild
```

### Rebuild a specific collection

If you only want to rebuild one specific collection (e.g., `invoices`):

```bash
deno task rebuild --collection invoices
```

### Debug Mode

If you need to inspect what data is being read from MongoDB and what payload is
sent to Typesense, run the tool with the `DEBUG` environment variable:

```bash
DEBUG=true deno task start
```

## How It Works

1. **Mapping**: In `config.ts`, you map a MongoDB collection to a Typesense
   collection. You can specify a `transform` function to clean up or structure
   your document.
2. **Workers**: The indexer pushes `upsert`, `delete`, or `upsert-bulk` jobs
   into a Redis queue. A worker consumes this queue with configurable
   concurrency, communicating with the Typesense API.
3. **Checkpoints**: Every processed change stream event generates a Resume
   Token. This is stored in Redis. On restart, the indexer requests MongoDB to
   stream changes strictly _after_ that token.

## License

MIT
