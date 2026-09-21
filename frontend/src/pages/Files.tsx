// 文件管理器主页面
import { useCallback, useEffect, useMemo, useRef, useState , useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Upload, FolderPlus, LayoutGrid, List as ListIcon, ChevronRight,
  Folder, Search, CheckSquare, ChevronDown, ArrowRightLeft, X, Check, MoreHorizontal,
} from 'lucide-react';
import { FileGridSkeleton, FileListSkeleton } from '@/components/ui/skeleton';
import { useLassoSelect } from '@/components/files/lasso';
import { useTheme } from '@/stores/theme';
import { FileTree } from '@/components/files/FileTree';
import { Button, Input, EmptyState, Dialog, ConfirmDialog, Spinner, Switch, SEARCH_INPUT_GLASS } from '@/components/ui/core';
import { AppShell } from '@/components/layout/AppShell';
import { SortableHeader } from '@/components/ui/sortable-header';
import { Pagination } from '@/components/ui/pagination';
import { Drawer } from '@/components/ui/drawer';
import { Dropdown, DropdownItem, DropdownLabel, DropdownSeparator } from '@/components/ui/dropdown';
import { toast } from '@/components/ui/toast';
import { useFilesQuery, useCreateFolder, useRenameFile, useDeleteFile, useMoveFile, useBatchDelete, useCopyLinks, type CopyLinksMutator } from '@/components/files/data';
import { FileCard, FileRow, BulkActionsBar, FileRowMenuItems, type ViewMode, type FileActionHandlers } from '@/components/files/explorer';
import { UploadModal } from '@/components/files/UploadModal';
import { ShareDialog } from '@/components/files/ShareDialog';
import { PreviewModal } from '@/components/files/preview';
import { PropertiesPanel } from '@/components/files/PropertiesPanel';
import FileIcon from '@/components/files/FileIcon';
import { normalizeVirtualPath, cn, isImage, isVideo, isAudio, isCode } from '@/lib/utils';
import type { FileListItem } from '@shared/types';

// 排序字段选项；升序/降序在同一下拉内切换（不再是独立按钮）
const SORT_FIELDS = [
  { value: 'name', label: 'files.sortName' },
  { value: 'time', label: 'files.sortTime' },
  { value: 'size', label: 'files.sortSize' },
] as const;

// ============ 复制链接弹窗（含图片/视频时选择格式与签名） ============
function CopyLinksDialog({
  open,
  files,
  onClose,
  copyLinks,
}: {
  open: boolean;
  files: FileListItem[];
  onClose: () => void;
  copyLinks: CopyLinksMutator;
}) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<'direct' | 'html' | 'markdown'>('direct');
  const [signed, setSigned] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  // 每次打开重置选择（保持与旧的条件挂载行为一致）
  useEffect(() => {
    if (open) {
      setFormat('direct');
      setSigned(false);
      setCopied(false);
      setLoading(false);
    }
  }, [open]);

  const doCopy = async () => {
    setLoading(true);
    try {
      const links = await Promise.all(
        files.map(async (f) => {
          const res = await copyLinks.mutateAsync({ id: f.id, signed, expiresIn: signed ? 3600 : undefined });
          if (format === 'html') return res.formats.html;
          if (format === 'markdown') return res.formats.markdown;
          return res.formats.direct.startsWith('http')
            ? res.formats.direct
            : window.location.origin + res.formats.direct;
        })
      );
      await navigator.clipboard.writeText(links.join('\n'));
      setCopied(true);
      toast('success', signed ? t('files.copiedSignedLinks', { count: links.length }) : t('files.copiedLinks', { count: links.length }));
    } catch {
      toast('error', t('files.copyLinkFailed'));
    } finally {
      setLoading(false);
    }
  };

  const formatOptions = [
    { value: 'direct' as const, label: t('files.copyDirect'), desc: t('files.copyDirectDesc') },
    { value: 'html' as const, label: t('files.copyHtmlCode'), desc: '<img src="...">' },
    { value: 'markdown' as const, label: t('files.copyMarkdownCode'), desc: '![name](url)' },
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('files.copyLink')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{copied ? t('common.close') : t('common.cancel')}</Button>
          <Button onClick={() => void doCopy()} loading={loading}>{copied ? `${t('common.copied')} ✓` : t('common.copy')}</Button>
        </>
      }
    >
      <div className="flex min-h-[calc(100vh-14rem)] flex-col gap-4">
        <div className="flex flex-wrap gap-1.5">
          {files.map((f) => (
            <span key={f.id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
              <FileIcon name={f.name} type="file" className="h-3.5 w-3.5" iconEmoji={f.iconEmoji} />
              <span className="max-w-[160px] truncate">{f.name}</span>
            </span>
          ))}
        </div>
        <div className="space-y-1.5">
          {formatOptions.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                setFormat(o.value);
                setCopied(false);
              }}
              className={cn(
                'flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
                format === o.value ? 'border-primary bg-primary/10' : 'border-border hover:bg-foreground/5'
              )}
            >
              <span>
                <span className="block font-medium">{o.label}</span>
                <span className="block text-xs text-muted-foreground">{o.desc}</span>
              </span>
              {format === o.value && <Check className="h-4 w-4 text-primary" />}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <div>
            <p className="text-sm font-medium">{t('files.signedLink')}</p>
            <p className="text-xs text-muted-foreground">{t('files.signedLinkDesc')}</p>
          </div>
          <Switch
            checked={signed}
            onChange={(v) => {
              setSigned(v);
              setCopied(false);
            }}
          />
        </div>
      </div>
    </Dialog>
  );
}

