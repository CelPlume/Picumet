// 文件页虚拟根目录项（vroot:）门禁：仅可导航，不进入选择/多选，也不提供操作入口。
// 数据层整体替换为固定 fixtures：这里验证的是页面接线（点击导航、全选作用域），不是取数。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { FileListItem } from '@shared/types';

const navigate = vi.fn();
const mutateAsync = vi.fn().mockResolvedValue(undefined);

vi.mock('react-i18next', async () => {
  // vi.mock 工厂被提升到 import 之前执行，静态导入的 zhCN 在工厂内处于 TDZ，只能动态导入
  const { zhCN: zh } = await import('@/lib/i18n/zh');
  return {
    // i18n 实例在模块加载时调用 use(initReactI18next)，这里给出空实现
    initReactI18next: { type: '3rdParty', init: () => {} },
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        const resolved = key.split('.').reduce<unknown>((node, seg) => {
          if (node && typeof node === 'object') return (node as Record<string, unknown>)[seg];
          return undefined;
        }, zh);
        if (typeof resolved !== 'string') return key;
        return resolved.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(opts?.[name] ?? `{{${name}}}`));
      },
    }),
  };
});

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigate,
    useLocation: () => ({ pathname: '/files', search: '', hash: '', state: null, key: 'test' }),
  };
});

vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// iconify 图标需网络，与门禁无关
vi.mock('@/components/files/FileIcon', () => ({ default: () => null }));

vi.mock('@/components/files/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/files/data')>();
  return {
    ...actual,
    useFilesQuery: () => ({
      data: { items: [virtualFolder, baseFile], pagination: { total: 2, page: 1, limit: 50, pages: 1 }, mount: null },
      isLoading: false,
      error: null,
    }),
    useFilesTreeQuery: () => ({ data: { items: [], truncated: false }, isLoading: false, error: null }),
    useCreateFolder: () => ({ mutateAsync }),
    useRenameFile: () => ({ mutateAsync }),
    useDeleteFile: () => ({ mutateAsync, isPending: false }),
    useMoveFile: () => ({ mutateAsync }),
    useBatchDelete: () => ({ mutateAsync, isPending: false }),
    useCopyLinks: () => ({ mutateAsync }),
    useVerifyPassword: () => ({ mutateAsync, isPending: false }),
  };
});

import Files from './Files';
import { zhCN } from '@/lib/i18n/zh';

const baseFile: FileListItem = {
  id: '3f2a-file',
  name: 'a.txt',
  path: '/',
  type: 'file',
  size: 10,
  hasPassword: false,
  visibility: 'private',
  reviewStatus: 'approved',
  guestVisibility: null,
  ownerId: 'u1',
  createdAt: 0,
  updatedAt: 0,
};

/** 合成根虚拟目录项：无 file_metadata 行，id=`vroot:<全路径>` */
const virtualFolder: FileListItem = {
  ...baseFile,
  id: 'vroot:/storage1',
  name: 'storage1',
  path: '/storage1',
  type: 'folder',
  size: 0,
};

// jsdom 缺失的浏览器 API：文件页用它做手机端断点与元素测量
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('文件页虚拟根目录项门禁', () => {
  it('虚拟项卡片：无复选框与操作菜单，单击进入该路径而不选中', () => {
    const { container } = render(<Files />);
    const card = container.querySelector('[data-file-id="vroot:/storage1"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.querySelector('[role="checkbox"]')).toBeNull();
    expect(card.querySelectorAll('button')).toHaveLength(0);
    fireEvent.click(card);
    expect(navigate).toHaveBeenCalledWith('/files/storage1');
    // 未产生选择 → 批量操作栏不出现
    expect(screen.queryByLabelText(zhCN.files.deselect)).toBeNull();
  });

  it('全选只作用于可操作条目：虚拟项不计入选择数', () => {
    render(<Files />);
    fireEvent.click(screen.getByRole('button', { name: zhCN.files.select }));
    fireEvent.click(screen.getByRole('button', { name: zhCN.files.batchSelect }));
    fireEvent.click(screen.getByRole('button', { name: zhCN.files.selectAll }));
    // fixtures 共 2 项，其中 1 项是虚拟目录项，全选后只应选中 1 项
    expect(screen.getByText(zhCN.files.selected.replace('{{count}}', '1'))).toBeInTheDocument();
  });

  it('右键虚拟项：菜单只剩导航项，点击后进入该路径', () => {
    const { container } = render(<Files />);
    const card = container.querySelector('[data-file-id="vroot:/storage1"]') as HTMLElement;
    fireEvent.contextMenu(card);
    expect(screen.queryByText(zhCN.common.delete)).toBeNull();
    expect(screen.queryByText(zhCN.common.rename)).toBeNull();
    expect(screen.queryByText(zhCN.common.share)).toBeNull();
    expect(screen.queryByText(zhCN.common.properties)).toBeNull();
    fireEvent.click(screen.getByText(zhCN.files.open));
    expect(navigate).toHaveBeenCalledWith('/files/storage1');
  });
});
