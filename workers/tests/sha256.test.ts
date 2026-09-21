// 流式 SHA-256 正确性：已知向量 + 与 WebCrypto 对拍（含任意切分与流式透传）
// §F 内容哈希寻址的键由该实现产出，必须与标准 SHA-256 逐字节一致。
import { describe, it, expect } from 'vitest';
import { Sha256, hashPassThrough } from '../src/utils/sha256';

/** WebCrypto 参考值（node:20+/workerd 均可用） */
async function referenceHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexOfChunks(chunks: Uint8Array[]): string {
  const hasher = new Sha256();
  for (const chunk of chunks) hasher.update(chunk);
  return hasher.digestHex();
}

describe('流式 SHA-256', () => {
  it('已知向量：空串与 abc', () => {
    expect(new Sha256().digestHex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hexOfChunks([new TextEncoder().encode('abc')])).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('与 WebCrypto 一致：任意切分（跨 64 字节块边界）', async () => {
    const bytes = new Uint8Array(2000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const expected = await referenceHex(bytes);

    // 覆盖 <64、=64、跨块、>64 的切分方式
    for (const split of [1, 55, 63, 64, 65, 127, 128, 999, 1999]) {
      const chunks = [bytes.subarray(0, split), bytes.subarray(split)];
      expect(hexOfChunks(chunks)).toBe(expected);
    }
    // 逐字节喂入
    expect(hexOfChunks([...bytes].map((b) => new Uint8Array([b])))).toBe(expected);
  });

  it('digestHex 可重复调用且不改变进度', () => {
    const hasher = new Sha256();
    const bytes = new TextEncoder().encode('progressive');
    hasher.update(bytes.subarray(0, 4));
    const mid = hasher.digestHex();
    expect(hasher.digestHex()).toBe(mid);
    hasher.update(bytes.subarray(4));
    expect(hasher.digestHex()).not.toBe(mid);
    expect(hasher.digestHex()).toBe(hexOfChunks([bytes]));
  });

  it('hashPassThrough：透传内容不变，摘要与字节数一致', async () => {
    const content = new TextEncoder().encode('pass-through-content');
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(content.subarray(0, 5));
        controller.enqueue(content.subarray(5));
        controller.close();
      },
    });
    const { body, digest } = hashPassThrough(source);
    const received = new Uint8Array(await new Response(body).arrayBuffer());
    const result = await digest;
    expect([...received]).toEqual([...content]);
    expect(result.size).toBe(content.byteLength);
    expect(result.hex).toBe(await referenceHex(content));
  });
});
