# s3lite

Embedded S3-compatible storage engine with WAL-based persistence. SQLite for object storage.

The API mirrors Bun's built-in `S3Client` — swap imports and it works. Useful for local development, testing, or single-server deployments where you don't need a real S3 backend.

Also includes **s3lite-vectors** — an embedded vector store with HNSW indexing, sparse vectors, hybrid search with RRF fusion, and metadata filtering. Think of it as SQLite for vector search.

## Install

```sh
bun add s3lite
```

## Usage

```ts
import { S3Client } from "s3lite";

// In-memory only
const s3 = new S3Client({ bucket: "my-bucket" });

// With disk persistence
const s3 = new S3Client({ bucket: "my-bucket", path: "./data.s3db" });
```

### Read & Write

```ts
// Write
await s3.write("hello.txt", "Hello World", { type: "text/plain" });

// Read via S3File
const file = s3.file("hello.txt");
await file.text();      // "Hello World"
await file.json();      // parsed JSON
await file.bytes();     // Uint8Array
await file.arrayBuffer();
file.stream();          // ReadableStream

// Streaming write
const writer = s3.file("big.bin").writer();
writer.write(chunk1);
writer.write(chunk2);
await writer.end();
```

### List & Delete

```ts
const result = await s3.list({ prefix: "photos/" });
// result.contents → [{ key, size, lastModified, eTag }]

await s3.delete("hello.txt");
await s3.exists("hello.txt"); // false
```

### Stat

```ts
const stat = await s3.stat("hello.txt");
// { size, lastModified, etag, type }
```

### Presigned URLs

s3lite doesn't talk to a remote service, so presigned URLs work differently from real S3. Instead of generating signed AWS URLs, you use `PresignHandler` — a standalone request handler you mount on your HTTP server.

```ts
import { S3Client, PresignHandler } from "s3lite";

const s3 = new S3Client({ bucket: "my-bucket", path: "./data.s3db" });

const presign = new PresignHandler(s3, {
  baseUrl: "http://localhost:3000/api/s3",
  corsHeaders: { "Access-Control-Allow-Origin": "*" },
});

// Generate a presigned download URL
const downloadUrl = presign.presign("photos/cat.jpg", { expiresIn: 900 });
// → "http://localhost:3000/api/s3/<token>"

// Generate a presigned upload URL
const uploadUrl = presign.presign("uploads/file.bin", {
  method: "PUT",
  expiresIn: 900,
});
```

Then mount the handler on your server as a catch-all route:

```ts
// Bun.serve example
Bun.serve({
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/s3/")) {
      return presign.handleRequest(req);
    }
    return new Response("Not Found", { status: 404 });
  },
});
```

### Cleanup

```ts
s3.close();        // flush WAL and close database
s3.checkpoint();   // manual WAL checkpoint without closing
```

## Bun S3 Compatibility

s3lite implements the same interface as Bun's built-in `S3Client`. To switch between them:

```ts
// Local development
import { S3Client } from "s3lite";
const s3 = new S3Client({ bucket: "app", path: "./data.s3db" });

// Production (Bun's built-in S3)
import { S3Client } from "bun";
const s3 = new S3Client({ bucket: "app", accessKeyId: "...", secretAccessKey: "..." });
```

The one exception is `presign()` — on a real S3 client it returns signed AWS URLs directly. With s3lite, use `PresignHandler` to serve the files through your own server.

## Vectors

s3lite includes a built-in vector store for similarity search. Import from `@0-ai/s3lite/vectors`.

```ts
import { VectorClient } from "@0-ai/s3lite/vectors";

// In-memory (all vectors in RAM)
const vectors = new VectorClient();

// With disk persistence (vectors in RAM, WAL on disk)
const vectors = new VectorClient({ path: "./vectors.db" });

// Disk-backed storage (vectors stored on disk, only graph structure in RAM)
const vectors = new VectorClient({
  path: "./vectors.db",
  storage: "disk",
  diskCacheSize: 10_000, // LRU cache size (default: 10,000 vectors)
});
```

The default `"memory"` storage keeps all vector data in RAM — fast, but limited by available memory. With `"disk"` storage, vector float data is stored on disk using s3lite's own S3 storage engine, while only the HNSW graph structure and norms stay in memory. This reduces memory usage by ~95%, allowing you to handle 10-100x more vectors on the same machine. An LRU cache keeps frequently accessed vectors hot.

### Create an Index

```ts
vectors.createIndex({
  name: "movies",
  dimension: 1536,
  distanceMetric: "cosine", // "cosine" | "euclidean" | "dotproduct"
  hnswConfig: { M: 16, efConstruction: 200 },
});
```

### Insert Vectors

```ts
vectors.putVectors("movies", [
  { key: "star-wars", vector: [0.1, 0.2, ...], metadata: { genre: "scifi", year: 1977 } },
  { key: "titanic", vector: [0.3, 0.4, ...], metadata: { genre: "drama", year: 1997 } },
]);
```

### Query

```ts
const { results } = vectors.query("movies", {
  vector: [0.1, 0.2, ...],
  topK: 10,
  efSearch: 100,
  includeMetadata: true,
  filter: { genre: "scifi" },
});
// results → [{ key: "star-wars", score: 0.98, metadata: { ... } }, ...]
```

### Metadata Filtering

Filters support comparison operators:

```ts
vectors.query("movies", {
  vector: queryVec,
  topK: 5,
  filter: {
    genre: { $in: ["scifi", "action"] },
    year: { $gte: 1990 },
  },
});
```

Available operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`.

### Sparse & Hybrid Search

Create a sparse-enabled index and use RRF (Reciprocal Rank Fusion) to combine dense + sparse results:

```ts
vectors.createIndex({ name: "docs", dimension: 768, sparse: true });

vectors.putVectors("docs", [
  {
    key: "doc1",
    vector: denseVec,
    sparseVector: { indices: [10, 42, 99], values: [0.5, 0.3, 0.8] },
  },
]);

// Hybrid query (dense + sparse with RRF fusion)
const { results } = vectors.query("docs", {
  vector: queryDense,
  sparseVector: { indices: [42, 99], values: [0.4, 0.7] },
  topK: 10,
  fusionK: 60,
});
```

### Manage Vectors & Indexes

```ts
// Get vectors by key
const vecs = vectors.getVectors("movies", ["star-wars", "titanic"]);

// List vector keys
const { keys } = vectors.listVectors("movies", { prefix: "star", maxKeys: 100 });

// Delete vectors
vectors.deleteVectors("movies", ["titanic"]);

// List all indexes
const { indexes } = vectors.listIndexes();

// Delete an index
vectors.deleteIndex("movies");
```

### Events

```ts
vectors.on("putVectors", (indexName, keys) => {
  console.log(`Upserted ${keys?.length} vectors in ${indexName}`);
});
// Events: "putVectors" | "deleteVectors" | "createIndex" | "deleteIndex"
```

### Cleanup

```ts
vectors.checkpoint(); // flush WAL
vectors.close();      // flush and close
```

## Development

```sh
bun test           # run tests
bun run typecheck  # type-check
```

## License

MIT
