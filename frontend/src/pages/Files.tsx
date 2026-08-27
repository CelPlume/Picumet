// 文件管理器主页面
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Upload, FolderPlus, LayoutGrid, List as ListIcon, ChevronRight, ArrowDown, ArrowUp,
  Folder, Search, CheckSquare, ChevronDown, ArrowRightLeft, X, Check, MoreHorizontal,
} from 'lucide-react';
import { FileGridSkeleton, FileListSkeleton } from '@/components/ui/skeleton';
import { useLassoSelect } from '@/components/files/lasso';
import { useTheme } from '@/stores/theme';
import { FileTree } from '@/components/files/FileTree';
import { Button, Input, EmptyState, Dialog, ConfirmDialog, Spinner, Switch } from '@/components/ui/core';
import { AppShell } from '@/components/layout/AppShell';
import { Select } from '@/components/ui/select';
import { Drawer } from '@/components/ui/drawer';
import { Dropdown, DropdownItem } from '@/components/ui/dropdown';
import { toast } from '@/components/ui/toast';
import { useFilesQuery, useCreateFolder, useRenameFile, useDeleteFile, useMoveFile, useBatchDelete, useCopyLinks } from '@/components/files/data';
import { FileCard, FileRow, BulkActionsBar, FileRowMenuItems, type ViewMode, type FileActionHandlers } from '@/components/files/explorer';
import { UploadModal } from '@/components/files/UploadModal';
import { PreviewModal } from '@/components/files/preview';
import { PropertiesPanel } from '@/components/files/PropertiesPanel';
import FileIcon from '@/components/files/FileIcon';
import { normalizeVirtualPath, cn, isImage, isVideo, isAudio, isCode } from '@/lib/utils';
import type { FileListItem } from '@shared/types';

