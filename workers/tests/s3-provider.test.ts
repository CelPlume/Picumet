// S3Provider 预签名分片 URL 单测（getSignedUrl 为本地签名，不联网）
import { describe, it, expect } from 'vitest';
import { S3Provider } from '../src/providers/s3-provider';

describe('S3Provider 分片预签名', () => {
  it('getMultipartUploadUrl 本地签名，URL 含签名参数与分片号', async () => {
    const p = new S3Provider({
      name: 'test',
      bucket: 'test-bucket',
      endpoint: 'https://s3.example.com',
      region: 'auto',
      accessKeyId: 'AKID',
      secretAccessKey: 'SKID',
    });
    const url = await p.getMultipartUploadUrl('dir/file.bin', 'upload-123', 2, 900);
    expect(url).toBeTruthy();
    expect(url).toContain('partNumber=2');
    expect(url).toContain('X-Amz-Signature');
    expect(url).toContain('X-Amz-Credential');
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
  });

  it('getUploadUrl 也返回预签名直传 URL', async () => {
    const p = new S3Provider({
      name: 'test',
      bucket: 'test-bucket',
      endpoint: 'https://s3.example.com',
      region: 'auto',
      accessKeyId: 'AKID',
      secretAccessKey: 'SKID',
    });
    const url = await p.getUploadUrl('dir/new.txt', 'text/plain', 900);
    expect(url).toBeTruthy();
    expect(url).toContain('X-Amz-Signature');
  });
});
