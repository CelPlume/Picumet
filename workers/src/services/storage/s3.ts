// S3 协议 Provider：适用于 R2（S3 API）、AWS S3、Oracle Cloud（S3 兼容）
// P0-2 错误分类：getObject/headObject 仅 not-found 返回 null，其余抛 ProviderError
// P0-1 Range：getObject 支持 {start,end}（inclusive）
// P1-4 批量删除：deleteObjects（≤1000/批）
// P1-5 Delimiter：listObjects 支持 delimiter → prefixes
// P1-2 分片复制：copyObjectMultipart（UploadPartCopy，>5GB）
// DESIGN-03 超时策略：控制面/元数据操作统一 15s 超时防挂死；数据面（对象 body 流）按流处理，不设总时限
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  StorageProviderInterface,
  HeadResult,
  ListResult,
  ListOptions,
  GetObjectOptions,
  UploadedPart,
  ObjectBody,
} from './types';
import { ProviderError, toProviderError } from './errors';
import { parseS3ContentRangeTotal, s3RangeHeader } from './range';

interface S3Opts {
  name: string;
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicDomain?: string;
}

/** AWS CopyObject 单命令上限 5GB；超过走 copyObjectMultipart（对照报告 P1-2） */
export const COPY_OBJECT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
/** 分片复制单片大小（≥5MiB；256MB × 最多 10000 片 ≈ 2.5TB 覆盖面） */
const COPY_PART_SIZE = 256 * 1024 * 1024;

/**
 * 控制面/元数据操作统一超时（ms）：防止元数据请求挂死占用 Worker 时间预算（DESIGN-03）。
 * 数据面（putObject/getObject/uploadPart 的 body 流）不设总时限——整包时限会误杀大文件传输。
 */
const METADATA_TIMEOUT_MS = 15_000;

function toS3Body(body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>) {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return body;
}

export class S3Provider implements StorageProviderInterface {
  readonly type = 's3';
  readonly name: string;
  readonly bucketName: string;
  private client: S3Client;
  private publicDomain?: string;

  constructor(opts: S3Opts) {
    this.name = opts.name;
    this.bucketName = opts.bucket;
    this.publicDomain = opts.publicDomain;
    this.client = new S3Client({
      endpoint: opts.endpoint,
      // 空 region 会让 SDK 签名失败（报告 §5.1.7）：统一兜底 auto
      region: opts.region || 'auto',
      forcePathStyle: true,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
    });
  }

