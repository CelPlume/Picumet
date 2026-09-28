// PreviewModal 集成回归（LAB 回归：跨源直链导致「网络错误」）：
// StrictMode 下渲染完整预览弹窗，mock fetch 链路（copy-links 返回跨源预签名直链 →
// 必须回退一次性令牌 → blob），断言 <img> 最终以 blob: 地址加载且不弹「网络错误」toast。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { PreviewModal } from './preview';
import type { FileListItem } from '@shared/types';

vi.mock('@/lib/i18n', () => ({
  useTranslation: (() => { const t = (k: string) => k; return () => ({ t, i18n: { language: 'zh' } }); })(),
}));
const { toastCalls } = vi.hoisted(() => ({ toastCalls: [] as Array<{ kind: string; msg: string }> }));
vi.mock('@/components/ui/toast', () => ({
  toast: (kind: string, msg: string) => {
    toastCalls.push({ kind, msg });
  },
  Toaster: () => null,
}));

const CROSS_ORIGIN_DIRECT = 'http://127.0.0.1:9000/picumet/x/a.webp?X-Amz-Signature=abc';
const TOKEN_URL = 'http://localhost:5173/api/gateway/download/tok123';

function file(over: Partial<FileListItem> = {}): FileListItem {
  return {
    id: 'f1', name: 'a.webp', path: '/x', type: 'file', size: 10,
    hasPassword: false, visibility: 'private', reviewStatus: 'approved',
    guestVisibility: null, ownerId: 'u1', createdAt: 1, updatedAt: 1,
    ...over,
  } as FileListItem;
}

function mockFetchChain() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/copy-links')) {
      return new Response(JSON.stringify({ success: true, data: { formats: { direct: CROSS_ORIGIN_DIRECT }, needsPassword: false } }), { status: 200 });
    }
    if (url.includes('/api/files/') && url.endsWith('/download')) {
      return new Response(JSON.stringify({ success: true, data: { url: TOKEN_URL } }), { status: 200 });
    }
    if (url === TOKEN_URL) {
      // 一次性令牌：首次 200 出字节；重复消费 401（StrictMode 双跑会暴露竞态）
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/webp' } });
    }
    return new Response('{}', { status: 200 });
  });
}

describe('PreviewModal（StrictMode + 跨源直链回归）', () => {
  beforeEach(() => {
    toastCalls.length = 0;
    vi.stubGlobal('fetch', mockFetchChain());
    vi.stubGlobal('open', vi.fn());
    // jsdom 无 createObjectURL：预览的令牌转 blob 依赖它
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock-1'), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('跨源直链被跳过：回退令牌 → blob，图片最终以 blob: 地址加载，无错误 toast', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <StrictMode>
        <QueryClientProvider client={qc}>
          <PreviewModal file={file()} onClose={() => {}} />
        </QueryClientProvider>
      </StrictMode>
    );
    // 等待 blob 解析完成：<img> 的 src 以 blob: 开头
    await waitFor(
      () => {
        const img = document.querySelector('img');
        expect(img?.getAttribute('src') ?? '').toMatch(/^blob:/);
      },
      { timeout: 3000 }
    );
    expect(toastCalls.filter((c: { msg: string }) => c.msg.includes('err.')).length).toBe(0);
  });

  it('预览不消费 copy-links：一律令牌 → blob（同源/跨源同路径）', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/copy-links')) {
        return new Response(JSON.stringify({ success: true, data: { formats: { direct: 'http://localhost:3000/x/a.webp?sign=tok' }, needsPassword: false } }), { status: 200 });
      }
      if (url.endsWith('/download')) {
        return new Response(JSON.stringify({ success: true, data: { url: TOKEN_URL } }), { status: 200 });
      }
      if (url === TOKEN_URL) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/webp' } });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <StrictMode>
        <QueryClientProvider client={qc}>
          <PreviewModal file={file()} onClose={() => {}} />
        </QueryClientProvider>
      </StrictMode>
    );
    await waitFor(() => {
      const img = document.querySelector('img');
      expect(img?.getAttribute('src') ?? '').toMatch(/^blob:/);
    });
    // copy-links（直链面）不再参与预览：直链在 dev（Vite SPA fallback）与跨源拓扑下不可靠
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/copy-links')).length).toBe(0);
  });

  it('Markdown 文件：原文经 react-markdown 渲染（无空白）', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/copy-links')) {
        return new Response(JSON.stringify({ success: true, data: { formats: { direct: CROSS_ORIGIN_DIRECT }, needsPassword: false } }), { status: 200 });
      }
      if (url.endsWith('/download')) {
        return new Response(JSON.stringify({ success: true, data: { url: TOKEN_URL } }), { status: 200 });
      }
      if (url === TOKEN_URL) {
        return new Response('# 标题\n\n正文 **加粗**', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <StrictMode>
        <QueryClientProvider client={qc}>
          <PreviewModal file={file({ name: 'README.md' })} onClose={() => {}} />
        </QueryClientProvider>
      </StrictMode>
    );
    await waitFor(() => {
      expect(document.querySelector('h1')?.textContent).toBe('标题');
    });
    console.log('BODY>', document.body.innerHTML.slice(0, 1200));
    expect(document.querySelector('strong')?.textContent).toBe('加粗');
  });

  it('TXT 文件：<pre> 文本节点原样展示', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/copy-links')) {
        return new Response(JSON.stringify({ success: true, data: { formats: { direct: CROSS_ORIGIN_DIRECT }, needsPassword: false } }), { status: 200 });
      }
      if (url.endsWith('/download')) {
        return new Response(JSON.stringify({ success: true, data: { url: TOKEN_URL } }), { status: 200 });
      }
      if (url === TOKEN_URL) {
        return new Response('plain <b>text</b>\nline2', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <StrictMode>
        <QueryClientProvider client={qc}>
          <PreviewModal file={file({ name: 'notes.txt' })} onClose={() => {}} />
        </QueryClientProvider>
      </StrictMode>
    );
    await waitFor(() => {
      expect(document.querySelector('pre')?.textContent).toContain('plain <b>text</b>');
    });
  });
});
