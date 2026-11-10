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

## Docker

### Build the image locally

```bash
docker build -t typesense-mongodb-indexer .
```

### Pull the image from GHCR

Pre-built images are available via GitHub Container Registry:

```bash
docker pull ghcr.io/mgyugcha/typesense-mongodb-indexer:latest
```

### Run the container

Mount your custom `config.ts` into the container at runtime:

```bash
docker run -d \
  --name my-indexer \
  --network host \
  -v $(pwd)/config.ts:/app/config.ts \
  ghcr.io/mgyugcha/typesense-mongodb-indexer
```

> Note: `--network host` is used here for simplicity if your
> database/redis/typesense are on localhost. Adjust networking as needed for
> your Docker setup.

### Override the default command

To run a one-off command instead (e.g., rebuild), pass it as the last argument:

```bash
docker run --rm \
  -v $(pwd)/config.ts:/app/config.ts \
  ghcr.io/mgyugcha/typesense-mongodb-indexer \
  task rebuild
```

## Manual Build with GitHub Actions

You can manually build and publish the Docker image to your GitHub Container
Registry using the project's GitHub Actions workflow.

1. Go to your repository on GitHub.
2. Click the **Actions** tab.
3. Select the **Build and Publish** workflow.
4. Click **Run workflow**.
5. Optionally enter a tag (e.g., `v1.0.0`) and click **Run workflow**.

The workflow will build the image and push it to
`ghcr.io/<your-username>/typesense-mongodb-indexer`.

## Kubernetes Deployment

### Prerequisites

- A Kubernetes cluster (minikube, kind, or a cloud provider).
- `kubectl` configured to communicate with your cluster.
- The image published to GHCR (see [Manual Build](#manual-build-with-github-actions) above).

### 1. Create the ConfigMap

Create a ConfigMap from your `config.ts` file:

```bash
kubectl create configmap indexer-config --from-file=config.ts=./config.ts
```

All pods will mount this file at `/app/config.ts`.

### 2. Deployment — CDC (continuous mode)

The following Deployment runs the indexer in real-time CDC mode:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: typesense-indexer
spec:
  replicas: 1
  selector:
    matchLabels:
      app: typesense-indexer
  template:
    metadata:
      labels:
        app: typesense-indexer
    spec:
      containers:
        - name: indexer
          image: ghcr.io/mgyugcha/typesense-mongodb-indexer:latest
          args: ["task", "start"]
          volumeMounts:
            - name: config
              mountPath: /app/config.ts
              subPath: config.ts
          env:
            - name: DEBUG
              value: "false"
      volumes:
        - name: config
          configMap:
            name: indexer-config
```

Apply it:

```bash
kubectl apply -f deployment.yaml
```

### 3. Job — Rebuild (one-off)

To rebuild all Typesense collections from MongoDB, run a one-off Job:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: typesense-indexer-rebuild
spec:
  template:
    spec:
      containers:
        - name: indexer
          image: ghcr.io/mgyugcha/typesense-mongodb-indexer:latest
          args: ["task", "rebuild"]
          volumeMounts:
            - name: config
              mountPath: /app/config.ts
              subPath: config.ts
      restartPolicy: Never
      volumes:
        - name: config
          configMap:
            name: indexer-config
  backoffLimit: 2
```

Apply it:

```bash
kubectl apply -f job.yaml
```

The Job will exit once the rebuild completes successfully.

### 4. Rebuild a specific collection

Pass the `--collection` flag via `args` to rebuild only one collection:

```yaml
args: ["task", "rebuild", "--collection", "invoices"]
```

Or use the raw `deno run` command:

```yaml
args:
  - run
  - --allow-net
  - --allow-read
  - --allow-env
  - --allow-ffi
  - --allow-sys
  - src/main.ts
  - --rebuild
  - --collection
  - invoices
```

### Quick reference

| Action      | Command                                                   |
| ----------- | --------------------------------------------------------- |
| Deploy CDC  | `kubectl apply -f deployment.yaml`                        |
| Scale down  | `kubectl scale deployment typesense-indexer --replicas=0` |
| View logs   | `kubectl logs -l app=typesense-indexer`                   |
| Run rebuild | `kubectl apply -f job.yaml`                               |
| Delete job  | `kubectl delete job typesense-indexer-rebuild`            |

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
