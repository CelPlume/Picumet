// R2 绑定 Provider：本地开发与生产均可使用（基于 env.R2）
// 对照 Cloudflare Workers API（2026-07 文档核实）：
// - get(key, { range: { offset, length } }) 原生支持区间读
// - delete(key | key[]) 原生支持批量删除（≤1000/次）
// - list({ delimiter }) 返回 delimitedPrefixes
import type {
  StorageProviderInterface,
  HeadResult,
  ListResult,
  ListOptions,
  GetObjectOptions,
  UploadedPart,
  ObjectBody,
} from './types';
import { r2RangeOption } from './range';
import { toProviderError } from './errors';

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

  async getObject(key: string, opts?: GetObjectOptions): Promise<ObjectBody | null> {
    let obj;
    try {
      obj = opts?.range
        ? await this.bucket.get(key, { range: r2RangeOption(opts.range) })
        : await this.bucket.get(key);
    } catch (err) {
      // R2 绑定与 Worker 同身份，无 auth 类错误；异常上抛由调用方分类
      throw toProviderError(err);
    }
    if (!obj || !('body' in obj) || !obj.body) return null;
    const range = opts?.range;
    return {
      // 带 Range 时 size 为本次返回字节数；obj.size 为全对象大小
      size: range ? range.end - range.start + 1 : obj.size,
      totalSize: obj.size,
      range,
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

  async deleteObjects(keys: string[]): Promise<void> {
    // R2 绑定原生支持数组删除（≤1000/次，官方文档核实）
    for (let i = 0; i < keys.length; i += 1000) {
      await this.bucket.delete(keys.slice(i, i + 1000));
    }
  }

  async listObjects(prefix: string, opts?: ListOptions): Promise<ListResult> {
    const res = await this.bucket.list({
      prefix,
      limit: opts?.limit ?? 1000,
      cursor: opts?.continuationToken,
      delimiter: opts?.delimiter,
    });
    const truncated = res.truncated;
    return {
      keys: res.objects.map((o) => ({
        key: o.key,
        size: o.size,
        etag: o.httpEtag ?? o.etag,
      })),
      prefixes: res.delimitedPrefixes ?? [],
      truncated,
      continuationToken: truncated ? res.cursor : undefined,
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

  // R2 绑定 get/put 均为流式，copyObject 已覆盖任意大小，无需 UploadPartCopy

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

  getPublicUrl(_key: string): string | null {
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