// ============ 复制链接弹窗（含图片/视频时选择格式与签名） ============
function CopyLinksDialog({
  files,
  onClose,
  copyLinks,
}: {
  files: FileListItem[];
  onClose: () => void;
  copyLinks: ReturnType<typeof useCopyLinks>;
}) {
  const [format, setFormat] = useState<'direct' | 'html' | 'markdown'>('direct');
  const [signed, setSigned] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

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
      toast('success', signed ? `已复制 ${links.length} 个签名链接` : `已复制 ${links.length} 个链接`);
    } catch {
      toast('error', '复制链接失败');
    } finally {
      setLoading(false);
    }
  };

  const formatOptions = [
    { value: 'direct' as const, label: '直链', desc: '直接下载链接' },
    { value: 'html' as const, label: 'HTML 代码', desc: '<img src="...">' },
    { value: 'markdown' as const, label: 'Markdown 代码', desc: '![name](url)' },
  ];

  return (
    <Dialog
      open
      onClose={onClose}
      title="复制链接"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{copied ? '关闭' : '取消'}</Button>
          <Button onClick={() => void doCopy()} loading={loading}>{copied ? '已复制 ✓' : '复制'}</Button>
        </>
      }
    >
      <div className="space-y-4">
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
                format === o.value ? 'border-primary bg-primary/5' : 'hover:bg-accent'
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
            <p className="text-sm font-medium">签名链接</p>
            <p className="text-xs text-muted-foreground">带时效的签名 URL（有效期 1 小时）</p>
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
  const [sort, setSort] = useState<string | undefined>();
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [multiSelect, setMultiSelect] = useState(false);
  const enableBlur = useTheme((s) => s.enableBlur);
  const contentRef = useRef<HTMLDivElement>(null);
  // 主列容器即拖拽面：空白处(含网格四周)均可起拖；网格跳过卡片，列表允许从行起拖
  const lasso = useLassoSelect(contentRef, setSelected, {
    skipSelector: '[data-file-card], button, a, input, textarea, [role="checkbox"], [role="menuitem"]',
  });
  const [showUpload, setShowUpload] = useState(false);
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
  const [menuPos, setMenuPos] = useState<{ x: number; y: number; file: FileListItem } | null>(null);
  // 切换目录时关闭右键菜单并清空选择（批量操作栏随之消失）
  useEffect(() => {
    setMenuPos(null);
    setSelected(new Set());
    setMultiSelect(false);
  }, [path]);

  // 开启非批量弹窗（上传/新建/重命名/删除/移动/属性/预览/复制链接）时清空选择
  useEffect(() => {
    if (showUpload || newFolder || renameTarget || deleteTarget || moveTarget || propsFile || previewFile || copyDialog) {
      setSelected(new Set());
      setMultiSelect(false);
      setMenuPos(null);
    }
  }, [showUpload, newFolder, renameTarget, deleteTarget, moveTarget, propsFile, previewFile, copyDialog]);

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
  useEffect(() => localStorage.setItem('picumet:view', view), [view]);

  const { data, isLoading, error } = useFilesQuery(path, { search: search || undefined, sort, order });
  const createFolder = useCreateFolder();
  const renameFile = useRenameFile();
  const deleteFile = useDeleteFile();
  const moveFile = useMoveFile();
  const batchDelete = useBatchDelete();
  const copyLinks = useCopyLinks();

  const items = data?.items ?? [];
  const breadcrumb = useMemo(() => {
    const parts = path.split('/').filter(Boolean);
    const crumbs = [{ name: '首页', path: '/' }];
    let acc = '';
    for (const p of parts) {
      acc = `${acc}/${p}`;
      crumbs.push({ name: p, path: acc });
    }
    return crumbs;
  }, [path]);

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
      if (!res.ok) throw new Error('下载失败');
      const data = (await res.json()) as { data: { url: string } };
      window.open(data.data.url, '_blank');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '下载失败');
    }
  }, []);

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
        toast('success', signed ? '签名链接已复制（有效期 1 小时）' : '链接已复制');
      } catch {
        toast('error', '复制链接失败');
      }
    },
    [copyLinks]
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
    onShare: (f) => navigate(`/shares?create=${f.id}`),
    onCopyLink: doCopyLink,
    onProperties: (f) => setPropsFile(f),
    onSetPassword: (f) => setPropsFile(f),
  };

  const contextMenu = (e: React.MouseEvent, f: FileListItem) => {
    e.preventDefault();
    // 右键多选（可开关）：开启时未选中项累积加入；关闭时仅选中该项
    if (!selected.has(f.id)) {
      if (useTheme.getState().rightClickMultiSelect) {
        setSelected((prev) => new Set(prev).add(f.id));
      } else {
        setSelected(new Set([f.id]));
      }
    }
    if (useTheme.getState().rightClickAction === 'menu') {
      setMenuPos({ x: e.clientX, y: e.clientY, file: f });
    } else {
      setPropsFile(f);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteFile.mutateAsync(deleteTarget.id);
      toast('success', '已删除');
      setDeleteTarget(null);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '删除失败');
    }
  };

  const doBulkDelete = async () => {
    try {
      await batchDelete.mutateAsync([...selected]);
      toast('success', `已删除 ${selected.size} 项`);
      clearSelection();
      setBulkDelete(false);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '删除失败');
    }
  };

  const doRename = async () => {
    if (!renameTarget || !renameValue) return;
    try {
      await renameFile.mutateAsync({ id: renameTarget.id, name: renameValue });
      toast('success', '已重命名');
      setRenameTarget(null);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '重命名失败');
    }
  };

  const doCreateFolder = async () => {
    if (!folderName) return;
    try {
      await createFolder.mutateAsync({ path, name: folderName });
      toast('success', '已创建文件夹');
      setNewFolder(false);
      setFolderName('');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '创建失败');
    }
  };

  const doMove = async (targetPath: string) => {
    if (!moveTarget) return;
    try {
      await moveFile.mutateAsync({ id: moveTarget.id, targetPath });
      toast('success', '移动成功');
      setMoveTarget(null);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '移动失败');
    }
  };

  const doBulkMove = async () => {
    if (!bulkMoveTarget || selected.size === 0) return;
    try {
      for (const id of selected) {
        await moveFile.mutateAsync({ id, targetPath: bulkMoveTarget });
      }
      toast('success', `已移动 ${selected.size} 项`);
      clearSelection();
      setBulkMove(false);
      setBulkMoveTarget('');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '批量移动失败');
    }
  };

  const moveOptions = [
    { label: '根目录 /', path: '/' },
    ...(data?.items ?? []).filter((i) => i.type === 'folder').map((i) => ({ label: i.name, path: i.path })),
  ];

  return (
    <AppShell activeNav="files">
      <div className="flex items-start">
        {/* 左侧文件树（桌面）：贴左，与内容间距归文件区 */}
        <div className="hidden w-56 shrink-0 pl-2 pr-1 lg:block">
          <FileTree currentPath={path} onNavigate={(p) => navigate(`/files${p === '/' ? '' : p}`)} />
        </div>
        {/* 主区域 */}
        <div
          ref={contentRef}
          onPointerDown={lasso.onPointerDown}
          onPointerMove={lasso.onPointerMove}
          onPointerUp={lasso.onPointerUp}
          onPointerCancel={lasso.onPointerCancel}
          onClickCapture={lasso.onClickCapture}
          onClick={(e) => {
            // 点击空白处：清空选择（批量栏随之消失）、关闭右键菜单
            const t = e.target as HTMLElement;
            if (t.closest('[data-file-id], button, a, input, textarea, [role="menu"], .animate-dropdown, .lasso-box')) return;
            setSelected(new Set());
            setMultiSelect(false);
            setMenuPos(null);
          }}
          className={cn('min-w-0 flex-1 px-3', lasso.rect && 'lasso-hint')}
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
                        <span className="flex cursor-pointer items-center rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent" aria-label="展开路径">
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
                  <CheckSquare className="h-4 w-4" /> <span className="hidden sm:inline">选择</span>
                </Button>
              ) : (
                <>
                  <Dropdown
                    trigger={
                      <Button variant="outline" size="sm">
                        <CheckSquare className="h-4 w-4" /> <span className="hidden sm:inline">批量选择</span>
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
                          全选
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
                          反选
                        </DropdownItem>
                        <DropdownItem
                          icon={<X className="h-4 w-4" />}
                          onClick={() => {
                            clearSelection();
                            close();
                          }}
                        >
                          清空选择
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
                    退出
                  </Button>
                </>
              )}
              <div className="ml-1 flex items-center rounded-md border">
                <button
                  onClick={() => setView('grid')}
                  className={cn('rounded-l-md p-1.5', view === 'grid' ? 'bg-accent' : 'text-muted-foreground')}
                  aria-label="卡片视图"
                >
                  <LayoutGrid className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setView('list')}
                  className={cn('rounded-r-md p-1.5', view === 'list' ? 'bg-accent' : 'text-muted-foreground')}
                  aria-label="列表视图"
                >
                  <ListIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {/* 搜索 + 排序 */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[140px] max-w-sm flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('files.searchPlaceholder')} className="pl-8" />
            </div>
            <Select
              value={sort ?? 'name'}
              onValueChange={(v) => setSort(v === 'name' ? undefined : v)}
              options={[
                { value: 'name', label: '按名称' },
                { value: 'time', label: '按时间' },
                { value: 'size', label: '按大小' },
              ]}
              className="w-28"
            />
            <button
              onClick={() => setOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
              className="rounded-md border p-1.5 text-muted-foreground hover:bg-accent"
              title={order === 'asc' ? '升序' : '降序'}
            >
              {order === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
            </button>
          </div>
          {/* 内容 */}
          {isLoading ? (
            view === 'grid' ? <FileGridSkeleton /> : <FileListSkeleton />
          ) : error ? (
            <EmptyState title="加载失败" description={(error as Error).message} />
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
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
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
            <div className="space-y-0.5">
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
          )}

          {selected.size > 0 && (
            <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2">
              <BulkActionsBar
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
                  const files = items.filter((f) => selected.has(f.id) && f.type !== 'folder');
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
                      toast('success', `已复制 ${links.length} 个链接`);
                    } catch {
                      toast('error', '复制链接失败');
                    }
                  })();
                }}
                onShare={
                  selected.size === 1
                    ? () => {
                        const [id] = selected;
                        const file = items.find((f) => f.id === id);
                        if (file) navigate(`/shares?create=${file.id}`);
                      }
                    : undefined
                }
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
                        if (file) setPropsFile(file);
                      }
                    : undefined
                }
              />
            </div>
          )}
        </div>

        {/* 属性侧栏 - 平板/桌面始终紧贴右侧，仅在有文件时显示（手机用右侧抽屉避免压垮内容） */}
        {propsFile && (
          <aside className="hidden sm:block w-72 shrink-0 border-l bg-card pl-3 pr-1 sticky top-20 self-start h-[calc(100vh-6rem)] overflow-y-auto scrollbar-thin">
            <PropertiesPanel file={propsFile} onClose={() => setPropsFile(null)} />
          </aside>
        )}
      </div>

      {/* 手机（<sm）：右侧抽屉 */}
      <Drawer open={!!propsFile && isMobile} onClose={() => setPropsFile(null)} side="right" className="sm:hidden">
        <PropertiesPanel file={propsFile} onClose={() => setPropsFile(null)} />
      </Drawer>

      {/* ===== 弹窗 ===== */}
      {showUpload && (
        <UploadModal open={showUpload} onClose={() => setShowUpload(false)} targetPath={path} onDone={() => setShowUpload(false)} />
      )}
      <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} onDownload={downloadFile} onCopyLink={doCopyLink} />

      {/* 复制链接弹窗（含图片/视频时） */}
      {copyDialog && (
        <CopyLinksDialog files={copyDialog.files} onClose={() => setCopyDialog(null)} copyLinks={copyLinks} />
      )}

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
        title="批量移动"
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
        message={t('files.deleteConfirm').replace('{{name}}', deleteTarget?.name ?? '')}
        loading={deleteFile.isPending}
      />
      <ConfirmDialog
        open={bulkDelete}
        onClose={() => setBulkDelete(false)}
        onConfirm={doBulkDelete}
        title={t('common.delete')}
        message={`确定要删除选中的 ${selected.size} 项吗？此操作无法撤销。`}
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
      {menuPos && (
        <div
          className={cn(
            'animate-dropdown fixed z-50 w-48 overflow-y-auto rounded-md border p-1 text-popover-foreground shadow-md',
            enableBlur ? 'bg-popover/80 backdrop-blur-xl backdrop-saturate-150' : 'bg-popover'
          )}
          style={{ left: menuPos.x, top: menuPos.y }}
        >
          <FileRowMenuItems f={menuPos.file} handlers={handlers} onClose={() => setMenuPos(null)} />
        </div>
      )}
    </AppShell>
  );
}
