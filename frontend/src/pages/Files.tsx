// 文件管理器主页面
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Upload, FolderPlus, LayoutGrid, List as ListIcon, ChevronRight, ArrowDown, ArrowUp,
  Folder, Search, CheckSquare,
} from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Button, Input, EmptyState, Dialog, ConfirmDialog, Spinner } from '@/components/ui/core';
import { Select } from '@/components/ui/select';
import { Drawer } from '@/components/ui/drawer';
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
  const [multiSelect, setMultiSelect] = useState(false);
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
      <div className="flex items-start gap-4">
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
                  <Button variant="outline" size="sm" onClick={() => setSelected(new Set(items.map((f) => f.id)))}>
                    全选
                  </Button>
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
            <div className="sticky bottom-4 mt-4">
              <BulkActionsBar
                count={selected.size}
                onClear={clearSelection}
                onMove={() => setBulkMove(true)}
                onDelete={() => setBulkDelete(true)}
              />
            </div>
          )}
        </div>

        {/* 宽屏：固定属性侧栏（xl+） - 始终渲染 */}
        <aside className="hidden xl:block w-80 shrink-0 overflow-hidden border-l bg-muted/20">
          {propsFile ? (
            <PropertiesPanel file={propsFile} onClose={() => setPropsFile(null)} />
          ) : (
            <div className="flex h-full min-h-[16rem] items-center justify-center p-4 text-sm text-muted-foreground">
              选择文件查看属性
            </div>
          )}
        </aside>
      </div>

      {/* 窄屏：属性抽屉（<xl） */}
      <Drawer open={!!propsFile} onClose={() => setPropsFile(null)} side="right" className="xl:hidden">
        <PropertiesPanel file={propsFile} onClose={() => setPropsFile(null)} />
      </Drawer>

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
    </AppShell>
  );
}
