#!/usr/bin/env bun
/**
 * Picumet 实验室 S3 检查工具：直接对本地 S3 兼容存储（A/B/C/D 四个实例）做对象级操作。
 *
 * 用途：E2E 测试需要「绕开应用」确认对象的物理落桶（拼好桶 A/D 分配、副桶 B 镜像、
 * 回收链路），这些事实无法从应用 API 观察，只能直连桶。复用 workers/node_modules 里
 * 已有的 @aws-sdk/client-s3，避免手写 SigV4。
 *
 * 运行（cwd 必须是 workers/，以便解析依赖）：
 *   bun ../scripts/lab/s3tool.ts ls  http://127.0.0.1:9000 picumet picumet:blob/
 *
 * 环境变量：S3_AK / S3_SK / S3_REGION（默认 minioadmin / minioadmin / us-east-1）
 *
 * 子命令（全部输出单行 JSON 到 stdout，失败时 exit 1）：
 *   mkbucket <ep> <bucket>
 *   ls       <ep> <bucket> [prefix]
 *   head     <ep> <bucket> <key>
 *   get      <ep> <bucket> <key> [outFile]
 *   put      <ep> <bucket> <key> <file>
 *   rm       <ep> <bucket> <key>
 *   copy     <srcEp> <srcBucket> <srcKey> <dstEp> <dstBucket> <dstKey>
 *   ping     <ep>
 */
import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { writeFileSync } from 'node:fs';

const AK = process.env.S3_AK ?? 'minioadmin';
const SK = process.env.S3_SK ?? 'minioadmin';
const REGION = process.env.S3_REGION ?? 'us-east-1';

function client(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: AK, secretAccessKey: SK },
  });
}

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function die(err: unknown): never {
  process.stderr.write(`${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}\n`);
  process.exit(1);
}

/** SDK 错误按 name 分类（NotFound / NoSuchBucket …）；非对象或无 string name 返回 undefined */
function errorName(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('name' in err)) return undefined;
  return typeof err.name === 'string' ? err.name : undefined;
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  // SDK 的 GetObject 返回 Body 联合类型（SdkStream），运行时是 async iterable；TS 无法收敛该结构。
  const stream = body as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const [cmd, ...rest] = process.argv.slice(2);

try {
  switch (cmd) {
    case 'mkbucket': {
      const [ep, bucket] = rest;
      await client(ep).send(new CreateBucketCommand({ Bucket: bucket }));
      out({ ok: true, bucket });
      break;
    }
    case 'ls': {
      const [ep, bucket, prefix] = rest;
      const c = client(ep);
      const keys: Array<{ key: string; size: number; etag?: string }> = [];
      let token: string | undefined;
      do {
        const res = await c.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 })
        );
        for (const o of res.Contents ?? []) keys.push({ key: o.Key ?? '', size: o.Size ?? 0, etag: o.ETag ?? undefined });
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      out({ bucket, prefix: prefix ?? '', count: keys.length, totalSize: keys.reduce((a, b) => a + b.size, 0), keys });
      break;
    }
    case 'head': {
      const [ep, bucket, key] = rest;
      try {
        const res = await client(ep).send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        out({
          exists: true,
          key,
          size: res.ContentLength ?? null,
          etag: res.ETag ?? null,
          sha256: res.Metadata?.sha256 ?? null,
          lastModified: res.LastModified ? res.LastModified.toISOString() : null,
        });
      } catch (err) {
        const name = errorName(err);
        if (name === 'NotFound' || name === 'NoSuchKey') out({ exists: false, key });
        else throw err;
      }
      break;
    }
    case 'get': {
      const [ep, bucket, key, outFile] = rest;
      const res = await client(ep).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const buf = await bodyToBuffer(res.Body);
      if (outFile) {
        writeFileSync(outFile, buf);
        out({ ok: true, key, bytes: buf.length, outFile });
      } else {
        process.stdout.write(buf);
      }
      break;
    }
    case 'put': {
      const [ep, bucket, key, file] = rest;
      // 用 Buffer 而非流：SDK 对流式 body 走 aws-chunked + trailer 校验和，
      // 部分 S3 兼容实现（versitygw）在该编码下会提前关连接。实验室对象尺寸可控。
      const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
      await client(ep).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes }));
      out({ ok: true, key, bytes: bytes.length });
      break;
    }
    case 'rm': {
      const [ep, bucket, key] = rest;
      await client(ep).send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      out({ ok: true, key });
      break;
    }
    case 'copy': {
      const [srcEp, srcBucket, srcKey, dstEp, dstBucket, dstKey] = rest;
      await client(dstEp).send(
        new CopyObjectCommand({
          Bucket: dstBucket,
          Key: dstKey,
          CopySource: `${srcBucket}/${encodeURIComponent(srcKey).replace(/%2F/g, '/')}`,
        })
      );
      out({ ok: true, src: `${srcBucket}/${srcKey}`, dst: `${dstBucket}/${dstKey}` });
      break;
    }
    case 'ping': {
      const [ep] = rest;
      try {
        await client(ep).send(new HeadBucketCommand({ Bucket: 'picumet' }));
        out({ ok: true, endpoint: ep, reachable: true });
      } catch (err) {
        const name = errorName(err);
        if (name === 'NotFound' || name === 'NoSuchBucket') out({ ok: true, endpoint: ep, reachable: true });
        else throw err;
      }
      break;
    }
    default:
      process.stderr.write('usage: s3tool.ts <mkbucket|ls|head|get|put|rm|copy|ping> …\n');
      process.exit(2);
  }
} catch (err) {
  die(err);
}
