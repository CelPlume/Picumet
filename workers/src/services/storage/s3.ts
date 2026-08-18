// S3 协议 Provider：适用于 R2（S3 API）、AWS S3、Oracle Cloud（S3 兼容）
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageProviderInterface, HeadResult, ListResult, UploadedPart, ObjectBody } from './types';

interface S3Opts {
  name: string;
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicDomain?: string;
}

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
      region: opts.region,
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

  async getObject(key: string): Promise<ObjectBody | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: key }));
      return {
        size: Number(res.ContentLength ?? 0),
        etag: res.ETag,
        contentType: res.ContentType,
        body: res.Body as ReadableStream<Uint8Array>,
        metadata: res.Metadata,
      };
    } catch {
      return null;
    }
  }

  async headObject(key: string): Promise<HeadResult | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucketName, Key: key }));
      return {
        size: Number(res.ContentLength ?? 0),
        etag: res.ETag,
        contentType: res.ContentType,
        metadata: res.Metadata,
      };
    } catch {
      return null;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
  }

  async listObjects(prefix: string, opts?: { limit?: number; continuationToken?: string }): Promise<ListResult> {
    const res = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        MaxKeys: opts?.limit ?? 1000,
        ContinuationToken: opts?.continuationToken,
      })
    );
    return {
      keys: (res.Contents ?? []).map((o) => ({
        key: o.Key ?? '',
        size: Number(o.Size ?? 0),
        etag: o.ETag,
      })),
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
      })
    );
    return { etag: res.CopyObjectResult?.ETag };
  }

  async createMultipartUpload(key: string, contentType?: string): Promise<{ uploadId: string }> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: contentType,
      })
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
      })
    );
    return { etag: res.ETag };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: this.bucketName, Key: key, UploadId: uploadId })
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
      await this.client.send(new ListObjectsCommand({ Bucket: this.bucketName, MaxKeys: 1 }));
      return { connected: true, latency: Date.now() - start, message: '连接成功' };
    } catch (err) {
      return { connected: false, message: err instanceof Error ? err.message : '连接失败' };
    }
  }
}
