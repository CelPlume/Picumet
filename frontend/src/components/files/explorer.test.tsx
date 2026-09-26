// 合成根虚拟目录项（id 前缀 vroot:）前端门禁：仅允许导航进入其路径，
// 不进入选择/多选，也不提供重命名/移动/删除/属性/复制链接/分享等操作入口。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { FileListItem } from '@shared/types';
import { zhCN } from '@/lib/i18n/zh';
import { isVirtualRootItem, operableFileIds } from '@/lib/utils';

vi.mock('react-i18next', async () => {
  // vi.mock 工厂被提升到文件顶层 import 之前执行，静态导入的 zhCN 在工厂内处于 TDZ，只能动态导入
  const { zhCN: zh } = await import('@/lib/i18n/zh');
  return {
    useTranslation: () => ({
      t: (key: string) => {
        const resolved = key.split('.').reduce<unknown>((node, seg) => {
          if (node && typeof node === 'object') return (node as Record<string, unknown>)[seg];
          return undefined;
        }, zh);
        return typeof resolved === 'string' ? resolved : key;
      },
    }),
  };
});

// 预览数据源（react-query）与图标（iconify 需网络）与门禁无关，直接替换
vi.mock('./data', () => ({
  useFilePreviewUrl: () => undefined,
  useFolderPreviewFiles: () => ({ data: [] }),
}));
vi.mock('./FileIcon', () => ({ default: () => null }));

import { FileCard, FileRow, FileRowMenuItems, type FileActionHandlers } from './explorer';
import { TreeView } from './TreeView';

// jsdom 不提供 ResizeObserver，TreeView 用它跟踪视口高度，这里给最小桩
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

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

const handlers = (): FileActionHandlers => ({
  onOpen: vi.fn(),
  onDownload: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onMove: vi.fn(),
  onShare: vi.fn(),
  onCopyLink: vi.fn(),
  onProperties: vi.fn(),
  onSetPassword: vi.fn(),
});

describe('虚拟根目录项判定与作用域', () => {
  it('按 id 前缀识别虚拟项，并把它排除在全选/反选作用域外', () => {
    expect(isVirtualRootItem('vroot:/storage1')).toBe(true);
    expect(isVirtualRootItem(virtualFolder)).toBe(true);
    expect(isVirtualRootItem(baseFile)).toBe(false);
    expect(operableFileIds([virtualFolder, baseFile])).toEqual([baseFile.id]);
  });
});

describe('列表行 / 卡片的虚拟项门禁', () => {
  it('虚拟项：无复选框、无操作菜单按钮，单击交给导航回调', () => {
    const h = handlers();
    const onSelect = vi.fn();
    const onSingleClick = vi.fn();
    const { container } = render(
      <FileRow
        f={virtualFolder}
        selected={false}
        onSelect={onSelect}
        onDoubleClick={vi.fn()}
        onContext={() => {}}
        onSingleClick={onSingleClick}
        handlers={h}
      />
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
    fireEvent.click(container.firstElementChild as HTMLElement);
    expect(onSingleClick).toHaveBeenCalledTimes(1);
    expect(onSingleClick.mock.calls[0][1]).toBe(virtualFolder);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('虚拟项卡片：同样无复选框与操作菜单', () => {
    const { container } = render(
      <FileCard
        f={virtualFolder}
        selected={false}
        onSelect={vi.fn()}
        onDoubleClick={vi.fn()}
        onContext={() => {}}
        handlers={handlers()}
      />
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('真实条目：复选框仍可选中，行菜单入口仍在', () => {
    const h = handlers();
    const onSelect = vi.fn();
    const onSingleClick = vi.fn();
    const { container } = render(
      <FileRow
        f={baseFile}
        selected={false}
        onSelect={onSelect}
        onDoubleClick={vi.fn()}
        onContext={() => {}}
        onSingleClick={onSingleClick}
        handlers={h}
      />
    );
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(container.querySelectorAll('button')).toHaveLength(2); // 复选框 + 三点菜单
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSingleClick).not.toHaveBeenCalled();
  });
});

describe('行菜单 / 右键菜单项的虚拟项门禁', () => {
  it('虚拟项：只剩导航项，其余操作项不出现在 DOM 中', () => {
    const h = handlers();
    render(<FileRowMenuItems f={virtualFolder} handlers={h} />);
    fireEvent.click(screen.getByText(zhCN.files.open));
    expect(h.onOpen).toHaveBeenCalledWith(virtualFolder);
    expect(h.onRename).not.toHaveBeenCalled();
    expect(screen.queryByText(zhCN.common.delete)).toBeNull();
    expect(screen.queryByText(zhCN.common.rename)).toBeNull();
    expect(screen.queryByText(zhCN.files.moveTo)).toBeNull();
    expect(screen.queryByText(zhCN.files.copyLink)).toBeNull();
    expect(screen.queryByText(zhCN.files.setPassword)).toBeNull();
    expect(screen.queryByText(zhCN.common.share)).toBeNull();
    expect(screen.queryByText(zhCN.common.properties)).toBeNull();
    expect(screen.queryByText(zhCN.common.download)).toBeNull();
  });

  it('真实条目：操作项保持完整', () => {
    render(<FileRowMenuItems f={baseFile} handlers={handlers()} />);
    expect(screen.getByText(zhCN.common.delete)).toBeInTheDocument();
    expect(screen.getByText(zhCN.common.rename)).toBeInTheDocument();
    expect(screen.getByText(zhCN.files.moveTo)).toBeInTheDocument();
    expect(screen.getByText(zhCN.files.copyLink)).toBeInTheDocument();
    expect(screen.getByText(zhCN.common.share)).toBeInTheDocument();
    expect(screen.getByText(zhCN.common.properties)).toBeInTheDocument();
  });
});

describe('树视图的虚拟项门禁', () => {
  const renderTree = (rows: FileListItem[], onSelect: () => void, onOpenFile: (f: FileListItem) => void, onRowContext: (e: ReactMouseEvent, f: FileListItem) => void) =>
    render(
      <TreeView
        rows={rows}
        currentPath="/"
        selectedId={null}
        onSelect={onSelect}
        onOpenFile={onOpenFile}
        onRowContext={onRowContext}
        renderRight={() => null}
        emptyTitle="empty"
        emptyDesc="empty-desc"
      />
    );

  it('虚拟项：点击进入该路径，不进入选择集、不弹右键菜单', () => {
    const onSelect = vi.fn();
    const onOpenFile = vi.fn();
    const onRowContext = vi.fn();
    renderTree([virtualFolder], onSelect, onOpenFile, onRowContext);
    const row = screen.getByRole('treeitem');
    fireEvent.click(row);
    expect(onOpenFile).toHaveBeenCalledWith(virtualFolder);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.contextMenu(row);
    expect(onRowContext).not.toHaveBeenCalled();
  });

  it('真实文件行：单击仍为选择，右键仍回调', () => {
    const onSelect = vi.fn();
    const onOpenFile = vi.fn();
    const onRowContext = vi.fn();
    renderTree([baseFile], onSelect, onOpenFile, onRowContext);
    const row = screen.getByRole('treeitem');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(baseFile);
    expect(onOpenFile).not.toHaveBeenCalled();
    fireEvent.contextMenu(row);
    expect(onRowContext).toHaveBeenCalled();
  });
});
