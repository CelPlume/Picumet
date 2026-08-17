// 文件管理器主页面
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Upload, FolderPlus, LayoutGrid, List as ListIcon, ChevronRight, ArrowDown, ArrowUp,
  Folder, FileText, Search, Image as ImageIcon, Film, Music, Star, Share2,
} from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Button, Input, EmptyState, Dialog, ConfirmDialog, Spinner } from '@/components/ui/core';
import { toast } from '@/components/ui/toast';
import { useFilesQuery, useCreateFolder, useRenameFile, useDeleteFile, useMoveFile, useBatchDelete, useCopyLinks } from '@/components/files/data';
import { FileCard, FileRow, BulkActionsBar, type ViewMode, type FileActionHandlers } from '@/components/files/explorer';
import { UploadModal } from '@/components/files/UploadModal';
import { PreviewModal } from '@/components/files/preview';
import { PropertiesPanel } from '@/components/files/PropertiesPanel';
import { normalizeVirtualPath, cn, isImage, isVideo, isAudio, isCode } from '@/lib/utils';
import type { FileListItem } from '@shared/types';

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
    async (f: FileListItem) => {
      try {
        const res = await copyLinks.mutateAsync(f.id);
        const direct = res.formats.direct.startsWith('http') ? res.formats.direct : window.location.origin + res.formats.direct;
        await navigator.clipboard.writeText(direct);
        toast('success', '链接已复制');
      } catch {
        toast('error', '复制链接失败');
      }
    },
    [copyLinks]
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
    toggleSelect(f.id);
    setPropsFile(f);
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

  const quickLinks = [
    { icon: <Folder className="h-4 w-4 text-sky-500" />, label: '全部文件', path: '/' },
    { icon: <ImageIcon className="h-4 w-4 text-emerald-500" />, label: '图片', path: '/图片' },
    { icon: <Film className="h-4 w-4 text-rose-500" />, label: '视频', path: '/视频' },
    { icon: <Music className="h-4 w-4 text-amber-500" />, label: '音乐', path: '/音乐' },
    { icon: <FileText className="h-4 w-4 text-blue-500" />, label: '文档', path: '/文档' },
    { icon: <Star className="h-4 w-4 text-yellow-500" />, label: '收藏', path: '/收藏' },
  ];

  const moveOptions = [
    { label: '根目录 /', path: '/' },
    ...(data?.items ?? []).filter((i) => i.type === 'folder').map((i) => ({ label: i.name, path: i.path })),
  ];

  return (
    <AppShell activeNav="files">
      <div className="flex gap-4">
        {/* 侧边栏 */}
        <aside className="hidden w-52 shrink-0 flex-col gap-1 md:flex">
          {quickLinks.map((q) => (
            <button
              key={q.label}
              onClick={() => navigate(`/files${q.path === '/' ? '' : q.path}`)}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                path === q.path ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent'
              )}
            >
              {q.icon}
              {q.label}
            </button>
          ))}
          <button
            onClick={() => navigate('/shares')}
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent"
          >
            <Share2 className="h-4 w-4 text-emerald-500" />
            我的分享
          </button>
        </aside>

        {/* 主区域 */}
        <div className="min-w-0 flex-1">
          {/* 面包屑 + 工具栏 */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center overflow-hidden text-sm">
              {breadcrumb.map((c, i) => (
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
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={() => setShowUpload(true)}>
                <Upload className="h-4 w-4" /> {t('files.upload')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setNewFolder(true)}>
                <FolderPlus className="h-4 w-4" /> {t('files.newFolder')}
              </Button>
              <div className="ml-1 flex items-center rounded-md border">
                <button
                  onClick={() => setView('grid')}
                  className={cn('rounded-l-md p-1.5', view === 'grid' ? 'bg-accent' : 'text-muted-foreground')}
                >
                  <LayoutGrid className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setView('list')}
                  className={cn('rounded-r-md p-1.5', view === 'list' ? 'bg-accent' : 'text-muted-foreground')}
                >
                  <ListIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {/* 搜索 + 排序 */}
          <div className="mb-3 flex items-center gap-2">
            <div className="relative max-w-sm flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('files.searchPlaceholder')} className="pl-8" />
            </div>
            <button
              onClick={() => {
                const opts = ['name', 'time', 'size'] as const;
                const idx = opts.indexOf((sort as (typeof opts)[number]) ?? 'name');
                setSort(opts[(idx + 1) % opts.length]);
              }}
              className="flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent"
            >
              {sort === 'time' ? '时间' : sort === 'size' ? '大小' : '名称'}
            </button>
            <button onClick={() => setOrder((o) => (o === 'asc' ? 'desc' : 'asc'))} className="rounded-md border p-1.5 text-muted-foreground hover:bg-accent">
              {order === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
            </button>
          </div>

          {/* 内容 */}
          {isLoading ? (
            <div className="flex justify-center py-20"><Spinner className="h-8 w-8" /></div>
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
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {items.map((f) => (
                <FileCard
                  key={f.id}
                  f={f}
                  selected={selected.has(f.id)}
                  onSelect={() => toggleSelect(f.id)}
                  onDoubleClick={() => openItem(f)}
                  onContext={(e) => contextMenu(e, f)}
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
                />
              ))}
            </div>
          )}

          {selected.size > 0 && (
            <div className="sticky bottom-4 mt-4">
              <BulkActionsBar count={selected.size} onClear={clearSelection} onMove={() => toast('info', '请使用文件右键菜单移动')} onDelete={() => setBulkDelete(true)} />
            </div>
          )}
        </div>

        {propsFile && (
          <aside className="hidden w-72 shrink-0 lg:block">
            <PropertiesPanel file={propsFile} onClose={() => setPropsFile(null)} />
          </aside>
        )}
      </div>

      {/* ===== 弹窗 ===== */}
      {showUpload && (
        <UploadModal open={showUpload} onClose={() => setShowUpload(false)} targetPath={path} onDone={() => setShowUpload(false)} />
      )}
      <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} onDownload={downloadFile} onCopyLink={doCopyLink} />

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
    </AppShell>
  );
}
