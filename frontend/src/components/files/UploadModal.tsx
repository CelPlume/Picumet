// 上传弹窗：拖拽、多文件并发、进度条、Worker/预签名双模式
import { useEffect, useRef, useState } from 'react';
import { UploadCloud, X, Pause, Play, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Progress, Dialog } from '@/components/ui/core';
import { toast } from '@/components/ui/toast';
import { initUploadSession, completeUpload } from './data';
import { getCsrfToken, ApiError } from '@/lib/api';
import { cn, formatBytes, fileIconEmoji } from '@/lib/utils';
import i18n from '@/lib/i18n';

interface UploadTask {
  id: string;
  name: string;
  size: number;
  mime: string;
  file: File;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'failed' | 'paused';
  error?: string;
}

let taskSeq = 0;

export function UploadModal({
  open,
  onClose,
  targetPath,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  targetPath: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 每个任务一个 AbortController：暂停时真实中止在途 XHR
  const controllersRef = useRef(new Map<string, AbortController>());

  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files).map((file) => ({
      id: `t${++taskSeq}`,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      file,
      progress: 0,
      status: 'pending' as const,
    }));
    setTasks((prev) => [...prev, ...list]);
  };

  const update = (id: string, patch: Partial<UploadTask>) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  // 上传单个任务
  const uploadOne = async (task: UploadTask) => {
    if (task.status === 'completed' || task.status === 'uploading') return;
    const controller = new AbortController();
    controllersRef.current.set(task.id, controller);
    update(task.id, { status: 'uploading', error: undefined, progress: 0 });
    try {
      const session = await initUploadSession({
        path: targetPath,
        fileName: task.name,
        fileSize: task.size,
        mimeType: task.mime,
      });

      const totalParts = session.totalParts ?? 0;
      if (totalParts > 1) {
        // 分片上传（服务端按 >100MB 自动分片）：预签名直传各分片，或经 Worker 代理逐片上传
        const partSize = Math.ceil(task.size / totalParts);
        const parts = session.parts;
        // 预签名分片 URL 必须整套齐全，否则整体退回 Worker 代理（与后端下发布局一致）
        const presignedParts = session.uploadMode === 'presigned' && !!parts && parts.length === totalParts ? parts : null;
        const csrf = presignedParts ? '' : await getCsrfToken();
        const collected: Array<{ partNumber: number; etag: string }> = [];
        let allEtagsPresent = true;
        for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
          const start = (partNumber - 1) * partSize;
          const slice = task.file.slice(start, Math.min(partNumber * partSize, task.size));
          // 进度按「已完成分片字节 + 当前分片已传字节」计算，保证整体单调递增
          const onProgress = (p: number) =>
            update(task.id, {
              progress: Math.min(100, Math.max(0, ((start + (p / 100) * slice.size) / task.size) * 100)),
            });
          let partEtag: string;
          if (presignedParts) {
            const res = await putWithProgress(presignedParts[partNumber - 1].url, slice, task.mime, onProgress, controller.signal);
            if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', t('upload.failedStatus', { status: res.status }));
            // 跨域桶可能未通过 CORS 暴露 ETag；读不到时交由服务端 listParts 解析
            partEtag = res.headers.get('etag') ?? '';
          } else {
            const res = await putWithProgress(
              `/api/files/upload/multipart/${session.sessionId}/part/${partNumber}`,
              slice,
              task.mime || 'application/octet-stream',
              onProgress,
              controller.signal,
              { 'X-CSRF-Token': csrf }
            );
            if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', t('upload.failedStatus', { status: res.status }));
            const body = (await res.json()) as { data?: { etag?: string } };
            partEtag = body.data?.etag ?? '';
          }
          if (!partEtag) allEtagsPresent = false;
          collected.push({ partNumber, etag: partEtag });
        }
        // 预签名直传服务端无法感知分片，仅在 ETag 全部可读时上报；
        // Worker 代理路径服务端已逐片 recordPart，无需回传，交由服务端自行解析
        await completeUpload({
          sessionId: session.sessionId,
          parts: presignedParts && allEtagsPresent ? collected : undefined,
        });
      } else {
        let etag: string;
        if (session.uploadMode === 'presigned' && session.uploadUrl) {
          const res = await putWithProgress(
            session.uploadUrl,
            task.file,
            task.mime,
            (p) => update(task.id, { progress: p }),
            controller.signal
          );
          if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', t('upload.failedStatus', { status: res.status }));
          etag = res.headers.get('etag') ?? 'etag';
        } else {
          // Worker 代理上传
          const csrf = await getCsrfToken();
          const res = await putWithProgress(
            `/api/files/upload/raw/${session.sessionId}`,
            task.file,
            task.mime,
            (p) => update(task.id, { progress: p * 0.9 }),
            controller.signal,
            { 'X-CSRF-Token': csrf }
          );
          if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', t('upload.failedStatus', { status: res.status }));
          const body = (await res.json()) as { data?: { etag?: string } };
          etag = body.data?.etag ?? 'etag';
        }

        await completeUpload({ sessionId: session.sessionId, etag });
      }
      update(task.id, { status: 'completed', progress: 100 });
    } catch (err) {
      // 暂停：在途请求被 abort → 置 paused（非 failed），保留已上传进度，等「继续」重新入队
      if (err instanceof DOMException && err.name === 'AbortError') {
        update(task.id, { status: 'paused', error: undefined });
        return;
      }
      update(task.id, { status: 'failed', error: err instanceof Error ? err.message : t('upload.uploadFailed') });
    } finally {
      controllersRef.current.delete(task.id);
    }
  };

  useEffect(() => {
    if (!open) return;
    // 并发上传（最多 3）
    const pending = tasks.filter((t) => t.status === 'pending');
    pending.slice(0, 3).forEach((t) => void uploadOne(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tasks.length, tasks.filter((t) => t.status === 'pending').map((t) => t.id).join(',')]);
  const statusCounts = {
    pending: tasks.filter((t) => t.status === 'pending').length,
    uploading: tasks.filter((t) => t.status === 'uploading').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('upload.title')} width="max-w-xl">
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors',
          dragging ? 'dropzone-active' : 'border-border'
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
      >
        <UploadCloud className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t('upload.dragHere')}</p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
            {t('upload.selectFiles')}
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
        <p className="text-xs text-muted-foreground">
          {t('upload.targetPath')}: <span className="font-mono">{targetPath}</span>
        </p>
      </div>

      {tasks.length > 0 && (
        <div className="mt-4 max-h-64 space-y-2 overflow-y-auto scrollbar-thin">
          {tasks.map((task) => (
            <div key={task.id} className="rounded-md border bg-card p-3">
              <div className="flex items-center gap-2">
                <span className="text-lg">{fileIconEmoji(task.name, 'file')}</span>
                <span className="flex-1 truncate text-sm">{task.name}</span>
                <span className="text-xs text-muted-foreground">
                  {task.status === 'completed' ? '✓' : task.status === 'failed' ? '✗' : formatBytes(task.size)}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Progress value={task.progress} className="flex-1" />
                <span className="w-10 text-right text-xs text-muted-foreground">{Math.round(task.progress)}%</span>
                {task.status === 'failed' && (
                  <button onClick={() => void uploadOne(task)} className="text-muted-foreground hover:text-foreground">
                    <RotateCcw className="h-4 w-4" />
                  </button>
                )}
              </div>
              {task.error && <p className="mt-1 text-xs text-destructive">{task.error}</p>}
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {statusCounts.uploading > 0 && `${t('upload.uploading')} ${statusCounts.uploading} · `}
          {statusCounts.completed > 0 && `${t('upload.completed')} ${statusCounts.completed} · `}
          {statusCounts.failed > 0 && `${t('upload.failed')} ${statusCounts.failed}`}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // 先真实中止在途 XHR（Network 面板可见 canceled），再标 paused
              tasks.forEach((t) => {
                if (t.status === 'uploading') controllersRef.current.get(t.id)?.abort();
              });
              setTasks((prev) =>
                prev.map((t) =>
                  t.status === 'uploading' ? { ...t, status: 'paused' } : t
                )
              );
            }}
          >
            <Pause className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setTasks((prev) => prev.map((t) => (t.status === 'paused' ? { ...t, status: 'pending' } : t)));
            }}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setTasks([])}>
            {t('upload.clearList')}
          </Button>
          <Button size="sm" onClick={onDone}>
            {t('upload.done')} <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** 带进度的 PUT（XMLHttpRequest）；signal 中止时真实取消在途请求 */
export function putWithProgress(
  url: string,
  body: Blob,
  contentType: string,
  onProgress: (p: number) => void,
  signal?: AbortSignal,
  headers?: Record<string, string>
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    // 仅同源请求携带 Cookie：跨域预签名直传在 CORS 通配源下不能启用 credentials 模式
    xhr.withCredentials = url.startsWith('/');
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    if (headers) {
      for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      const res = new Response(xhr.response, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: new Headers({
          'Content-Type': xhr.getResponseHeader('content-type') ?? 'application/json',
          ETag: xhr.getResponseHeader('etag') ?? '',
        }),
      });
      resolve(res);
    };
    xhr.onerror = () => reject(new Error(i18n.t('common.networkError')));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}

export { toast };
