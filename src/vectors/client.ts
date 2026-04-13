import type {
  VectorClientOptions,
  VectorIndexConfig,
  CreateIndexOptions,
  PutVectorInput,
  GetVectorResponse,
  QueryOptions,
  QueryResponse,
  ListVectorsOptions,
  ListVectorsResponse,
  ListIndexesResponse,
  VectorEventType,
  VectorEventCallback,
} from "./types";
import { VectorStore } from "./store";

export class VectorClient {
  private store: VectorStore;

  constructor(options?: VectorClientOptions) {
    this.store = new VectorStore(options?.path, options?.syncMode, options?.readonly, options?.storage, options?.diskCacheSize);
  }

  createIndex(opts: CreateIndexOptions): VectorIndexConfig {
    return this.store.createIndex(opts);
  }

  getIndex(name: string): VectorIndexConfig | undefined {
    return this.store.getIndex(name);
  }

  deleteIndex(name: string): boolean {
    return this.store.deleteIndex(name);
  }

  listIndexes(): ListIndexesResponse {
    return this.store.listIndexes();
  }

  putVectors(indexName: string, inputs: PutVectorInput[]): void {
    this.store.putVectors(indexName, inputs);
  }

  getVectors(indexName: string, keys: string[]): GetVectorResponse[] {
    return this.store.getVectors(indexName, keys);
  }

  deleteVectors(indexName: string, keys: string[]): number {
    return this.store.deleteVectors(indexName, keys);
  }

  listVectors(indexName: string, opts?: ListVectorsOptions): ListVectorsResponse {
    return this.store.listVectors(indexName, opts);
  }

  query(indexName: string, opts: QueryOptions): QueryResponse {
    return this.store.query(indexName, opts);
  }

  on(event: VectorEventType, callback: VectorEventCallback): void {
    this.store.on(event, callback);
  }

  off(event: VectorEventType, callback: VectorEventCallback): void {
    this.store.off(event, callback);
  }

  checkpoint(): void {
    this.store.checkpoint();
  }

  close(): void {
    this.store.close();
  }
}
