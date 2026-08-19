// 文件展示：卡片 / 列表 / 批量栏 / 右键菜单
import { useState } from 'react';
import type { FileListItem } from '@shared/types';
import { MoreVertical, Pencil, Trash2, ArrowRight, Link2, Share2, Lock, Download, Eye, Copy } from 'lucide-react';
import { cn, formatBytes, formatDate, isImage, isVideo, isAudio, isCode } from '@/lib/utils';
import { Dropdown, DropdownItem, DropdownSeparator } from '@/components/ui/dropdown';
import { Badge, Button } from '@/components/ui/core';
import { Checkbox } from '@/components/ui/checkbox';
import FileIcon from './FileIcon';

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
  onSingleClick,
  handlers,
  multiSelect,
}: {
  f: FileListItem;
  selected: boolean;
  onSelect: () => void;
  onDoubleClick: () => void;
  onContext: (e: React.MouseEvent) => void;
  onSingleClick?: (e: React.MouseEvent, f: FileListItem) => void;
  handlers?: FileActionHandlers;
  multiSelect?: boolean;
}) {
  const isFolder = f.type === 'folder';
  const [hovering, setHovering] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContext}
      onClick={(e) => {
        e.stopPropagation();
        if (onSingleClick) onSingleClick(e, f);
        else onSelect();
      }}
      className={cn(
        'group relative cursor-pointer rounded-lg border p-3 transition-all duration-150 hover:shadow-md',
        selected ? 'border-primary bg-primary/5' : 'border-border bg-card'
      )}
      style={f.customColor ? { borderColor: f.customColor } : undefined}
    >
      {/* 复选框 - 左上角 */}
      <div className="absolute left-2 top-2 z-10">
        <Checkbox
          checked={selected}
          onChange={onSelect}
          className={cn('transition-opacity', multiSelect || selected || hovering ? 'opacity-100' : 'opacity-0')}
          label={f.name}
        />
      </div>

      {f.hasPassword && !isFolder && (
        <span className="absolute right-2 top-2 rounded-full bg-muted p-1 text-muted-foreground">
          <Lock className="h-3 w-3" />
        </span>
      )}

      {/* 悬停操作按钮组 - 卡片底部居中（多选模式隐藏） */}
      {!multiSelect && handlers && (
        <div
          className="absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-md border bg-background/95 p-1 opacity-0 shadow-lg backdrop-blur-sm transition-all scale-90 group-hover:opacity-100 group-hover:scale-100"
          onClick={(e) => e.stopPropagation()}
        >
          {!isFolder && (
            <button
              onClick={(e) => { e.stopPropagation(); handlers.onDownload(f); }}
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="下载"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); handlers.onShare(f); }}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="分享"
          >
            <Share2 className="h-3.5 w-3.5" />
          </button>
          {!isFolder && (
            <button
              onClick={(e) => { e.stopPropagation(); handlers.onCopyLink(f); }}
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="复制链接"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); handlers.onMove(f); }}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="移动"
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handlers.onRename(f); }}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="重命名"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handlers.onDelete(f); }}
            className="rounded p-1.5 text-destructive hover:bg-destructive/10"
            title="删除"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handlers.onProperties(f); }}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="属性"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="mb-2 flex h-14 items-center justify-center">
        <FileIcon
          name={f.name}
          type={isFolder ? 'folder' : 'file'}
          className={isFolder ? 'h-12 w-12 text-sky-500' : 'h-12 w-12 text-muted-foreground'}
          src={f.coverUrl}
          preview
        />
      </div>
      <p className={cn('truncate text-center text-sm', selected && 'font-medium')}>
        {f.customTitle ?? f.name}
      </p>
      {!isFolder && <p className="mt-0.5 text-center text-xs text-muted-foreground">{formatBytes(f.size)}</p>}
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
  onSingleClick,
  handlers,
  multiSelect,
}: {
  f: FileListItem;
  selected: boolean;
  onSelect: () => void;
  onDoubleClick: () => void;
  onContext: (e: React.MouseEvent) => void;
  onSingleClick?: (e: React.MouseEvent, f: FileListItem) => void;
  handlers?: FileActionHandlers;
  multiSelect?: boolean;
}) {
  const isFolder = f.type === 'folder';
  return (
    <div
      onDoubleClick={onDoubleClick}
      onContextMenu={onContext}
      onClick={(e) => {
        e.stopPropagation();
        if (onSingleClick) onSingleClick(e, f);
        else onSelect();
      }}
      className={cn(
        'group grid cursor-pointer grid-cols-[auto_1fr_100px_130px_auto] items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors',
        selected ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-accent'
      )}
    >
      {/* 复选框列 */}
      <Checkbox
        checked={selected}
        onChange={onSelect}
        className={cn('transition-opacity', multiSelect || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
        label={f.name}
      />

      <div className="flex min-w-0 items-center gap-2">
        {isFolder ? (
          <FileIcon name={f.name} type="folder" className="h-5 w-5 shrink-0 text-sky-500" />
        ) : (
          <FileIcon name={f.name} type="file" className="h-5 w-5 shrink-0 text-muted-foreground" src={f.coverUrl} preview />
        )}
        <span className="truncate">{f.customTitle ?? f.name}</span>
        {f.hasPassword && !isFolder && <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </div>
      <span className="truncate text-muted-foreground">{isFolder ? '-' : formatBytes(f.size)}</span>
      <span className="hidden truncate text-muted-foreground sm:block">{formatDate(f.updatedAt)}</span>
      <div className="flex items-center justify-end gap-1">
        {f.customColor && <span className="h-3 w-3 rounded-full" style={{ background: f.customColor }} />}
        {handlers && !multiSelect && (
          <>
            {!isFolder && (
              <button
                onClick={(e) => { e.stopPropagation(); handlers.onDownload!(f); }}
                className="rounded p-1.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground"
                title="下载"
              >
                <Download className="h-4 w-4" />
              </button>
            )}
            {handlers.onShare && (
              <button
                onClick={(e) => { e.stopPropagation(); handlers.onShare!(f); }}
                className="rounded p-1.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground"
                title="分享"
              >
                <Share2 className="h-4 w-4" />
              </button>
            )}
            <FileRowMenu f={f} handlers={handlers} />
          </>
        )}
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
        <button className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <MoreVertical className="h-4 w-4" />
        </button>
      }
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
            <DropdownItem icon={<Eye className="h-4 w-4" />} onClick={() => { handlers.onProperties!(f); close(); }}>
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
    <div className="animate-scale-in flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-lg">
      <Badge variant="secondary">已选 {count} 项</Badge>
      <div className="flex-1" />
      <Button variant="outline" size="sm" onClick={onMove}>
        <ArrowRight className="h-4 w-4" /> 移动
      </Button>
      <Button variant="destructive" size="sm" onClick={onDelete}>
        <Trash2 className="h-4 w-4" /> 删除
      </Button>
      <Button variant="ghost" size="sm" onClick={onClear}>
        取消选择
      </Button>
    </div>
  );
}

// 类型守卫复用
export { isImage, isVideo, isAudio, isCode };
