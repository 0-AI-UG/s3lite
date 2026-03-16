import type { S3Client } from "./client";
import type { S3FilePresignOptions } from "./types";

interface TokenEntry {
  bucket: string;
  key: string;
  method: string;
  expiresIn: number;
  expires: number;
  contentDisposition?: string;
}

export interface PresignHandlerOptions {
  baseUrl: string;
  corsHeaders?: Record<string, string>;
}

export class PresignHandler {
  private client: S3Client;
  private baseUrl: string;
  private corsHeaders: Record<string, string>;
  private tokens = new Map<string, TokenEntry>();

  constructor(client: S3Client, options: PresignHandlerOptions) {
    this.client = client;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.corsHeaders = options.corsHeaders ?? {};
  }

  presign(
    path: string,
    options?: S3FilePresignOptions & { bucket?: string },
  ): string {
    const bucket = options?.bucket ?? this.client.defaultBucket;
    const method = options?.method ?? "GET";
    const expiresIn = options?.expiresIn ?? 86400;
    const token = crypto.randomUUID();
    this.tokens.set(token, {
      bucket,
      key: path,
      method,
      expiresIn,
      expires: Date.now() + expiresIn * 1000,
      contentDisposition: options?.contentDisposition,
    });

    return `${this.baseUrl}/${token}`;
  }

  async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const token = url.pathname.split("/").pop();
    if (!token) {
      return new Response("Missing token", {
        status: 401,
        headers: this.corsHeaders,
      });
    }

    const entry = this.tokens.get(token);
    if (!entry) {
      return new Response("Invalid token", {
        status: 401,
        headers: this.corsHeaders,
      });
    }

    if (Date.now() > entry.expires) {
      this.tokens.delete(token);
      return new Response("Token expired", {
        status: 401,
        headers: this.corsHeaders,
      });
    }

    if (req.method !== entry.method) {
      return new Response(`Method not allowed. Expected ${entry.method}`, {
        status: 405,
        headers: this.corsHeaders,
      });
    }

    if (req.method === "GET") {
      const file = this.client.file(entry.key, { bucket: entry.bucket });
      if (!(await file.exists())) {
        return new Response("Not Found", {
          status: 404,
          headers: this.corsHeaders,
        });
      }

      const data = await file.arrayBuffer();
      const stat = await file.stat();
      const headers: Record<string, string> = {
        ...this.corsHeaders,
        "Content-Type": stat.type,
        "Content-Length": String(stat.size),
        ETag: stat.etag,
      };
      if (entry.contentDisposition) {
        headers["Content-Disposition"] = entry.contentDisposition;
      }
      return new Response(data, { headers });
    }

    if (req.method === "PUT") {
      const body = await req.arrayBuffer();
      const contentType =
        req.headers.get("Content-Type") ?? "application/octet-stream";
      const file = this.client.file(entry.key, { bucket: entry.bucket });
      await file.write(new Uint8Array(body), { type: contentType });
      return new Response("OK", { status: 200, headers: this.corsHeaders });
    }

    return new Response("Method not supported", {
      status: 405,
      headers: this.corsHeaders,
    });
  }

  stop(): void {
    this.tokens.clear();
  }
}
