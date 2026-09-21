// 流式 SHA-256（纯 TypeScript 增量实现，§F 内容哈希寻址专用）
//
// 为什么不用 crypto.subtle：它只有整包 digest，没有流式 API；内容寻址需要在上传流上
// 边写边算（大文件不能整包驻留内存）。实现同时运行在 Workers 与 node 测试环境。
import { toHex } from './crypto';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** 增量 SHA-256：update 可任意切分，digestHex 可重复调用 */
export class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly w = new Uint32Array(64);
  private blockLen = 0;
  private totalLen = 0;

  update(chunk: Uint8Array): this {
    this.totalLen += chunk.byteLength;
    let offset = 0;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, chunk.byteLength);
      this.block.set(chunk.subarray(0, take), this.blockLen);
      this.blockLen += take;
      offset = take;
      if (this.blockLen === 64) {
        this.compress(this.block, 0);
        this.blockLen = 0;
      }
    }
    while (chunk.byteLength - offset >= 64) {
      this.compress(chunk, offset);
      offset += 64;
    }
    if (offset < chunk.byteLength) {
      this.block.set(chunk.subarray(offset), 0);
      this.blockLen = chunk.byteLength - offset;
    }
    return this;
  }

  /** 16 进制摘要（复制状态计算，不改变当前进度） */
  digestHex(): string {
    const out = new Uint8Array(32);
    const saved = this.h.slice();
    const savedBlock = this.block.slice();
    const savedLen = this.totalLen;
    const savedBlockLen = this.blockLen;
    this.finish();
    for (let i = 0; i < 8; i++) {
      out[i * 4] = (this.h[i] >>> 24) & 0xff;
      out[i * 4 + 1] = (this.h[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (this.h[i] >>> 8) & 0xff;
      out[i * 4 + 3] = this.h[i] & 0xff;
    }
    this.h.set(saved);
    this.block.set(savedBlock);
    this.totalLen = savedLen;
    this.blockLen = savedBlockLen;
    return toHex(out);
  }

  private compress(data: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    const h = this.h;
    let [a, b, c, d, e, f, g, hh] = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  private finish(): void {
    const bitLen = this.totalLen * 8;
    this.block[this.blockLen] = 0x80;
    this.blockLen++;
    if (this.blockLen > 56) {
      this.block.fill(0, this.blockLen);
      this.compress(this.block, 0);
      this.blockLen = 0;
    }
    this.block.fill(0, this.blockLen, 56);
    // 64 位大端长度：高 32 位（totalLen 上限 2^53 字节，高 32 位用 Number 拆分）
    const high = Math.floor(bitLen / 0x100000000);
    this.block[56] = (high >>> 24) & 0xff;
    this.block[57] = (high >>> 16) & 0xff;
    this.block[58] = (high >>> 8) & 0xff;
    this.block[59] = high & 0xff;
    this.block[60] = (bitLen >>> 24) & 0xff;
    this.block[61] = (bitLen >>> 16) & 0xff;
    this.block[62] = (bitLen >>> 8) & 0xff;
    this.block[63] = bitLen & 0xff;
    this.compress(this.block, 0);
    this.blockLen = 0;
  }
}

export interface HashStreamResult {
  /** 透传给存储提供方的流（内容不变） */
  body: ReadableStream<Uint8Array>;
  /** 流结束后的十六进制摘要与字节数；流被取消/出错时 reject */
  digest: Promise<{ hex: string; size: number }>;
}

/**
 * 边透传边哈希：给提供方 putObject 的流，同时算出内容 SHA-256 与字节数。
 * 消费方提前取消时 digest 会 reject（调用方按失败处理，避免悬挂等待）。
 */
export function hashPassThrough(source: ReadableStream<Uint8Array>): HashStreamResult {
  const hasher = new Sha256();
  let bytes = 0;
  let settled = false;
  let resolveDigest!: (value: { hex: string; size: number }) => void;
  let rejectDigest!: (err: unknown) => void;
  const digest = new Promise<{ hex: string; size: number }>((resolve, reject) => {
    resolveDigest = resolve;
    rejectDigest = reject;
  });

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hasher.update(value);
          bytes += value.byteLength;
          controller.enqueue(value);
        }
        controller.close();
        settled = true;
        resolveDigest({ hex: hasher.digestHex(), size: bytes });
      } catch (err) {
        settled = true;
        rejectDigest(err);
        try {
          controller.error(err);
        } catch {
          // 消费方已关闭流
        }
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      if (!settled) {
        settled = true;
        rejectDigest(reason instanceof Error ? reason : new Error('上传流已取消'));
      }
    },
  });

  return { body, digest };
}
