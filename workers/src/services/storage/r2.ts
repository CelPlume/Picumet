// R2 绑定 Provider：本地开发与生产均可使用（基于 env.R2）
import type { StorageProviderInterface, HeadResult, ListResult, UploadedPart, ObjectBody } from './types';

export class R2BindingProvider implements StorageProviderInterface {
  readonly type = 'r2';
  readonly name: string;
  readonly bucketName: string;

  constructor(
    private bucket: R2Bucket,
    opts: { name: string; bucketName: string }
  ) {
    this.name = opts.name;
    this.bucketName = opts.bucketName;
  }

  async putObject(
    key: string,
    body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
    contentType?: string,
    metadata?: Record<string, string>
  ): Promise<{ etag?: string }> {
    const res = await this.bucket.put(key, body as ArrayBuffer, {
      httpMetadata: contentType ? { contentType } : undefined,
      customMetadata: metadata,
    });
    return { etag: res.httpEtag ?? res.etag };
  }

  async getObject(key: string): Promise<ObjectBody | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return {
      size: obj.size,
      etag: obj.httpEtag ?? obj.etag,
      contentType: obj.httpMetadata?.contentType,
      body: obj.body,
      metadata: obj.customMetadata,
    };
  }

  async headObject(key: string): Promise<HeadResult | null> {
    const obj = await this.bucket.head(key);
    if (!obj) return null;
    return {
      size: obj.size,
      etag: obj.httpEtag ?? obj.etag,
      contentType: obj.httpMetadata?.contentType,
      metadata: obj.customMetadata,
    };
  }

  async deleteObject(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async listObjects(prefix: string, opts?: { limit?: number; continuationToken?: string }): Promise<ListResult> {
    const res = await this.bucket.list({
      prefix,
      limit: opts?.limit ?? 1000,
      cursor: opts?.continuationToken,
    });
    const truncated = res.truncated;
    const cursor = truncated ? (res as { cursor?: string }).cursor : undefined;
    return {
      keys: res.objects.map((o) => ({
        key: o.key,
        size: o.size,
        etag: o.httpEtag ?? o.etag,
      })),
      truncated,
      continuationToken: cursor,
    };
  }

  async copyObject(sourceKey: string, targetKey: string): Promise<{ etag?: string }> {
    const obj = await this.bucket.get(sourceKey);
    if (!obj) throw new Error('Source object not found');
    const res = await this.bucket.put(targetKey, obj.body, {
      httpMetadata: obj.httpMetadata,
      customMetadata: obj.customMetadata,
    });
    return { etag: res.httpEtag ?? res.etag };
  }

  async createMultipartUpload(key: string, contentType?: string): Promise<{ uploadId: string }> {
    const mpu = await this.bucket.createMultipartUpload(key, {
      httpMetadata: contentType ? { contentType } : undefined,
    });
    return { uploadId: mpu.uploadId };
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>
  ): Promise<{ etag: string }> {
    const mpu = await this.bucket.resumeMultipartUpload(key, uploadId);
    const part = await mpu.uploadPart(partNumber, body as ArrayBuffer);
    return { etag: part.etag };
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<{ etag?: string }> {
    const mpu = await this.bucket.resumeMultipartUpload(key, uploadId);
    const completed = await mpu.complete(
      parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
    );
    return { etag: completed.httpEtag ?? completed.etag };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const mpu = await this.bucket.resumeMultipartUpload(key, uploadId);
    await mpu.abort();
  }

  async getUploadUrl(): Promise<string | null> {
    // R2 绑定不支持预签名 URL → 由 Worker 网关代理上传
    return null;
  }

  async getMultipartUploadUrl(): Promise<string | null> {
    // R2 绑定不支持分片预签名 URL → 由 Worker 代理上传分片
    return null;
  }

  async getDownloadUrl(): Promise<string | null> {
    return null;
  }

  getPublicUrl(key: string): string | null {
    // 无公网域名时不提供
    return null;
  }

  async testConnection(): Promise<{ connected: boolean; latency?: number; message: string }> {
    const start = Date.now();
    try {
      await this.bucket.list({ limit: 1 });
      return { connected: true, latency: Date.now() - start, message: '连接成功' };
    } catch (err) {
      return { connected: false, message: err instanceof Error ? err.message : '连接失败' };
    }
  }
}
