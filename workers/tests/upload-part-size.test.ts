// 分片尺寸动态放大的回归：大文件分片数必须压在引擎安全档内（lab 引擎实测 650 OK / 800 FAIL）
import { describe, it, expect } from 'vitest';
import { resolveMultipartPartSize, MAX_MULTIPART_PARTS, PART_SIZE, MULTIPART_THRESHOLD } from '../src/services/uploads/handlers';

const MiB = 1024 * 1024;

describe('resolveMultipartPartSize', () => {
  it('阈值内不分片（undefined）', () => {
    expect(resolveMultipartPartSize(MULTIPART_THRESHOLD)).toBeUndefined();
    expect(resolveMultipartPartSize(50 * MiB)).toBeUndefined();
  });

  it('刚过阈值：保持 8 MiB 默认分片（29 片，与既有契约一致）', () => {
    const size = 226 * MiB;
    const partSize = resolveMultipartPartSize(size)!;
    expect(partSize).toBe(PART_SIZE);
    expect(Math.ceil(size / partSize)).toBe(29);
  });

  it('6.36 GiB：分片放大到 11 MiB，片数 ≤650', () => {
    const size = Math.floor(6.36 * 1024 * 1024 * 1024);
    const partSize = resolveMultipartPartSize(size)!;
    expect(partSize).toBeGreaterThan(PART_SIZE);
    expect(partSize % MiB).toBe(0);
    const total = Math.ceil(size / partSize);
    expect(total).toBeLessThanOrEqual(MAX_MULTIPART_PARTS);
    expect(total).toBe(593); // 6.36 GiB / 11 MiB = 592.06 → 593 片
  });

  it('超引擎上限的任意大文件：片数始终 ≤650 且分片 ≥8 MiB', () => {
    for (const gib of [10, 50, 100, 800]) {
      const size = gib * 1024 * 1024 * 1024;
      const partSize = resolveMultipartPartSize(size)!;
      expect(Math.ceil(size / partSize)).toBeLessThanOrEqual(MAX_MULTIPART_PARTS);
      expect(partSize).toBeGreaterThanOrEqual(PART_SIZE);
      // S3 单片上限 5 GiB
      expect(partSize).toBeLessThanOrEqual(5 * 1024 * 1024 * 1024);
    }
  });

  it('前端按 ceil(size/totalParts) 推导的切片能覆盖整个文件且片数一致', () => {
    const size = 6_364_015_616; // Win11 23H2 实际大小
    const partSize = resolveMultipartPartSize(size)!;
    const total = Math.ceil(size / partSize);
    const clientPartSize = Math.ceil(size / total);
    let covered = 0;
    for (let n = 1; n <= total; n++) {
      covered += Math.min(n * clientPartSize, size) - (n - 1) * clientPartSize;
    }
    expect(covered).toBe(size);
  });
});
