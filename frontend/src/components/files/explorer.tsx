// 文件展示：卡片 / 列表 / 批量栏 / 右键菜单
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileListItem } from '@shared/types';
import { MoreVertical, Pencil, Trash2, ArrowRight, Link2, Share2, Lock, Download, Eye, Copy, X, Code } from 'lucide-react';
import { cn, formatBytes, formatDate, isImage, isVideo, isAudio, isCode } from '@/lib/utils';
import { Dropdown, DropdownItem, DropdownSeparator, DropdownLabel } from '@/components/ui/dropdown';
import { Badge, Button } from '@/components/ui/core';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip } from '@/components/ui/tooltip';
import { useTheme } from '@/stores/theme';
import { useFilePreviewUrl, useFolderPreviewFiles } from './data';
import FileIcon from './FileIcon';

export type ViewMode = 'grid' | 'list' | 'tree';

export interface FileActionHandlers {
  onOpen: (f: FileListItem) => void;
  onDownload: (f: FileListItem) => void;
  onRename: (f: FileListItem) => void;
  onDelete: (f: FileListItem) => void;
  onMove: (f: FileListItem) => void;
  onShare: (f: FileListItem) => void;
  onCopyLink: (f: FileListItem, format?: 'direct' | 'html' | 'markdown', signed?: boolean) => void;
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
  sort,
  order,
}: {
  f: FileListItem;
  selected: boolean;
  onSelect: () => void;
  onDoubleClick: () => void;
  onContext: (e: React.MouseEvent) => void;
  onSingleClick?: (e: React.MouseEvent, f: FileListItem) => void;
  handlers?: FileActionHandlers;
  multiSelect?: boolean;
  sort?: string;
  order?: string;
}) {
  const isFolder = f.type === 'folder';
  const [hovering, setHovering] = useState(false);
  const { t } = useTranslation();
  const previewUrl = useFilePreviewUrl(f);
  const folderPreview = useTheme((s) => s.folderPreview);
  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onDoubleClick={f.banned ? undefined : onDoubleClick}
      onContextMenu={onContext}
      onClick={(e) => {
        e.stopPropagation();
        if (onSingleClick) onSingleClick(e, f);
        else onSelect();
      }}
      data-file-id={f.id}
      data-file-card=""
      title={f.banned ? t('files.bannedTitle') : undefined}
      className={cn(
        // 三态统一：rest 无填充无轮廓 → hover 轻微填充+轮廓 → selected 主色填充（对齐列表）
        'item-surface group relative cursor-pointer rounded-lg border p-3',
        selected && 'item-surface-selected',
        // 封禁文件：置灰半透明，仅保留删除入口
        f.banned && 'opacity-40 grayscale'
      )}
      style={selected && f.customColor ? { borderColor: f.customColor } : undefined}
    >
      {/* 复选框 - 左上角 */}
      <div className="absolute left-2 top-2 z-10">
        <Checkbox
          checked={selected}
          onChange={onSelect}
          className={cn('lasso-item-dot transition-opacity', multiSelect || selected || hovering ? 'opacity-100' : 'opacity-0')}
          label={f.name}
        />
      </div>

      {/* 右上角三点菜单 - hover 显示（与复选框一致） */}
      {handlers && (
        <div
          className={cn(
            'absolute right-1.5 top-1.5 z-20 transition-opacity',
            'opacity-100'
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <FileRowMenu f={f} handlers={handlers} />
        </div>
      )}

      {f.hasPassword && !isFolder && (
        <span className={cn('absolute top-2 rounded-full bg-muted p-1 text-muted-foreground', handlers ? 'right-8' : 'right-2')}>
          <Lock className="h-3 w-3" />
        </span>
      )}

      <div className="mb-2 flex h-16 items-center justify-center">
        {isFolder && folderPreview === 'contents' ? (
          <FolderPreviewGrid f={f} sort={sort} order={order} />
        ) : isVideo(f.name) ? (
          <VideoThumb f={f} />
        ) : (
          <FileIcon
            name={f.name}
            type={isFolder ? 'folder' : 'file'}
            className="h-12 w-12"
            src={previewUrl}
            preview
            iconEmoji={f.iconEmoji}
          />
        )}
      </div>
      <p className={cn('truncate text-center text-sm', selected && 'font-medium')}>
        {f.customTitle ?? f.name}
      </p>
      {!isFolder && <p className="mt-0.5 text-center text-xs text-muted-foreground">{formatBytes(f.size)}</p>}
    </div>
  );
}

// ============ 视频缩略图（前端 canvas 抽帧，参考 OpenList 的 video snapshot 思路） ============
function VideoThumb({ f, className = 'h-12 w-12' }: { f: FileListItem; className?: string }) {
  const src = useFilePreviewUrl(f);
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    let captured = false;
    const video = document.createElement('video');
    video.src = src;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';
    const capture = () => {
      if (captured || cancelled) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 160;
        canvas.height = video.videoHeight || 120;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        setThumb(canvas.toDataURL('image/jpeg', 0.7));
        captured = true;
      } catch {
        /* 跨域/解码失败时静默回退到图标 */
      }
    };
    const onLoadedData = () => {
      capture(); // 先抓当前帧（通常为视频首帧）
      try {
        // 尝试 seek 到 20% 处（OpenList 默认 VideoThumbPos=20%），非 seekable 时被钳到 0 也不影响
        const t = Math.min(1, (video.duration || 5) * 0.2);
        video.currentTime = t;
      } catch {
        /* ignore */
      }
    };
    const onSeeked = () => capture();
    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', () => {});
    video.load();
    return () => {
      cancelled = true;
      video.removeAttribute('src');
      video.load();
    };
  }, [src]);

  if (thumb) {
    return <img src={thumb} alt={f.name} className={cn('rounded object-cover', className)} />;
  }
  return <FileIcon name={f.name} type="file" className={className} iconEmoji={f.iconEmoji} />;
}

