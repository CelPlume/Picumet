// 存储 Provider 抽象接口
import type { StorageProvider } from '@shared/types';

export interface HeadResult {
  size: number;
  etag?: string;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface ListEntry {
  key: string;
  size: number;
  etag?: string;
}

export interface ListResult {
  keys: ListEntry[];
  truncated: boolean;
  continuationToken?: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface ObjectBody {
  size: number;
  etag?: string;
  contentType?: string;
  body: ReadableStream<Uint8Array>;
  metadata?: Record<string, string>;
}

export interface StorageProviderInterface {
  readonly type: string;
  readonly name: string;
  readonly bucketName: string;

  putObject(key: string, body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>, contentType?: string, metadata?: Record<string, string>): Promise<{ etag?: string }>;
  getObject(key: string): Promise<ObjectBody | null>;
  headObject(key: string): Promise<HeadResult | null>;
  deleteObject(key: string): Promise<void>;
  listObjects(prefix: string, opts?: { limit?: number; continuationToken?: string }): Promise<ListResult>;
  copyObject(sourceKey: string, targetKey: string): Promise<{ etag?: string }>;
  // Multipart
  createMultipartUpload(key: string, contentType?: string): Promise<{ uploadId: string }>;
  uploadPart(key: string, uploadId: string, partNumber: number, body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>): Promise<{ etag: string }>;
  completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<{ etag?: string }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  // URL
  getUploadUrl(key: string, contentType?: string, expiresInSeconds?: number): Promise<string | null>;
  getDownloadUrl(key: string, expiresInSeconds?: number): Promise<string | null>;
  getPublicUrl(key: string): string | null;
  /** 分片预签名 URL（可选）：支持时返回可直传地址；返回 null 表示需走 Worker 代理上传 */
  getMultipartUploadUrl?(key: string, uploadId: string, partNumber: number, expiresInSeconds?: number): Promise<string | null>;
  /** 连通性测试 */
  testConnection(): Promise<{ connected: boolean; latency?: number; message: string }>;
}

export type { StorageProvider };