export default function Files() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const routePath = useMemo(() => {
    const rest = location.pathname.replace(/^\/files\/?/, '');
    return normalizeVirtualPath('/' + rest);
  }, [location.pathname]);

  const [path, setPath] = useState(routePath);
  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem('picumet:view') as ViewMode) || 'grid');
  // 卡片视图每行卡片数（个性化设置，4–8，默认 6）
  const filesPerRow = useTheme((st) => st.filesPerRow);
  const [sort, setSort] = useState<string | undefined>();
  // 服务端分页：默认每页 50（路径/筛选/排序变化时回到第一页）
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [multiSelect, setMultiSelect] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  // 条目容器（命中测试 + 指针捕获用）
  const rowRef = useRef<HTMLDivElement>(null);
  // 主列容器即拖拽面：空白处(含网格四周)均可起拖；网格跳过卡片，列表允许从行起拖
  const lasso = useLassoSelect(rowRef, setSelected, {
    skipSelector: '[data-file-card], button, a, input, textarea, [role="checkbox"], [role="menuitem"]',
  });
  const lassoRef = useRef(lasso);
  lassoRef.current = lasso;

  // 拖拽面提升到 AppShell 根容器（main 的父元素）：覆盖公告横幅条、整行、
  // 页面四周留白与内容下方空白，除头部导航外整个页面都能起拖（handlers 经 ref 转发）
  useEffect(() => {
    const surface = rowRef.current?.closest('main')?.parentElement;
    if (!surface) return;
    const down = (e: PointerEvent) => lassoRef.current.onPointerDown(e as unknown as React.PointerEvent);
    const move = (e: PointerEvent) => lassoRef.current.onPointerMove(e as unknown as React.PointerEvent);
    const up = (e: PointerEvent) => lassoRef.current.onPointerUp(e as unknown as React.PointerEvent);
    const cancel = (e: PointerEvent) => lassoRef.current.onPointerCancel(e as unknown as React.PointerEvent);
    const clickCap = (e: MouseEvent) => lassoRef.current.onClickCapture(e as unknown as React.MouseEvent);
    surface.addEventListener('pointerdown', down);
    surface.addEventListener('pointermove', move);
    surface.addEventListener('pointerup', up);
    surface.addEventListener('pointercancel', cancel);
    surface.addEventListener('click', clickCap, true);
    return () => {
      surface.removeEventListener('pointerdown', down);
      surface.removeEventListener('pointermove', move);
      surface.removeEventListener('pointerup', up);
      surface.removeEventListener('pointercancel', cancel);
      surface.removeEventListener('click', clickCap, true);
    };
  }, []);
  const [showUpload, setShowUpload] = useState(false);
  // 文件页整页禁选文本（拖拽多选时原生选择会污染横幅/侧栏，且拖拽起手即选中无法事后阻止）
  useEffect(() => {
    const root = rowRef.current?.closest('main')?.parentElement;
    if (!root) return;
    root.classList.add('select-none');
    return () => root.classList.remove('select-none');
  }, []);
  const [previewFile, setPreviewFile] = useState<FileListItem | null>(null);
  const [propsFile, setPropsFile] = useState<FileListItem | null>(null);
  const [moveTarget, setMoveTarget] = useState<FileListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileListItem | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileListItem | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newFolder, setNewFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [bulkDelete, setBulkDelete] = useState(false);
  const [bulkMove, setBulkMove] = useState(false);
  const [bulkMoveTarget, setBulkMoveTarget] = useState('');
  const [copyDialog, setCopyDialog] = useState<{ files: FileListItem[] } | null>(null);
  // 创建分享：打开对话框时冻结所选条目快照（文件/文件夹混合，可多选）
  const [shareItems, setShareItems] = useState<FileListItem[] | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number; file: FileListItem } | null>(null);
  /** 右键菜单渲染后实测高度：贴底时向上翻转、左右夹紧（视口边缘自适应） */
  const [menuXY, setMenuXY] = useState<{ left: number; top: number } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  // 切换目录时关闭右键菜单并清空选择（批量操作栏随之消失）
  useEffect(() => {
    setMenuPos(null);
    setSelected(new Set());
    setMultiSelect(false);
  }, [path]);

  // 开启非批量弹窗（上传/新建/重命名/删除/移动/属性/预览/复制链接/分享）时清空选择
  useEffect(() => {
    if (showUpload || newFolder || renameTarget || deleteTarget || moveTarget || propsFile || previewFile || copyDialog || shareItems) {
      setSelected(new Set());
      setMultiSelect(false);
      setMenuPos(null);
    }
  }, [showUpload, newFolder, renameTarget, deleteTarget, moveTarget, propsFile, previewFile, copyDialog, shareItems]);

  // 右键菜单渲染后实测尺寸：贴近视口底部 → 向上翻转（菜单底缘贴点击点），左右夹紧防截断
  useLayoutEffect(() => {
    if (!menuPos || !ctxMenuRef.current) { setMenuXY(null); return; }
    const m = ctxMenuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(menuPos.x, vw - m.width - 8));
    let top = menuPos.y;
    if (top + m.height > vh - 8) top = Math.max(8, menuPos.y - m.height - 4);
    setMenuXY({ left, top });
  }, [menuPos]);

  // 右键菜单打开期间：点任意菜单外区域（左键/右键）都关闭——右键其他文件由行处理重新定位
  useEffect(() => {
    if (!menuPos) return;
    const onDown = (e: MouseEvent) => {
      if (ctxMenuRef.current?.contains(e.target as Node)) return;
      setMenuPos(null);
    };
    const onCtx = (e: MouseEvent) => {
      if (ctxMenuRef.current?.contains(e.target as Node)) return;
      setMenuPos(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('contextmenu', onCtx);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('contextmenu', onCtx);
    };
  }, [menuPos]);

  // 点击主列之外（文件树/页边距/顶栏等空白处）清空选择
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (contentRef.current?.contains(t)) return;
      if (t.closest('[role="dialog"], [role="menu"], .animate-dropdown, aside, button, a, input, textarea')) return;
      setSelected(new Set());
      setMultiSelect(false);
      setMenuPos(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);
  // 手机端检测：用于门控手机属性抽屉（避免 sm+ 下隐藏抽屉仍锁住页面滚动）
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches
  );

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => setPath(routePath), [routePath]);
  // 换目录、改搜索词或排序后回到第一页（否则可能停在超出范围的页码上）
  useEffect(() => setPage(1), [routePath, search, sort, order, pageSize]);
  useEffect(() => localStorage.setItem('picumet:view', view), [view]);

  const { data, isLoading, error } = useFilesQuery(path, {
    search: search || undefined,
    sort,
    order,
    page,
    limit: pageSize,
  });
  const createFolder = useCreateFolder();
  const renameFile = useRenameFile();
  const deleteFile = useDeleteFile();
  const moveFile = useMoveFile();
  const batchDelete = useBatchDelete();
  const copyLinks = useCopyLinks();

  const items = data?.items ?? [];
  const breadcrumb = useMemo(() => {
    const parts = path.split('/').filter(Boolean);
    const crumbs = [{ name: t('nav.home'), path: '/' }];
    let acc = '';
    for (const p of parts) {
      acc = `${acc}/${p}`;
      crumbs.push({ name: p, path: acc });
    }
    return crumbs;
  }, [path, t]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = () => setSelected(new Set());

  const openItem = useCallback(
    (f: FileListItem) => {
      if (f.type === 'folder') {
        clearSelection();
        setMultiSelect(false);
        navigate(`/files${f.path === '/' ? '' : f.path}`);
      } else if (isImage(f.name) || isVideo(f.name) || isAudio(f.name) || isCode(f.name)) {
        setPreviewFile(f);
      } else {
        void downloadFile(f);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigate]
  );

  const downloadFile = useCallback(async (f: FileListItem) => {
    try {
      if (f.hasPassword) {
        setPreviewFile(f);
        return;
      }
      const res = await fetch(`/api/files/${f.id}/download`, { credentials: 'include' });
      if (!res.ok) throw new Error(t('files.downloadFailed'));
      const data = (await res.json()) as { data: { url: string } };
      window.open(data.data.url, '_blank');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('files.downloadFailed'));
    }
  }, [t]);

  const doCopyLink = useCallback(
    async (f: FileListItem, format: 'direct' | 'html' | 'markdown' = 'direct', signed = false) => {
      // 含图片/视频 → 打开格式选择弹窗；否则直接复制直链
      if (isImage(f.name) || isVideo(f.name)) {
        setCopyDialog({ files: [f] });
        return;
      }
      try {
        const res = await copyLinks.mutateAsync({ id: f.id, signed, expiresIn: signed ? 3600 : undefined });
        let text: string;
        if (format === 'html') {
          text = res.formats.html;
        } else if (format === 'markdown') {
          text = res.formats.markdown;
        } else {
          text = res.formats.direct.startsWith('http')
            ? res.formats.direct
            : window.location.origin + res.formats.direct;
        }
        await navigator.clipboard.writeText(text);
        toast('success', signed ? t('files.signedLinkCopied') : t('files.linkCopied'));
      } catch {
        toast('error', t('files.copyLinkFailed'));
      }
    },
    [copyLinks, t]
  );

  // 单击单选；Ctrl/Shift/⌘ 或多选模式切换选择；属性由显式操作打开
  const handleFileClick = useCallback(
    (e: React.MouseEvent, f: FileListItem) => {
      e.stopPropagation();
      if (multiSelect || e.shiftKey || e.ctrlKey || e.metaKey) {
        toggleSelect(f.id);
      } else {
        setSelected(new Set([f.id]));
      }
    },
    [multiSelect, toggleSelect]
  );

  const handlers: FileActionHandlers = {
    onOpen: openItem,
    onDownload: downloadFile,
    onRename: (f) => {
      setRenameTarget(f);
      setRenameValue(f.name);
    },
    onDelete: (f) => setDeleteTarget(f),
    onMove: (f) => setMoveTarget(f),
    onShare: (f) => setShareItems([f]),
    onCopyLink: doCopyLink,
    onProperties: (f) => setPropsFile(f),
    onSetPassword: (f) => setPropsFile(f),
  };

  const contextMenu = (e: React.MouseEvent, f: FileListItem) => {
    e.preventDefault();
    e.stopPropagation();
    // 右键多选（可开关）：开启时未选中项累积加入；关闭时仅选中该项
    if (!selected.has(f.id)) {
      if (useTheme.getState().rightClickMultiSelect) {
        setSelected((prev) => new Set(prev).add(f.id));
      } else {
        setSelected(new Set([f.id]));
      }
    }
    if (f.banned || useTheme.getState().rightClickAction === 'menu') {
      // 封禁文件强制走菜单（菜单内仅剩删除），避免右键直接打开含写操作的属性面板
      setMenuPos({ x: e.clientX, y: e.clientY, file: f });
    } else {
      setPropsFile(f);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteFile.mutateAsync(deleteTarget.id);
      toast('success', t('files.deleteSuccess'));
      setDeleteTarget(null);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('files.deleteFailed'));
    }
  };

  const doBulkDelete = async () => {
    try {
      await batchDelete.mutateAsync([...selected]);
      toast('success', t('files.deletedCount', { count: selected.size }));
      clearSelection();
      setBulkDelete(false);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('files.deleteFailed'));
    }
  };

  const doRename = async () => {
    if (!renameTarget || !renameValue) return;
    try {
      await renameFile.mutateAsync({ id: renameTarget.id, name: renameValue });
      toast('success', t('files.renameSuccess'));
      setRenameTarget(null);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('files.renameFailed'));
    }
  };

  const doCreateFolder = async () => {
    if (!folderName) return;
    try {
      await createFolder.mutateAsync({ path, name: folderName });
      toast('success', t('files.folderCreated'));
      setNewFolder(false);
      setFolderName('');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('common.createFailed'));
    }
  };

  const doMove = async (targetPath: string) => {
    if (!moveTarget) return;
    try {
      await moveFile.mutateAsync({ id: moveTarget.id, targetPath });
      toast('success', t('files.moveSuccess'));
      setMoveTarget(null);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('files.moveFailed'));
    }
  };

  const doBulkMove = async () => {
    if (!bulkMoveTarget || selected.size === 0) return;
    try {
      for (const id of selected) {
        await moveFile.mutateAsync({ id, targetPath: bulkMoveTarget });
      }
      toast('success', t('files.movedCount', { count: selected.size }));
      clearSelection();
      setBulkMove(false);
      setBulkMoveTarget('');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : t('files.bulkMoveFailed'));
    }
  };

  const moveOptions = [
    { label: t('files.rootDir'), path: '/' },
    ...(data?.items ?? []).filter((i) => i.type === 'folder').map((i) => ({ label: i.name, path: i.path })),
  ];

  return (
    <AppShell activeNav="files">
      <div
        ref={rowRef}
        // 拖拽监听绑定在 AppShell main 元素上（见上方 effect），覆盖整行与四周留白
        // 文件页禁止选中文本：拖拽多选时原生文本选择会污染侧栏/树（select-none 常驻）
        className={cn('flex select-none', lasso.rect && 'lasso-hint')}
      >
        {/* 左侧文件树（桌面）：玻璃面板，与内容间距归文件区 */}
        <div className="hidden w-56 shrink-0 pl-2 pr-1 lg:block">
          <div className="glass-surface glass-blur sticky top-20 flex h-[calc(100vh-6rem)] flex-col rounded-xl border">
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-none p-2">
              <FileTree currentPath={path} onNavigate={(p) => navigate(`/files${p === '/' ? '' : p}`)} />
            </div>
          </div>
        </div>
        {/* 主区域 */}
        <div
          ref={contentRef}
          onClick={(e) => {
            // 点击空白处：清空选择（批量栏随之消失）、关闭右键菜单
            const t = e.target as HTMLElement;
            if (t.closest('[data-file-id], button, a, input, textarea, [role="menu"], .animate-dropdown, .lasso-box')) return;
            setSelected(new Set());
            setMultiSelect(false);
            setMenuPos(null);
          }}
          className={cn('min-w-0 flex-1 px-3')}
        >
          {/* 面包屑 + 工具栏 */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center text-sm">
              {(() => {
                // 长路径折叠：超过 4 段时，中间段收进省略号下拉
                const MAX = 4;
                if (breadcrumb.length <= MAX) {
                  return breadcrumb.map((c, i) => (
                    <span key={c.path} className="flex items-center">
                      {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                      <button
                        onClick={() => navigate(`/files${c.path === '/' ? '' : c.path}`)}
                        className={cn(
                          'truncate rounded px-1.5 py-0.5 hover:bg-accent',
                          i === breadcrumb.length - 1 ? 'font-medium' : 'text-muted-foreground'
                        )}
                      >
                        {c.name}
                      </button>
                    </span>
                  ));
                }
                const first = breadcrumb[0];
                const last = breadcrumb.slice(-2);
                const hidden = breadcrumb.slice(1, -2);
                const renderCrumb = (c: (typeof breadcrumb)[number], isLast: boolean) => (
                  <span key={c.path} className="flex items-center">
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    <button
                      onClick={() => navigate(`/files${c.path === '/' ? '' : c.path}`)}
                      className={cn(
                        'truncate rounded px-1.5 py-0.5 hover:bg-accent',
                        isLast ? 'font-medium' : 'text-muted-foreground'
                      )}
                    >
                      {c.name}
                    </button>
                  </span>
                );
                return (
                  <>
                    <span className="flex items-center">
                      <button
                        onClick={() => navigate(`/files${first.path === '/' ? '' : first.path}`)}
                        className="truncate rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent"
                      >
                        {first.name}
                      </button>
                    </span>
                    <Dropdown
                      align="start"
                      trigger={
                        <span className="flex cursor-pointer items-center rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent" aria-label={t('files.expandPath')}>
                          <MoreHorizontal className="h-4 w-4" />
                        </span>
                      }
                    >
                      {(close) => (
                        <>
                          {hidden.map((c) => (
                            <DropdownItem
                              key={c.path}
                              onClick={() => {
                                close();
                                navigate(`/files${c.path === '/' ? '' : c.path}`);
                              }}
                            >
                              {c.name}
                            </DropdownItem>
                          ))}
                        </>
                      )}
                    </Dropdown>
                    {last.map((c, i) => renderCrumb(c, i === last.length - 1))}
                  </>
                );
              })()}
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={() => setShowUpload(true)}>
                <Upload className="h-4 w-4" /> <span className="hidden sm:inline">{t('files.upload')}</span>
              </Button>
              <Button variant="outline" size="sm" onClick={() => setNewFolder(true)} className="hidden sm:inline-flex">
                <FolderPlus className="h-4 w-4" /> {t('files.newFolder')}
              </Button>
              {!multiSelect ? (
                <Button variant="outline" size="sm" onClick={() => setMultiSelect(true)}>
                  <CheckSquare className="h-4 w-4" /> <span className="hidden sm:inline">{t('files.select')}</span>
                </Button>
              ) : (
                <>
                  <Dropdown
                    trigger={
                      <Button variant="outline" size="sm">
                        <CheckSquare className="h-4 w-4" /> <span className="hidden sm:inline">{t('files.batchSelect')}</span>
                        <ChevronDown className="ml-1 h-3.5 w-3.5" />
                      </Button>
                    }
                  >
                    {(close) => (
                      <>
                        <DropdownItem
                          icon={<CheckSquare className="h-4 w-4" />}
                          onClick={() => {
                            setSelected(new Set(items.map((f) => f.id)));
                            close();
                          }}
                        >
                          {t('files.selectAll')}
                        </DropdownItem>
                        <DropdownItem
                          icon={<ArrowRightLeft className="h-4 w-4" />}
                          onClick={() => {
                            const next = new Set<string>();
                            items.forEach((f) => {
                              if (!selected.has(f.id)) next.add(f.id);
                            });
                            setSelected(next);
                            close();
                          }}
                        >
                          {t('files.invertSelection')}
                        </DropdownItem>
                        <DropdownItem
                          icon={<X className="h-4 w-4" />}
                          onClick={() => {
                            clearSelection();
                            close();
                          }}
                        >
                          {t('files.clearSelection')}
                        </DropdownItem>
                      </>
                    )}
                  </Dropdown>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      clearSelection();
                      setMultiSelect(false);
                    }}
                  >
                    {t('files.exitSelection')}
                  </Button>
                </>
              )}
              <div className="glass-control ml-1 flex items-center rounded-md border bg-muted/[var(--glass-alpha,0.72)]">
                <button
                  onClick={() => setView('grid')}
                  className={cn('rounded-l-md p-1.5', view === 'grid' ? 'bg-primary/15 text-primary' : 'text-muted-foreground')}
                  aria-label={t('files.viewCards')}
                >
                  <LayoutGrid className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setView('list')}
                  className={cn('rounded-r-md p-1.5', view === 'list' ? 'bg-primary/15 text-primary' : 'text-muted-foreground')}
                  aria-label={t('files.viewList')}
                >
                  <ListIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {/* 搜索 + 排序 */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[140px] max-w-[432px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 z-10 h-4 w-4 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('files.searchPlaceholder')} className={cn('pl-8', SEARCH_INPUT_GLASS)} />
            </div>
            <Dropdown
              align="start"
              contentClass="min-w-36"
              trigger={
                <button
                  type="button"
                  aria-label={t('files.sort')}
                  className="glass-control flex h-9 w-36 items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-card/[var(--glass-alpha,0.72)] px-3 text-sm shadow-sm outline-none transition-colors hover:bg-accent/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <span className="truncate">{t(SORT_FIELDS.find((o) => o.value === (sort ?? 'name'))?.label ?? 'files.sortName')}</span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              }
            >
              {(close) => (
                <>
                  <DropdownLabel>{t('files.sortBy')}</DropdownLabel>
                  {SORT_FIELDS.map((o) => (
                    <DropdownItem
                      key={o.value}
                      icon={(sort ?? 'name') === o.value ? <Check className="h-4 w-4 text-primary" /> : <span className="h-4 w-4" />}
                      onClick={() => {
                        setSort(o.value === 'name' ? undefined : o.value);
                        close();
                      }}
                    >
                      {t(o.label)}
                    </DropdownItem>
                  ))}
                  <DropdownSeparator />
                  <DropdownItem
                    icon={order === 'asc' ? <Check className="h-4 w-4 text-primary" /> : <span className="h-4 w-4" />}
                    onClick={() => {
                      setOrder('asc');
                      close();
                    }}
                  >
                    {t('files.sortAsc')}
                  </DropdownItem>
                  <DropdownItem
                    icon={order === 'desc' ? <Check className="h-4 w-4 text-primary" /> : <span className="h-4 w-4" />}
                    onClick={() => {
                      setOrder('desc');
                      close();
                    }}
                  >
                    {t('files.sortDesc')}
                  </DropdownItem>
                </>
              )}
            </Dropdown>
          </div>
          {/* 内容 */}
          {isLoading ? (
            view === 'grid' ? <FileGridSkeleton /> : <FileListSkeleton />
          ) : error ? (
            <EmptyState title={t('files.loadFailed')} description={(error as Error).message} />
          ) : items.length === 0 ? (
            <EmptyState
              title={t('files.empty')}
              description={t('files.emptyDesc')}
              action={
                <Button onClick={() => setShowUpload(true)}>
                  <Upload className="h-4 w-4" /> {t('files.upload')}
                </Button>
              }
            />
          ) : view === 'grid' ? (
            <div
              className="grid grid-cols-2 gap-3 sm:[grid-template-columns:repeat(var(--files-cols),minmax(0,1fr))]"
              style={{ '--files-cols': String(Math.min(8, Math.max(4, filesPerRow))) } as React.CSSProperties}
            >
              {items.map((f) => (
                <FileCard
                  key={f.id}
                  f={f}
                  selected={selected.has(f.id)}
                  onSelect={() => toggleSelect(f.id)}
                  onDoubleClick={() => openItem(f)}
                  onContext={(e) => contextMenu(e, f)}
                  onSingleClick={handleFileClick}
                  handlers={handlers}
                  multiSelect={multiSelect}
                  sort={sort}
                  order={order}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {/* 表头：与文件行同一 item-surface 玻璃（同底色 token、同模糊、同边框圆角），
                  固定在滚动区上方——数据行只在下方容器内滚动，不会滑到表头下面造成叠加；
                  两侧预留相同滚动条槽位保证列对齐 */}
              <div data-file-list-header className='item-surface grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 overflow-hidden rounded-md border px-3 py-2 text-sm text-muted-foreground [scrollbar-gutter:stable] sm:grid-cols-[auto_minmax(0,1fr)_100px_130px_auto]'>
                <span className="w-4" aria-hidden />
                <SortableHeader
                  title={t('files.name')}
                  sortKey="name"
                  sort={sort ?? null}
                  order={order ?? 'asc'}
                  onSort={(k) => {
                    setSort(k as typeof sort);
                    setOrder(order === 'asc' ? 'desc' : 'asc');
                  }}
                />
                <span className="hidden text-right sm:block">
                  <SortableHeader
                    title={t('files.size')}
                    sortKey="size"
                    sort={sort ?? null}
                    order={order ?? 'asc'}
                    onSort={(k) => {
                      setSort(k as typeof sort);
                      setOrder(order === 'asc' ? 'desc' : 'asc');
                    }}
                  />
                </span>
                <span className="hidden sm:block">
                  <SortableHeader
                    title={t('files.modified')}
                    sortKey="time"
                    sort={sort ?? null}
                    order={order ?? 'asc'}
                    onSort={(k) => {
                      setSort(k as typeof sort);
                      setOrder(order === 'asc' ? 'desc' : 'asc');
                    }}
                  />
                </span>
                <span aria-hidden />
              </div>
              <div className="max-h-[calc(100vh-18.625rem)] space-y-0.5 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
                {items.map((f) => (
                  <FileRow
                    key={f.id}
                    f={f}
                    selected={selected.has(f.id)}
                    onSelect={() => toggleSelect(f.id)}
                    onDoubleClick={() => openItem(f)}
                    onContext={(e) => contextMenu(e, f)}
                    onSingleClick={handleFileClick}
                    handlers={handlers}
                    multiSelect={multiSelect}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="mt-auto pt-2">
          {(data?.pagination?.total ?? 0) > 0 && (
            <Pagination
              page={page}
              total={data?.pagination?.total ?? 0}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              className="mt-3"
            />
          )}
          </div>

          {selected.size > 0 && (
            <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2">
              <BulkActionsBar
                onlyDelete={items.some((f) => selected.has(f.id) && f.banned)}
                count={selected.size}
                onClear={clearSelection}
                onMove={() => setBulkMove(true)}
                onDelete={() => setBulkDelete(true)}
                onDownload={() => {
                  items
                    .filter((f) => selected.has(f.id) && f.type !== 'folder')
                    .forEach((file) => void downloadFile(file));
                }}
                onCopyLink={() => {
                  const files = items.filter((f) => selected.has(f.id));
                  if (files.length === 0) return;
                  if (files.some((f) => isImage(f.name) || isVideo(f.name))) {
                    setCopyDialog({ files });
                    return;
                  }
                  void (async () => {
                    try {
                      const links = await Promise.all(
                        files.map(async (f) => {
                          const res = await copyLinks.mutateAsync({ id: f.id });
                          const direct = res.formats.direct.startsWith('http')
                            ? res.formats.direct
                            : window.location.origin + res.formats.direct;
                          return direct;
                        })
                      );
                      await navigator.clipboard.writeText(links.join('\n'));
                      toast('success', t('files.copiedLinks', { count: links.length }));
                    } catch {
                      toast('error', t('files.copyLinkFailed'));
                    }
                  })();
                }}
                onShare={() => setShareItems(items.filter((f) => selected.has(f.id)))}
                onRename={
                  selected.size === 1
                    ? () => {
                        const [id] = selected;
                        const file = items.find((f) => f.id === id);
                        if (file) {
                          setRenameTarget(file);
                          setRenameValue(file.name);
                        }
                      }
                    : undefined
                }
                onProperties={
                  selected.size === 1
                    ? () => {
                        const [id] = selected;
                        const file = items.find((f) => f.id === id);
                        if (file && !file.banned) setPropsFile(file);
                      }
                    : undefined
                }
              />
            </div>
          )}
        </div>

        {/* 属性侧栏 - 平板/桌面始终紧贴右侧，仅在有文件时显示（手机用右侧抽屉避免压垮内容） */}
        {propsFile && (
          <aside className="glass-surface glass-blur hidden w-72 shrink-0 border-l pl-3 pr-1 sticky top-20 self-start h-[calc(100vh-6rem)] overflow-y-auto scrollbar-thin sm:block">
            <PropertiesPanel file={propsFile} onClose={() => setPropsFile(null)} />
          </aside>
        )}
      </div>

      {/* 手机（<sm）：右侧抽屉 */}
      <Drawer open={!!propsFile && isMobile} onClose={() => setPropsFile(null)} side="right" className="sm:hidden">
        <PropertiesPanel file={propsFile} onClose={() => setPropsFile(null)} />
      </Drawer>

      {/* ===== 弹窗（常驻挂载：进出动画由 Dialog 统一处理） ===== */}
      <UploadModal open={showUpload} onClose={() => setShowUpload(false)} targetPath={path} onDone={() => setShowUpload(false)} />
      <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} onDownload={downloadFile} onCopyLink={doCopyLink} />

      {/* 复制链接弹窗（含图片/视频时） */}
      <CopyLinksDialog open={!!copyDialog} files={copyDialog?.files ?? []} onClose={() => setCopyDialog(null)} copyLinks={copyLinks} />

      {/* 创建分享（行菜单单选 / 批量栏多选，文件与文件夹均可） */}
      <ShareDialog open={!!shareItems} items={shareItems ?? []} onClose={() => setShareItems(null)} />

      {/* 新建文件夹 */}
      <Dialog
        open={newFolder}
        onClose={() => setNewFolder(false)}
        title={t('files.newFolder')}
        footer={
          <>
            <Button variant="outline" onClick={() => setNewFolder(false)}>{t('common.cancel')}</Button>
            <Button onClick={doCreateFolder}>{t('common.confirm')}</Button>
          </>
        }
      >
        <Input value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder={t('files.createFolderPlaceholder')} autoFocus onKeyDown={(e) => e.key === 'Enter' && doCreateFolder()} />
      </Dialog>

      {/* 重命名 */}
      <Dialog
        open={!!renameTarget}
        onClose={() => setRenameTarget(null)}
        title={t('common.rename')}
        footer={
          <>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>{t('common.cancel')}</Button>
            <Button onClick={doRename}>{t('common.confirm')}</Button>
          </>
        }
      >
        <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && doRename()} />
      </Dialog>

      {/* 移动 */}
      <Dialog
        open={!!moveTarget}
        onClose={() => setMoveTarget(null)}
        title={t('files.moveTo')}
        footer={
          <>
            <Button variant="outline" onClick={() => setMoveTarget(null)}>{t('common.cancel')}</Button>
          </>
        }
      >
        <div className="space-y-1">
          {moveOptions.map((o) => (
            <button
              key={o.path}
              onClick={() => void doMove(o.path)}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
            >
              <Folder className="h-4 w-4 text-sky-500" />
              {o.label}
            </button>
          ))}
        </div>
      </Dialog>

      {/* 批量移动 */}
      <Dialog
        open={bulkMove}
        onClose={() => setBulkMove(false)}
        title={t('files.bulkMove')}
        footer={
          <>
            <Button variant="outline" onClick={() => setBulkMove(false)}>{t('common.cancel')}</Button>
            <Button onClick={doBulkMove} disabled={!bulkMoveTarget}>{t('common.confirm')}</Button>
          </>
        }
      >
        <div className="space-y-1">
          {moveOptions.map((o) => (
            <button
              key={o.path}
              onClick={() => setBulkMoveTarget(o.path)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent',
                bulkMoveTarget === o.path && 'bg-accent font-medium'
              )}
            >
              <Folder className="h-4 w-4 text-sky-500" />
              {o.label}
            </button>
          ))}
        </div>
      </Dialog>

      {/* 确认删除 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={doDelete}
        title={t('common.delete')}
        message={deleteTarget?.banned
          ? t('files.bannedDeleteConfirm', { name: deleteTarget?.name ?? '' })
          : t('files.deleteConfirm', { name: deleteTarget?.name ?? '' })}
        loading={deleteFile.isPending}
      />
      <ConfirmDialog
        open={bulkDelete}
        onClose={() => setBulkDelete(false)}
        onConfirm={doBulkDelete}
        title={t('common.delete')}
        message={t('files.bulkDeleteConfirm', { count: selected.size })}
        loading={batchDelete.isPending}
      />
      {lasso.rect && (
        <div
          className="lasso-box"
          style={{
            left: lasso.rect.left,
            top: lasso.rect.top,
            width: lasso.rect.width,
            height: lasso.rect.height,
          }}
        />
      )}
      {menuPos &&
        createPortal(
          <div
            ref={ctxMenuRef}
            className="glass-surface-popover glass-blur animate-dropdown fixed z-[100] w-48 overflow-y-auto rounded-md border p-1 text-popover-foreground shadow-md"
            style={{ left: menuXY?.left ?? menuPos.x, top: menuXY?.top ?? menuPos.y }}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <FileRowMenuItems f={menuPos.file} handlers={handlers} onClose={() => setMenuPos(null)} />
          </div>,
          document.body
        )}
    </AppShell>
  );
}
