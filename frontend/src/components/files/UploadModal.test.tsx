// 上传弹窗分片链路：
// 服务端对 >100MB 的文件下发分片会话（totalParts>1），前端必须逐片上传到分片端点或预签名分片 URL；
// 分片会话若误走 /upload/raw（旧行为）会因「非单对象会话」被拒（409/422）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { UploadResult } from './data';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/lib/api', () => ({
  getCsrfToken: vi.fn(async () => 'csrf-1'),
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/core', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button>,
  Progress: () => null,
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? <div>{children}</div> : null),
}));
vi.mock('lucide-react', () => ({
  UploadCloud: () => <span data-icon="upload-cloud" />,
  X: () => <span data-icon="x" />,
  Pause: () => <span data-icon="pause" />,
  Play: () => <span data-icon="play" />,
  RotateCcw: () => <span data-icon="rotate" />,
}));
vi.mock('./data', () => ({ initUploadSession: vi.fn(), completeUpload: vi.fn() }));

import { UploadModal } from './UploadModal';
import { initUploadSession, completeUpload } from './data';
import { getCsrfToken } from '@/lib/api';

const MIB = 1024 * 1024;
const EIGHT_MIB = 8 * MIB;

type ProgressEventLike = { lengthComputable: boolean; loaded: number; total: number };

/** 最小 XHR 桩：按测试给定的 handler 决定「立即完成」还是「保持挂起」 */
class FakeXHR {
  static instances: FakeXHR[] = [];
  static handler: (xhr: FakeXHR) => void = () => {};
  method = '';
  url = '';
  headers: Record<string, string> = {};
  withCredentials = false;
  aborted = false;
  status = 0;
  statusText = '';
  response = '';
  private responseHeaders: Record<string, string> = {};
  upload: { onprogress: ((e: ProgressEventLike) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXHR.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    this.headers[key.toLowerCase()] = value;
  }
  getResponseHeader(name: string) {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  send() {
    FakeXHR.handler(this);
  }
  finish(status: number, response = '', headers: Record<string, string> = {}) {
    this.status = status;
    this.statusText = String(status);
    this.response = response;
    this.responseHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    // 50% → 100%：模拟分片内进度事件
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    this.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 2 });
    this.onload?.();
  }
}

function renderWithFile(session: UploadResult, size: number) {
  vi.mocked(initUploadSession).mockResolvedValue(session);
  const { container } = render(<UploadModal open onClose={() => {}} targetPath="/" onDone={() => {}} />);
  const file = new File(['x'], 'big.bin', { type: 'application/octet-stream' });
  Object.defineProperty(file, 'size', { value: size });
  const slices: number[] = [];
  file.slice = ((start = 0, end = size) => {
    slices.push(end - start);
    return { size: end - start };
  }) as unknown as File['slice'];
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  return { container, slices };
}

const workerMultipart = (totalParts: number): UploadResult => ({
  sessionId: 's1',
  uploadUrl: null,
  uploadId: 'up1',
  uploadMode: 'worker',
  totalParts,
  parts: [],
  expiresAt: Date.now() + 3_600_000,
});

beforeEach(() => {
  FakeXHR.instances = [];
  FakeXHR.handler = () => {};
  vi.clearAllMocks();
  vi.mocked(getCsrfToken).mockImplementation(async () => 'csrf-1');
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
});

