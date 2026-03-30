import type { Store } from "./store";
import type { VectorStore } from "./vectors/store";

export interface ReconcileOptions {
  indexName: string;
  bucket?: string;
  prefix?: string;
  keyMapper?: (vectorKey: string) => string;
  dryRun?: boolean;
}

export interface ReconcileReport {
  orphanedVectors: string[];
  orphanedObjects: string[];
  removedVectors: number;
}

export function reconcile(
  s3Store: Store,
  vectorStore: VectorStore,
  options: ReconcileOptions,
): ReconcileReport {
  const bucket = options.bucket ?? "default";
  const prefix = options.prefix ?? "";
  const keyMapper = options.keyMapper ?? ((k: string) => k);
  const dryRun = options.dryRun !== false;

  // Collect all S3 keys
  const s3Keys = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const response = s3Store.list(bucket, { prefix, maxKeys: 10000, continuationToken });
    for (const obj of response.contents ?? []) {
      s3Keys.add(obj.key);
    }
    continuationToken = response.isTruncated ? response.nextContinuationToken : undefined;
  } while (continuationToken);

  // Collect all vector keys
  const vectorKeys = new Set<string>();
  let startAfter: string | undefined;
  do {
    const response = vectorStore.listVectors(options.indexName, { maxKeys: 10000, startAfter });
    for (const key of response.keys) {
      vectorKeys.add(key);
    }
    startAfter = response.isTruncated ? response.nextStartAfter : undefined;
  } while (startAfter);

  // Find orphans
  const orphanedVectors: string[] = [];
  for (const vectorKey of vectorKeys) {
    const s3Key = keyMapper(vectorKey);
    if (!s3Keys.has(s3Key)) {
      orphanedVectors.push(vectorKey);
    }
  }

  const reverseMapper = new Map<string, string>();
  for (const vectorKey of vectorKeys) {
    reverseMapper.set(keyMapper(vectorKey), vectorKey);
  }

  const orphanedObjects: string[] = [];
  for (const s3Key of s3Keys) {
    if (!reverseMapper.has(s3Key)) {
      orphanedObjects.push(s3Key);
    }
  }

  let removedVectors = 0;
  if (!dryRun && orphanedVectors.length > 0) {
    removedVectors = vectorStore.deleteVectors(options.indexName, orphanedVectors);
  }

  return { orphanedVectors, orphanedObjects, removedVectors };
}
