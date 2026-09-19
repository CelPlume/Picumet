// 上传弹窗：拖拽、多文件并发、进度条、Worker/预签名双模式
import { useEffect, useRef, useState } from 'react';
import { UploadCloud, X, Pause, Play, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Progress, Dialog } from '@/components/ui/core';
import { toast } from '@/components/ui/toast';
import { initUploadSession, completeUpload } from './data';
import { getCsrfToken, ApiError } from '@/lib/api';
import { cn, formatBytes, fileIconEmoji } from '@/lib/utils';

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
    update(task.id, { status: 'uploading', error: undefined, progress: 0 });
    try {
      const session = await initUploadSession({
        path: targetPath,
        fileName: task.name,
        fileSize: task.size,
        mimeType: task.mime,
      });

      let etag: string;
      if (session.uploadMode === 'presigned' && session.uploadUrl) {
        const res = await putWithProgress(session.uploadUrl, task.file, task.mime, (p) => update(task.id, { progress: p }));
        if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', `上传失败（${res.status}）`);
        etag = res.headers.get('etag') ?? 'etag';
      } else {
        // Worker 代理上传
        const csrf = await getCsrfToken();
        const res = await putWithProgress(`/api/files/upload/raw/${session.sessionId}`, task.file, task.mime, (p) =>
          update(task.id, { progress: p * 0.9 })
        );
        if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', `上传失败（${res.status}）`);
        const body = (await res.json()) as { data?: { etag?: string } };
        etag = body.data?.etag ?? 'etag';
      }

      await completeUpload({ sessionId: session.sessionId, etag });
      update(task.id, { status: 'completed', progress: 100 });
    } catch (err) {
      update(task.id, { status: 'failed', error: err instanceof Error ? err.message : '上传失败' });
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

/** 带进度的 PUT（XMLHttpRequest） */
export function putWithProgress(
  url: string,
  body: Blob,
  contentType: string,
  onProgress: (p: number) => void
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.withCredentials = true;
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
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
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(body);
  });
}

export { toast };
