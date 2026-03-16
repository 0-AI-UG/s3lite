# s3lite

Embedded S3-compatible storage engine with WAL-based persistence. SQLite for object storage.

The API mirrors Bun's built-in `S3Client` — swap imports and it works. Useful for local development, testing, or single-server deployments where you don't need a real S3 backend.

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

## Development

```sh
bun test           # run tests
bun run typecheck  # type-check
```

## License

MIT
