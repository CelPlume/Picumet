#!/usr/bin/env bun
/**
 * S3 兼容引擎的 multipart-complete 分片数上限探测（绕开应用直连桶）。
 *
 * 背景：S3 规范允许 10000 片，但部分兼容网关（实测 VersityGW 1.8.0：650 OK / 800 FAIL
 * `InternalError`）在远低于规范上限处合并失败。应用侧已按 `MAX_MULTIPART_PARTS` 动态放大
 * 分片规避；本工具用于在新引擎/新版本上复测边界，或核对其他引擎的可用分片数。
 *
 * 运行（cwd 需在 workers/ 以解析 @aws-sdk/client-s3）：
 *   bun scripts/lab/mpu_probe.ts <endpoint> [--parts 500,650,800] [--part-size-mib 5]
 *
 * 每个探测点：CreateMultipartUpload → N×UploadPart(顺序 5 MiB 块) → CompleteMultipartUpload
 * → 成功后删除对象 / 失败后 abort。输出单行结论 JSON 到 stdout。
 */
import {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const endpoint = process.argv[2] ?? 'http://127.0.0.1:9000';
const partsArg = process.argv.includes('--parts') ? process.argv[process.argv.indexOf('--parts') + 1] : '500,650,800';
const partSizeMiB = process.argv.includes('--part-size-mib') ? Number(process.argv[process.argv.indexOf('--part-size-mib') + 1]) : 5;
const probePoints = partsArg.split(',').map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n > 0);

if (partSizeMiB < 5) {
  console.error('part-size-mib 必须 ≥5（S3 除末片外最小 5 MiB，否则 EntityTooSmall）');
  process.exit(2);
}

const client = new S3Client({
  endpoint, region: process.env.S3_REGION ?? 'us-east-1',
  credentials: { accessKeyId: process.env.S3_AK ?? 'minioadmin', secretAccessKey: process.env.S3_SK ?? 'minioadmin' },
  forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED',
});
const bucket = process.env.S3_BUCKET ?? 'picumet';
const chunk = Buffer.alloc(partSizeMiB * 1024 * 1024, 0x61);
const results: Array<{ parts: number; ok: boolean; error?: string }> = [];

for (const n of probePoints) {
  const key = `probe/mpu-threshold-${n}.bin`;
  const cm = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: 'application/octet-stream' }));
  const parts: Array<{ PartNumber: number; ETag: string }> = [];
  let failed = false;
  const t0 = Date.now();
  try {
    for (let i = 1; i <= n; i++) {
      const up = await client.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: cm.UploadId, PartNumber: i, Body: chunk }));
      parts.push({ PartNumber: i, ETag: up.ETag! });
    }
    await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket, Key: key, UploadId: cm.UploadId, MultipartUpload: { Parts: parts },
    }));
    console.log(`probe n=${n}: COMPLETE OK (${Date.now() - t0}ms)`);
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`probe n=${n}: COMPLETE FAILED ${message.slice(0, 160)}`);
    results.push({ parts: n, ok: false, error: message.slice(0, 160) });
    failed = true;
    await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: cm.UploadId })).catch(() => {});
  }
  if (!failed) results.push({ parts: n, ok: true });
  if (failed) break; // 首个失败点后停止（更高片数只会更差）
}

const boundary = results.filter((r) => r.ok).reduce((m, r) => Math.max(m, r.parts), 0);
const firstFail = results.find((r) => !r.ok);
console.log(JSON.stringify({
  endpoint, partSizeMiB,
  boundary: firstFail ? { maxOk: boundary || 0, minFail: firstFail.parts, error: firstFail.error } : { maxOk: boundary, minFail: null },
  detail: results,
}));
