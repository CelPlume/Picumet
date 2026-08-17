// 文件展示：卡片 / 列表 / 批量栏 / 右键菜单
import type { FileListItem } from '@shared/types';
import { Folder, FileText, MoreVertical, Pencil, Trash2, ArrowRight, Link2, Share2, Lock, Download, Eye, Copy } from 'lucide-react';
import { cn, formatBytes, formatDate, fileIconEmoji, isImage, isVideo, isAudio, isCode } from '@/lib/utils';
import { Dropdown, DropdownItem, DropdownSeparator } from '@/components/ui/dropdown';
import { Badge } from '@/components/ui/core';

export type ViewMode = 'grid' | 'list';

export interface FileActionHandlers {
  onOpen: (f: FileListItem) => void;
  onDownload: (f: FileListItem) => void;
  onRename: (f: FileListItem) => void;
  onDelete: (f: FileListItem) => void;
  onMove: (f: FileListItem) => void;
  onShare: (f: FileListItem) => void;
  onCopyLink: (f: FileListItem) => void;
  onProperties: (f: FileListItem) => void;
  onSetPassword: (f: FileListItem) => void;
}

// ============ 卡片项 ============
export function FileCard({
  f,
  selected,
  onSelect,
  onDoubleClick,
  onContext,
}: {
  f: FileListItem;
  selected: boolean;
  onSelect: () => void;
  onDoubleClick: () => void;
  onContext: (e: React.MouseEvent) => void;
}) {
  const isFolder = f.type === 'folder';
  return (
    <div
      onDoubleClick={onDoubleClick}
      onContextMenu={onContext}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      className={cn(
        'group relative cursor-pointer rounded-lg border p-3 transition-all hover:shadow-md',
        selected ? 'border-primary bg-primary/5' : 'border-border bg-card'
      )}
      style={f.customColor ? { borderColor: f.customColor } : undefined}
    >
      {f.hasPassword && !isFolder && (
        <span className="absolute right-2 top-2 rounded-full bg-muted p-1 text-muted-foreground">
          <Lock className="h-3 w-3" />
        </span>
      )}
      <div className="mb-2 flex h-14 items-center justify-center text-4xl">
        {isFolder ? (
          <Folder className="h-12 w-12 text-sky-500" fill="currentColor" />
        ) : f.customTitle || f.customColor ? (
          <span className="text-4xl">{f.iconEmoji ?? fileIconEmoji(f.name, 'file')}</span>
        ) : (
          <span className="text-4xl">{f.iconEmoji ?? fileIconEmoji(f.name, 'file')}</span>
        )}
      </div>
      <p className={cn('truncate text-center text-sm', selected && 'font-medium')}>
        {f.customTitle ?? f.name}
      </p>
      {!isFolder && <p className="mt-0.5 text-center text-xs text-muted-foreground">{formatBytes(f.size)}</p>}
      {selected && (
        <span className="absolute left-2 top-2 flex h-4 w-4 items-center justify-center rounded-sm bg-primary text-[10px] text-primary-foreground">
          ✓
        </span>
      )}
    </div>
  );
}

