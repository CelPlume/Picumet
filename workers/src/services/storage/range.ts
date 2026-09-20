// HTTP Range 解析与 provider range 参数映射（纯函数，单测见 tests/storage-range.test.ts）

export type ParsedRange = { start: number; end: number };

export type RangeParseResult =
  | { type: 'none' }
  | { type: 'full' } // 头存在但语法非法/不可解析 → 按 RFC 7233 忽略，返回 200 全量
  | { type: 'unsatisfiable' } // 语法合法但 start >= size → 416
  | { type: 'range'; range: ParsedRange };

/**
 * 解析单个 Range 请求头（bytes=start-end | bytes=start- | bytes=-suffix）。
 * 多区间请求只服务第一个区间（媒体 seek 场景足够，避免 multipart/byteranges 复杂度）。
 */
export function parseRangeHeader(header: string | undefined | null, totalSize: number): RangeParseResult {
  if (!header) return { type: 'none' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { type: 'full' };
  const [, startRaw, endRaw] = m;
  if (startRaw === '' && endRaw === '') return { type: 'full' };

  if (startRaw === '') {
    // suffix: bytes=-N → 最后 N 字节
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return { type: 'full' };
    if (totalSize <= 0) return { type: 'unsatisfiable' };
    const start = Math.max(0, totalSize - suffix);
    return { type: 'range', range: { start, end: totalSize - 1 } };
  }

  const start = Number(startRaw);
  if (!Number.isInteger(start) || start < 0) return { type: 'full' };
  if (start >= totalSize) return { type: 'unsatisfiable' };

  if (endRaw === '') {
    return { type: 'range', range: { start, end: totalSize - 1 } };
  }
  const end = Number(endRaw);
  if (!Number.isInteger(end) || end < start) return { type: 'full' };
  return { type: 'range', range: { start, end: Math.min(end, totalSize - 1) } };
}

/** S3 GetObject Range 头（inclusive） */
export function s3RangeHeader(range: ParsedRange): string {
  return `bytes=${range.start}-${range.end}`;
}

/** R2 binding range 选项：offset（inclusive）+ length */
export function r2RangeOption(range: ParsedRange): { offset: number; length: number } {
  return { offset: range.start, length: range.end - range.start + 1 };
}

/**
 * 从 S3 响应 Content-Range（"bytes 0-99/1234"）提取全对象大小。
 * 解析失败返回 undefined（调用方回退 size）。
 */
export function parseS3ContentRangeTotal(contentRange: string | undefined): number | undefined {
  if (!contentRange) return undefined;
  const m = /bytes \d+-\d+\/(\d+)/.exec(contentRange);
  if (!m) return undefined;
  const total = Number(m[1]);
  return Number.isInteger(total) && total >= 0 ? total : undefined;
}