describe('UploadModal 分片上传', () => {
  it('Worker 分片会话：逐片 PUT 到代理分片端点并携带 CSRF，完成时不回传 parts', async () => {
    const totalParts = 38; // 300MiB / 8MiB
    FakeXHR.handler = (xhr) => {
      const partNumber = Number(xhr.url.split('/part/')[1]);
      xhr.finish(200, JSON.stringify({ success: true, data: { partNumber, etag: `etag-${partNumber}` } }), {
        'content-type': 'application/json',
      });
    };
    const { slices } = renderWithFile(workerMultipart(totalParts), 300 * MIB);

    await waitFor(() => expect(completeUpload).toHaveBeenCalledTimes(1));

    expect(FakeXHR.instances).toHaveLength(totalParts);
    expect(FakeXHR.instances.map((x) => x.url)).toEqual(
      Array.from({ length: totalParts }, (_, i) => `/api/files/upload/multipart/s1/part/${i + 1}`)
    );
    // 分片大小按 ceil(size/totalParts) 切分，单片不超过服务端 8MiB 分片档
    expect(slices).toHaveLength(totalParts);
    expect(slices.every((s) => s > 0 && s <= EIGHT_MIB)).toBe(true);
    expect(slices.reduce((sum, s) => sum + s, 0)).toBe(300 * MIB);
    for (const xhr of FakeXHR.instances) {
      expect(xhr.method).toBe('PUT');
      expect(xhr.headers['x-csrf-token']).toBe('csrf-1');
      expect(xhr.headers['content-type']).toBe('application/octet-stream');
      // 同源请求保留 Cookie
      expect(xhr.withCredentials).toBe(true);
    }
    // 分片会话从不走单对象代理端点
    expect(FakeXHR.instances.some((x) => x.url.includes('/upload/raw'))).toBe(false);
    // CSRF 只取一次，复用到所有分片
    expect(vi.mocked(getCsrfToken)).toHaveBeenCalledTimes(1);
    // Worker 代理路径由服务端留存分片记录，客户端不重复上报
    expect(completeUpload).toHaveBeenCalledWith({ sessionId: 's1', parts: undefined });
  });

  it('预签名分片会话：各分片直传预签名 URL，ETag 可读时回传 parts', async () => {
    FakeXHR.handler = (xhr) => xhr.finish(200, '', { etag: `"tag-${xhr.url.slice(-1)}"` });
    const session: UploadResult = {
      sessionId: 's2',
      uploadUrl: null,
      uploadId: 'up2',
      uploadMode: 'presigned',
      totalParts: 3,
      parts: [1, 2, 3].map((partNumber) => ({ partNumber, url: `https://bucket.example/part-${partNumber}` })),
      expiresAt: Date.now() + 3_600_000,
    };
    renderWithFile(session, 200 * MIB);

    await waitFor(() => expect(completeUpload).toHaveBeenCalledTimes(1));

    expect(FakeXHR.instances.map((x) => x.url)).toEqual([
      'https://bucket.example/part-1',
      'https://bucket.example/part-2',
      'https://bucket.example/part-3',
    ]);
    // 跨域桶不启用 credentials（CORS 通配源下会失败），也不带 CSRF
    for (const xhr of FakeXHR.instances) {
      expect(xhr.withCredentials).toBe(false);
      expect(xhr.headers['x-csrf-token']).toBeUndefined();
    }
    expect(vi.mocked(getCsrfToken)).not.toHaveBeenCalled();
    expect(completeUpload).toHaveBeenCalledWith({
      sessionId: 's2',
      parts: [
        { partNumber: 1, etag: '"tag-1"' },
        { partNumber: 2, etag: '"tag-2"' },
        { partNumber: 3, etag: '"tag-3"' },
      ],
    });
  });

  it('预签名分片会话：CORS 未暴露 ETag 时省略 parts，交由服务端 listParts 解析', async () => {
    FakeXHR.handler = (xhr) => xhr.finish(200);
    const session: UploadResult = {
      sessionId: 's3',
      uploadUrl: null,
      uploadId: 'up3',
      uploadMode: 'presigned',
      totalParts: 2,
      parts: [1, 2].map((partNumber) => ({ partNumber, url: `https://bucket.example/part-${partNumber}` })),
      expiresAt: Date.now() + 3_600_000,
    };
    renderWithFile(session, 150 * MIB);

    await waitFor(() => expect(completeUpload).toHaveBeenCalledTimes(1));

    expect(FakeXHR.instances).toHaveLength(2);
    expect(completeUpload).toHaveBeenCalledWith({ sessionId: 's3', parts: undefined });
  });

  it('单对象 Worker 上传（≤100MB）：仍走 /upload/raw 并携带 CSRF', async () => {
    FakeXHR.handler = (xhr) => xhr.finish(200, JSON.stringify({ success: true, data: { etag: 'raw-etag' } }), {
      'content-type': 'application/json',
    });
    renderWithFile(
      { sessionId: 's4', uploadUrl: null, uploadMode: 'worker', expiresAt: Date.now() + 3_600_000 },
      10 * MIB
    );

    await waitFor(() => expect(completeUpload).toHaveBeenCalledTimes(1));

    expect(FakeXHR.instances).toHaveLength(1);
    expect(FakeXHR.instances[0].url).toBe('/api/files/upload/raw/s4');
    expect(FakeXHR.instances[0].headers['x-csrf-token']).toBe('csrf-1');
    expect(completeUpload).toHaveBeenCalledWith({ sessionId: 's4', etag: 'raw-etag' });
  });

  it('暂停仍中止在途 XHR 且不提交完成请求', async () => {
    FakeXHR.handler = () => {}; // 保持挂起
    const { container } = renderWithFile(
      { sessionId: 's5', uploadUrl: null, uploadMode: 'worker', expiresAt: Date.now() + 3_600_000 },
      10 * MIB
    );
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(1));

    const pause = container.querySelector('[data-icon="pause"]')?.closest('button');
    expect(pause).not.toBeNull();
    fireEvent.click(pause as HTMLButtonElement);

    await waitFor(() => expect(FakeXHR.instances[0].aborted).toBe(true));
    expect(completeUpload).not.toHaveBeenCalled();
  });
});