// ============ 列表行 ============
export function FileRow({
  f,
  selected,
  onSelect,
  onDoubleClick,
  onContext,
}: {
  f: FileListItem;
  selected: boolean;
  onSelect: () => void;
  onDoubleClick: () => void;
  onContext: (e: React.MouseEvent) => void;
}) {
  const isFolder = f.type === 'folder';
  return (
    <div
      onDoubleClick={onDoubleClick}
      onContextMenu={onContext}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      className={cn(
        'grid cursor-pointer grid-cols-[1fr_120px_140px_120px] items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
        selected ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-accent'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {isFolder ? (
          <Folder className="h-5 w-5 shrink-0 text-sky-500" fill="currentColor" />
        ) : (
          <span className="shrink-0 text-lg leading-none">{f.iconEmoji ?? fileIconEmoji(f.name, 'file')}</span>
        )}
        <span className="truncate">{f.customTitle ?? f.name}</span>
        {f.hasPassword && !isFolder && <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </div>
      <span className="truncate text-muted-foreground">{isFolder ? '-' : formatBytes(f.size)}</span>
      <span className="truncate text-muted-foreground">{formatDate(f.updatedAt)}</span>
      <div className="flex items-center justify-end gap-1">
        {f.customColor && <span className="h-3 w-3 rounded-full" style={{ background: f.customColor }} />}
        <FileRowMenu f={f} />
      </div>
    </div>
  );
}

// ============ 行内菜单 ============
export function FileRowMenu({ f, handlers }: { f: FileListItem; handlers?: FileActionHandlers }) {
  const isFolder = f.type === 'folder';
  return (
    <Dropdown
      trigger={
        <button className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100">
          <MoreVertical className="h-4 w-4" />
        </button>
      }
      triggerClass="group"
    >
      {(close) => (
        <>
          {handlers?.onOpen && (
            <DropdownItem icon={<Eye className="h-4 w-4" />} onClick={() => { handlers.onOpen!(f); close(); }}>
              {isFolder ? '打开' : '预览'}
            </DropdownItem>
          )}
          {handlers?.onDownload && !isFolder && (
            <DropdownItem icon={<Download className="h-4 w-4" />} onClick={() => { handlers.onDownload!(f); close(); }}>
              下载
            </DropdownItem>
          )}
          {handlers?.onCopyLink && !isFolder && (
            <DropdownItem icon={<Copy className="h-4 w-4" />} onClick={() => { handlers.onCopyLink!(f); close(); }}>
              复制链接
            </DropdownItem>
          )}
          {handlers?.onShare && (
            <DropdownItem icon={<Share2 className="h-4 w-4" />} onClick={() => { handlers.onShare!(f); close(); }}>
              分享
            </DropdownItem>
          )}
          <DropdownSeparator />
          {handlers?.onRename && (
            <DropdownItem icon={<Pencil className="h-4 w-4" />} onClick={() => { handlers.onRename!(f); close(); }}>
              重命名
            </DropdownItem>
          )}
          {handlers?.onMove && (
            <DropdownItem icon={<ArrowRight className="h-4 w-4" />} onClick={() => { handlers.onMove!(f); close(); }}>
              移动到...
            </DropdownItem>
          )}
          {handlers?.onSetPassword && !isFolder && (
            <DropdownItem icon={<Link2 className="h-4 w-4" />} onClick={() => { handlers.onSetPassword!(f); close(); }}>
              设置密码
            </DropdownItem>
          )}
          {handlers?.onProperties && (
            <DropdownItem icon={<FileText className="h-4 w-4" />} onClick={() => { handlers.onProperties!(f); close(); }}>
              属性
            </DropdownItem>
          )}
          <DropdownSeparator />
          {handlers?.onDelete && (
            <DropdownItem danger icon={<Trash2 className="h-4 w-4" />} onClick={() => { handlers.onDelete!(f); close(); }}>
              删除
            </DropdownItem>
          )}
        </>
      )}
    </Dropdown>
  );
}

// ============ 批量操作栏 ============
export function BulkActionsBar({
  count,
  onMove,
  onDelete,
  onClear,
}: {
  count: number;
  onMove: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
      <Badge variant="secondary">已选 {count} 项</Badge>
      <div className="flex-1" />
      <button onClick={onMove} className="flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground">
        <ArrowRight className="h-4 w-4" /> 移动
      </button>
      <button onClick={onDelete} className="flex items-center gap-1 rounded-md px-2 py-1 text-destructive hover:bg-destructive/10">
        <Trash2 className="h-4 w-4" /> 删除
      </button>
      <button onClick={onClear} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground">
        取消选择
      </button>
    </div>
  );
}

// 类型守卫复用
export { isImage, isVideo, isAudio, isCode };
