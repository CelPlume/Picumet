// 文件预览：图片 / 视频 / 音频 / 代码高亮
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Link2, Lock, X, ZoomIn, ZoomOut, RotateCw } from 'lucide-react';
import type { FileListItem } from '@shared/types';
import { Dialog, Button, Spinner } from '@/components/ui/core';
import { toast } from '@/components/ui/toast';
import { isImage, isVideo, isAudio, isCode } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { useVerifyPassword } from './data';
import { VideoPreview } from './video-player';
import { CodeSkeleton } from '@/components/ui/skeleton';
import { escapeHtml } from '@/lib/escape';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import 'highlight.js/styles/github-dark.css';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('bash', bash);

export function PreviewModal({
  file,
  onClose,
  onDownload,
  onCopyLink,
}: {
  file: FileListItem | null;
  onClose: () => void;
  onDownload?: (f: FileListItem) => void;
  onCopyLink?: (f: FileListItem) => void;
}) {
  const { t } = useTranslation();
  const verify = useVerifyPassword();
  const [password, setPassword] = useState('');
  const [verifiedUrl, setVerifiedUrl] = useState<string | null>(null);
  const [contentUrl, setContentUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [content, setContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // 退出动画期间 file 已置空，保留最后一份文件供渲染
  const lastFileRef = useRef<FileListItem | null>(null);
  if (file) lastFileRef.current = file;
  const shown = file ?? lastFileRef.current;

  useEffect(() => {
    if (!file) return; // 关闭/退出期间不重置，保证退出帧内容完整
    setVerifiedUrl(null);
    setContentUrl(null);
    setPassword('');
    setZoom(1);
    setRotation(0);
    setContent(null);
  }, [file?.id]);

  // 无密码文件：解析真实下载 URL（download 端点返回 {url}，需先取网关地址）
  useEffect(() => {
    if (!file || file.hasPassword) return;
    let cancelled = false;
    apiFetch<{ url: string }>(`/api/files/${file.id}/download`)
      .then((res) => {
        if (!cancelled) setContentUrl(res.data.url);
      })
      .catch(() => {
        if (!cancelled) setContentUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [file?.id]);

  const url = useMemo(() => verifiedUrl ?? contentUrl, [verifiedUrl, contentUrl]);

  // 代码文件加载纯文本（先 HTML 转义再高亮，双重防注入）
  useEffect(() => {
    if (!file || !isCode(file.name) || !url) return;
    setLoadingContent(true);
    fetch(url, { credentials: 'include' })
      .then((r) => r.text())
      .then((text) => {
        // highlight.js 默认会转义，这里先行转义作为纵深防御，
        // 确保任何语言定义/高亮路径都不会把原始 <script> 带进 innerHTML
        const highlighted = hljs.highlightAuto(escapeHtml(text)).value;
        setContent(highlighted);
      })
      .catch(() => setContent('<span>无法加载</span>'))
      .finally(() => setLoadingContent(false));
  }, [file, url]);

  const doVerify = async () => {
    if (!shown) return;
    const res = await verify.mutateAsync({ id: shown.id, password });
    setVerifiedUrl(res.url);
    if (isVideo(shown.name) && videoRef.current) void videoRef.current.play();
  };

  const ext = shown?.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  const codeLang = ext.replace('.', '');

  return (
    <Dialog open={!!file} onClose={onClose} width="w-[min(1400px,94vw)]" title={shown?.name}>
      {shown && (
        <>
          <div className="flex h-[min(72vh,780px)] items-center justify-center overflow-hidden bg-black/5 dark:bg-black/40 rounded-md">
            {shown.hasPassword && !verifiedUrl ? (
              <div className="w-full max-w-sm p-6 text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                  <Lock className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="mb-2 font-medium">{t('files.passwordPrompt')}</h3>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('files.passwordPlaceholder')}
                    className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                    onKeyDown={(e) => e.key === 'Enter' && doVerify()}
                    autoFocus
                  />
                  <Button onClick={doVerify} loading={verify.isPending}>
                    {t('files.verify')}
                  </Button>
                </div>
                {verify.isError && <p className="mt-2 text-sm text-destructive">{t('err.invalidPassword')}</p>}
              </div>
            ) : isImage(shown.name) ? (
              <div className="relative flex h-full w-full items-center justify-center">
                <img
                  src={url ?? ''}
                  alt={shown.name}
                  className="max-h-[52vh] max-w-full object-contain transition-transform"
                  style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
                />
                {/* 控件固定于底部且置于图片之上，避免被放大后的图片遮挡 */}
                <div className="glass-surface glass-blur absolute bottom-2 left-1/2 z-20 -translate-x-1/2 flex items-center gap-1 rounded-md border p-1 shadow">
                  <Button variant="ghost" size="sm" onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))} aria-label="缩小">
                    <ZoomOut className="h-4 w-4" />
                  </Button>
                  <span className="w-12 text-center text-xs">{Math.round(zoom * 100)}%</span>
                  <Button variant="ghost" size="sm" onClick={() => setZoom((z) => Math.min(3, z + 0.1))} aria-label="放大">
                    <ZoomIn className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRotation((r) => (r + 90) % 360)} aria-label="旋转">
                    <RotateCw className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : isVideo(shown.name) ? (
              <VideoPreview src={url ?? ''} onError={() => { setVerifiedUrl(null); toast('error', t('err.network')); }} />
            ) : isAudio(shown.name) ? (
              <div className="w-full max-w-md p-6 text-center">
                <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 text-4xl">🎵</div>
                <audio ref={audioRef} src={url ?? ''} controls className="w-full" />
              </div>
            ) : isCode(shown.name) ? (
              loadingContent ? (
                <CodeSkeleton />
              ) : (
                <pre className="h-full w-full overflow-auto p-4 text-sm scrollbar-thin">
                  <code className={`language-${codeLang}`} dangerouslySetInnerHTML={{ __html: content ?? '' }} />
                </pre>
              )
            ) : (
              <div className="text-center text-muted-foreground">
                <p className="mb-2">无法预览此文件类型</p>
                <Button variant="outline" onClick={() => onDownload?.(shown)}>
                  <Download className="h-4 w-4" /> {t('common.download')}
                </Button>
              </div>
            )}
          </div>

          <div className="mt-3 flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onCopyLink?.(shown)}>
              <Link2 className="h-4 w-4" /> {t('common.copy')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => onDownload?.(shown)}>
              <Download className="h-4 w-4" /> {t('common.download')}
            </Button>
            <Button size="sm" onClick={onClose}>
              <X className="h-4 w-4" /> {t('common.close')}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

export { toast };
