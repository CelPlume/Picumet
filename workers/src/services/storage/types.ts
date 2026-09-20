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

export interface GetObjectOptions {
  /** 字节区间（inclusive，HTTP Range 语义） */
  range?: { start: number; end: number };
}

export interface ListOptions {
  limit?: number;
  continuationToken?: string;
  /** 目录折叠分隔符（如 '/'），公共前缀放入 ListResult.prefixes */
  delimiter?: string;
}

export interface ListResult {
  keys: ListEntry[];
  /** delimiter 折叠出的虚拟目录前缀（以 '/' 结尾） */
  prefixes?: string[];
  truncated: boolean;
  continuationToken?: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface ObjectBody {
  /** 本次返回的字节数 */
  size: number;
  /** 全对象大小（range 读取时完整大小；缺省视为等于 size） */
  totalSize?: number;
  /** 本次返回的字节区间（inclusive）；非 range 读取缺省 */
  range?: { start: number; end: number };
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
  getObject(key: string, opts?: GetObjectOptions): Promise<ObjectBody | null>;
  headObject(key: string): Promise<HeadResult | null>;
  deleteObject(key: string): Promise<void>;
  /** 批量删除（≤1000/批由实现内部处理）；对象不存在不视为错误 */
  deleteObjects(keys: string[]): Promise<void>;
  listObjects(prefix: string, opts?: ListOptions): Promise<ListResult>;
  copyObject(sourceKey: string, targetKey: string): Promise<{ etag?: string }>;
  /**
   * 服务端分片复制（>5GB，UploadPartCopy；对照报告 P1-2）。
   * 可选能力：未实现时调用方回退 copyObject（≤5GB / 流式中转）。
   */
  copyObjectMultipart?(sourceKey: string, targetKey: string): Promise<{ etag?: string }>;
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