// ============ 文件夹内部预览格：按当前排序取前 4 项，图标/缩略图按类型渲染 ============
function ThumbCell({ item }: { item: FileListItem }) {
  if (item.type === 'folder') {
    return <FileIcon name={item.name} type="folder" className="h-8 w-8" iconEmoji={item.iconEmoji} />;
  }
  if (isImage(item.name)) {
    const url = useFilePreviewUrl(item);
    if (url) return <img src={url} alt={item.name} className="h-full w-full object-cover" loading="lazy" />;
    return <FileIcon name={item.name} type="file" className="h-8 w-8" iconEmoji={item.iconEmoji} />;
  }
  if (isVideo(item.name)) {
    return <VideoThumb f={item} className="h-full w-full rounded-none" />;
  }
  return <FileIcon name={item.name} type="file" className="h-8 w-8" iconEmoji={item.iconEmoji} />;
}

function FolderPreviewGrid({ f, sort, order }: { f: FileListItem; sort?: string; order?: string }) {
  const { data } = useFolderPreviewFiles(f.path, { sort, order });
  const items = (data ?? []).slice(0, 4);
  if (items.length === 0) {
    return <FileIcon name={f.name} type="folder" className="h-12 w-12" />;
  }
  return (
    <div className="grid h-16 w-16 grid-cols-2 gap-0.5 overflow-hidden rounded-lg border bg-muted/40">
      {items.map((it) => (
        <ThumbCell key={it.id} item={it} />
      ))}
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
  const { t } = useTranslation();
  const previewUrl = useFilePreviewUrl(f);
  return (
    <div
      onDoubleClick={f.banned ? undefined : onDoubleClick}
      onContextMenu={onContext}
      onClick={(e) => {
        e.stopPropagation();
        if (onSingleClick) onSingleClick(e, f);
        else onSelect();
      }}
      data-file-id={f.id}
      data-file-row=""
      title={f.banned ? t('files.bannedTitle') : undefined}
      className={cn(
        // 列顺序：复选框 | 名称(1fr 吸收全部余量) | 大小 | 日期(sm+) | 菜单
        // 大小/日期列由 1fr 名称列推向右侧，位置不随菜单列内容变化，保证行间对齐
        // 三态与卡片共用 item-surface（rest → hover → selected）
        'item-surface group grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md border px-3 py-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)_100px_130px_auto]',
        selected && 'item-surface-selected',
        // 封禁文件：置灰半透明，仅保留删除入口
        f.banned && 'opacity-40 grayscale'
      )}
    >
      {/* 复选框列 */}
      <Checkbox
        checked={selected}
        onChange={onSelect}
        className={cn('lasso-item-dot transition-opacity', multiSelect || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
        label={f.name}
      />

      <div className="flex min-w-0 items-center gap-2">
        {isFolder ? (
          <FileIcon name={f.name} type="folder" className="h-5 w-5 shrink-0" iconEmoji={f.iconEmoji} />
        ) : (
          <FileIcon name={f.name} type="file" className="h-5 w-5 shrink-0" src={previewUrl} preview iconEmoji={f.iconEmoji} />
        )}
        <span className="truncate">{f.customTitle ?? f.name}</span>
        {f.hasPassword && !isFolder && <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        {f.customColor && <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: f.customColor }} />}
      </div>
      <span className="truncate text-right text-muted-foreground sm:text-right">{isFolder ? '-' : formatBytes(f.size)}</span>
      <span className="hidden truncate text-muted-foreground sm:block">{formatDate(f.updatedAt)}</span>
      <div className="flex items-center justify-end">
        {handlers && <FileRowMenu f={f} handlers={handlers} />}
      </div>
    </div>
  );
}

// ============ 行内菜单 ============
export function FileRowMenuItems({ f, handlers, onClose }: { f: FileListItem; handlers?: FileActionHandlers; onClose?: () => void }) {
  const { t } = useTranslation();
  const isFolder = f.type === 'folder';
  const close = onClose ?? (() => {});
  // 封禁文件：菜单直接不渲染除删除外的任何项（而非渲染后禁用）
  if (f.banned) {
    if (!handlers?.onDelete) return null;
    return (
      <DropdownItem danger icon={<Trash2 className="h-4 w-4" />} onClick={() => { handlers.onDelete!(f); close(); }}>
        {t('common.delete')}
      </DropdownItem>
    );
  }
  return (
        <>
          {handlers?.onOpen && (
            <DropdownItem icon={<Eye className="h-4 w-4" />} onClick={() => { handlers.onOpen!(f); close(); }}>
              {isFolder ? t('files.open') : t('common.preview')}
            </DropdownItem>
          )}
          {handlers?.onDownload && !isFolder && (
            <DropdownItem icon={<Download className="h-4 w-4" />} onClick={() => { handlers.onDownload!(f); close(); }}>
              {t('common.download')}
            </DropdownItem>
          )}
          {handlers?.onCopyLink && !isFolder && (
            <DropdownItem icon={<Copy className="h-4 w-4" />} onClick={() => { handlers.onCopyLink!(f); close(); }}>
              {t('files.copyLink')}
            </DropdownItem>
          )}
          {handlers?.onShare && (
            <DropdownItem icon={<Share2 className="h-4 w-4" />} onClick={() => { handlers.onShare!(f); close(); }}>
              {t('common.share')}
            </DropdownItem>
          )}
          <DropdownSeparator />
          {handlers?.onRename && (
            <DropdownItem icon={<Pencil className="h-4 w-4" />} onClick={() => { handlers.onRename!(f); close(); }}>
              {t('common.rename')}
            </DropdownItem>
          )}
          {handlers?.onMove && (
            <DropdownItem icon={<ArrowRight className="h-4 w-4" />} onClick={() => { handlers.onMove!(f); close(); }}>
              {t('files.moveTo')}
            </DropdownItem>
          )}
          {handlers?.onSetPassword && !isFolder && (
            <DropdownItem icon={<Link2 className="h-4 w-4" />} onClick={() => { handlers.onSetPassword!(f); close(); }}>
              {t('files.setPassword')}
            </DropdownItem>
          )}
          {handlers?.onProperties && (
            <DropdownItem icon={<Eye className="h-4 w-4" />} onClick={() => { handlers.onProperties!(f); close(); }}>
              {t('common.properties')}
            </DropdownItem>
          )}
          <DropdownSeparator />
          {handlers?.onDelete && (
            <DropdownItem danger icon={<Trash2 className="h-4 w-4" />} onClick={() => { handlers.onDelete!(f); close(); }}>
              {t('common.delete')}
            </DropdownItem>
          )}
        </>
  );
}

// ============ 批量操作栏 ============
export function BulkActionsBar({
  count,
  onMove,
  onDelete,
  onClear,
  onDownload,
  onShare,
  onCopyLink,
  onRename,
  onProperties,
  onlyDelete,
}: {
  count: number;
  onMove: () => void;
  onDelete: () => void;
  onClear: () => void;
  onDownload?: () => void;
  onShare?: () => void;
  onCopyLink?: () => void;
  onRename?: () => void;
  onProperties?: () => void;
  onlyDelete?: boolean;
}) {
  const { t } = useTranslation();
  const isSingle = count === 1;

  const actions = [
    { key: 'download', icon: Download, label: t('common.download'), onClick: onDownload, show: !!onDownload },
    { key: 'share', icon: Share2, label: t('common.share'), onClick: onShare, show: !!onShare },
    { key: 'copyLink', icon: Copy, label: t('files.copyLink'), onClick: onCopyLink, show: !!onCopyLink },
    { key: 'move', icon: ArrowRight, label: t('common.move'), onClick: onMove, show: true },
    { key: 'rename', icon: Pencil, label: t('common.rename'), onClick: onRename, show: !!onRename && isSingle },
    { key: 'delete', icon: Trash2, label: t('common.delete'), onClick: onDelete, show: true, danger: true },
    { key: 'properties', icon: Eye, label: t('common.properties'), onClick: onProperties, show: !!onProperties && isSingle },
  ].filter((a) => a.show && (!onlyDelete || a.key === 'delete'));

  return (
    <div className="glass-surface glass-blur animate-slide-in-from-bottom inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-sm shadow-xl sm:gap-1.5">
      <Badge variant="secondary" className="shrink-0 whitespace-nowrap">
        <span className="sm:hidden">{count}</span>
        <span className="hidden sm:inline">{t('files.selected', { count })}</span>
      </Badge>
      <div className="mx-1 hidden h-4 w-px bg-border sm:block" />

      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <Tooltip key={action.key} content={action.label} side="top">
            <Button
              variant={action.danger ? 'destructive' : 'ghost'}
              size="icon"
              onClick={action.onClick}
              className="h-8 w-8 rounded-md"
              aria-label={action.label}
            >
              <Icon className="h-4 w-4" />
            </Button>
          </Tooltip>
        );
      })}

      <Tooltip content={t('files.deselect')} side="top">
        <Button
          variant="ghost"
          size="icon"
          onClick={onClear}
          className="h-8 w-8 rounded-md"
          aria-label={t('files.deselect')}
        >
          <X className="h-4 w-4" />
        </Button>
      </Tooltip>
    </div>
  );
}

// 卡片三点菜单：Dropdown 包裹同一套动作项
export function FileRowMenu({ f, handlers }: { f: FileListItem; handlers?: FileActionHandlers }) {
  return (
    <Dropdown
      align="end"
      trigger={
        <button className="glass-control rounded bg-card/[var(--glass-alpha,0.72)] p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <MoreVertical className="h-4 w-4" />
        </button>
      }
    >
      {(close) => <FileRowMenuItems f={f} handlers={handlers} onClose={close} />}
    </Dropdown>
  );
}

// 类型守卫复用
export { isImage, isVideo, isAudio, isCode };