  async putObject(
    key: string,
    body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
    contentType?: string,
    metadata?: Record<string, string>
  ): Promise<{ etag?: string }> {
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: toS3Body(body),
        ContentType: contentType,
        Metadata: metadata,
      })
    );
    return { etag: res.ETag };
  }

  async getObject(key: string, opts?: GetObjectOptions): Promise<ObjectBody | null> {
    let res;
    try {
      res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Range: opts?.range ? s3RangeHeader(opts.range) : undefined,
        })
      );
    } catch (err) {
      // 仅确认的 not-found 返回 null；auth/throttled/other 上抛（P0-2）
      if (toProviderError(err).kind === 'not-found') return null;
      throw err;
    }
    const range = opts?.range;
    return {
      // 带 Range 时 ContentLength 为本次返回字节数
      size: Number(res.ContentLength ?? 0),
      totalSize: range ? (parseS3ContentRangeTotal(res.ContentRange) ?? undefined) : Number(res.ContentLength ?? 0),
      range,
      etag: res.ETag,
      contentType: res.ContentType,
      body: res.Body as ReadableStream<Uint8Array>,
      metadata: res.Metadata,
    };
  }

  async headObject(key: string): Promise<HeadResult | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: key }),
        { abortSignal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }
      );
      return {
        size: Number(res.ContentLength ?? 0),
        etag: res.ETag,
        contentType: res.ContentType,
        metadata: res.Metadata,
      };
    } catch (err) {
      if (toProviderError(err).kind === 'not-found') return null;
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }), {
      abortSignal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
  }

  async deleteObjects(keys: string[]): Promise<void> {
    // S3 DeleteObjectsCommand 上限 1000/批；响应中的 per-object Errors 必须上抛，
    // 否则部分失败会被吞掉（调用方依赖失败信号记录孤儿对象）
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucketName,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        }),
        { abortSignal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }
      );
      if (res.Errors?.length) {
        const failed = res.Errors.map((e) => `${e.Key}: ${e.Code}`).join(', ');
        throw new ProviderError('other', `批量删除部分失败: ${failed}`);
      }
    }
  }

  async listObjects(prefix: string, opts?: ListOptions): Promise<ListResult> {
    const res = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        MaxKeys: opts?.limit ?? 1000,
        ContinuationToken: opts?.continuationToken,
        Delimiter: opts?.delimiter,
      }),
      { abortSignal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }
    );
    return {
      keys: (res.Contents ?? []).map((o) => ({
        key: o.Key ?? '',
        size: Number(o.Size ?? 0),
        etag: o.ETag,
      })),
      prefixes: (res.CommonPrefixes ?? []).map((p) => p.Prefix ?? '').filter(Boolean),
      truncated: res.IsTruncated ?? false,
      continuationToken: res.NextContinuationToken,
    };
  }

  async copyObject(sourceKey: string, targetKey: string): Promise<{ etag?: string }> {
    const res = await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucketName,
        Key: targetKey,
        CopySource: `${this.bucketName}/${encodeURIComponent(sourceKey)}`,
      }),
      { abortSignal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }
    );
    return { etag: res.CopyObjectResult?.ETag };
  }

  /**
   * 分片复制（UploadPartCopy）：单片 ≤5GB，整体无 AWS CopyObject 5GB 上限。
   * 失败补偿：Abort 未完成的 multipart upload。
   */
  async copyObjectMultipart(sourceKey: string, targetKey: string): Promise<{ etag?: string }> {
    const head = await this.headObject(sourceKey);
    if (!head) throw ProviderError.notFound(sourceKey);
    const size = head.size;

    const create = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucketName, Key: targetKey }),
      { abortSignal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }
    );
    const uploadId = create.UploadId ?? '';
    try {
      const parts: Array<{ PartNumber: number; ETag?: string }> = [];
      let partNumber = 1;
      for (let start = 0; start < size; start += COPY_PART_SIZE) {
        const end = Math.min(start + COPY_PART_SIZE, size) - 1;
        const res = await this.client.send(
          new UploadPartCopyCommand({
            Bucket: this.bucketName,
            Key: targetKey,
            UploadId: uploadId,
            PartNumber: partNumber,
            CopySource: `${this.bucketName}/${encodeURIComponent(sourceKey)}`,
            CopySourceRange: `bytes=${start}-${end}`,
          }),
          { abortSignal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }
        );
        parts.push({ PartNumber: partNumber, ETag: res.CopyPartResult?.ETag });
        partNumber += 1;
      }
      const complete = await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucketName,
          Key: targetKey,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
        { abortSignal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }
      );
      return { etag: complete.ETag };
    } catch (err) {
      try {
        await this.client.send(
          new AbortMultipartUploadCommand({ Bucket: this.bucketName, Key: targetKey, UploadId: uploadId }),
          { abortSignal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }
        );
      } catch {
        // 补偿失败：未完成 multipart 由桶生命周期策略清理
      }
      throw err;
    }
  }

  async createMultipartUpload(key: string, contentType?: string): Promise<{ uploadId: string }> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: contentType,
      }),
      { abortSignal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }
    );
    return { uploadId: res.UploadId ?? '' };
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>
  ): Promise<{ etag: string }> {
    const res = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucketName,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: toS3Body(body),
      })
    );
    return { etag: res.ETag ?? '' };
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<{ etag?: string }> {
    const res = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
      { abortSignal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }
    );
    return { etag: res.ETag };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: this.bucketName, Key: key, UploadId: uploadId }),
      { abortSignal: AbortSignal.timeout(METADATA_TIMEOUT_MS) }
    );
  }

  async getUploadUrl(key: string, contentType?: string, expiresInSeconds = 900): Promise<string | null> {
    try {
      return await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          ContentType: contentType,
        }),
        { expiresIn: expiresInSeconds }
      );
    } catch {
      // 签名失败回退 Worker 网关代理（URL 方法保持容错语义）
      return null;
    }
  }

  async getDownloadUrl(key: string, expiresInSeconds = 900): Promise<string | null> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
        { expiresIn: expiresInSeconds }
      );
    } catch {
      return null;
    }
  }

  async getMultipartUploadUrl(key: string, uploadId: string, partNumber: number, expiresInSeconds = 900): Promise<string | null> {
    try {
      return await getSignedUrl(
        this.client,
        new UploadPartCommand({
          Bucket: this.bucketName,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: expiresInSeconds }
      );
    } catch {
      return null;
    }
  }

  getPublicUrl(key: string): string | null {
    if (!this.publicDomain) return null;
    const base = this.publicDomain.replace(/\/+$/, '');
    return `${base}/${encodeURIComponent(key)}`;
  }

  async testConnection(): Promise<{ connected: boolean; latency?: number; message: string }> {
    const start = Date.now();
    try {
      await this.client.send(new ListObjectsCommand({ Bucket: this.bucketName, MaxKeys: 1 }), {
        abortSignal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      });
      return { connected: true, latency: Date.now() - start, message: '连接成功' };
    } catch (err) {
      return { connected: false, message: err instanceof Error ? err.message : '连接失败' };
    }
  }
}
