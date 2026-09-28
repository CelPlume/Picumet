// 文件预览：图片 / 视频 / 音频 / 代码高亮 / Markdown 渲染 / 纯文本
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileWarning, Link2, Lock, ZoomIn, ZoomOut, RotateCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTheme } from '@/stores/theme';
import type { FileListItem } from '@shared/types';
import { Dialog, Button } from '@/components/ui/core';
import { toast } from '@/components/ui/toast';
import { cn, isImage, isVideo, isAudio, isCode, isMarkdown, isText } from '@/lib/utils';
import { useVerifyPassword, usePreviewMediaUrl } from './data';
import { VideoPreview } from './video-player';
import { MarkdownPreview } from './markdown-preview';
import { CodeSkeleton } from '@/components/ui/skeleton';
import hljs from '@/lib/hljs';
import 'highlight.js/styles/github-dark.css';

// 代码预览体积上限：超过则不做全文转义+高亮（防超大文件卡死页面），引导下载查看
const MAX_CODE_PREVIEW_BYTES = 2 * 1024 * 1024;

/** 超上限提示（代码/Markdown/纯文本共用）与媒体加载失败提示：图标 + 提示 + 下载，复用密码门同款居中布局 */
function PreviewTooLarge({ onDownload, retry = false }: { onDownload?: () => void; retry?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="w-full max-w-sm p-6 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
        <FileWarning className="h-6 w-6 text-muted-foreground" />
      </div>
      <h3 className="mb-2 font-medium">{retry ? t('err.network') : t('files.previewTooLarge')}</h3>
      <p className="mb-4 text-sm text-muted-foreground">{t('files.previewTooLargeHint')}</p>
      <Button onClick={() => onDownload?.()}>
        <Download className="h-4 w-4" /> {t('common.download')}
      </Button>
    </div>
  );
}

export function PreviewModal({
  file,
  onClose,
  onDownload,
  onCopyLink,
  onNavigate,
  listSize = 0,
}: {
  file: FileListItem | null;
  onClose: () => void;
  onDownload?: (f: FileListItem) => void;
  onCopyLink?: (f: FileListItem) => void;
  /** LAB：预览内上一个/下一个（dir=-1/1）；由调用方在显示序列里定位相邻可预览项 */
  onNavigate?: (dir: -1 | 1) => void;
  /** 可预览序列长度（导航按钮的可用性与文案提示用） */
  listSize?: number;
}) {
  const { t } = useTranslation();
  // LAB：预览尺寸模式——fit=适应窗口（默认）/ original=按原始像素显示（舞台可滚动）。
  // 全局开关在个性化设置「预览行为」卡调整（localStorage 记忆）；弹窗内缩放不改写它。
  const previewSizeMode = useTheme((s) => s.previewSizeMode);
  const verify = useVerifyPassword();
  const [password, setPassword] = useState('');
  const [verifiedUrl, setVerifiedUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [content, setContent] = useState<string | null>(null);
  // Markdown / 纯文本预览的原文（md 走 react-markdown 渲染、txt 走 <pre> 文本节点，均不经 innerHTML）
  const [plainContent, setPlainContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // 一次性令牌转 blob 后的本地地址（签名直链可直接交给媒体元素，无需中转）
  const [tokenBlobUrl, setTokenBlobUrl] = useState<string | null>(null);
  // 令牌 → blob 转换失败（含 401/403/404/429）：渲染错误态而不是注定失败的媒体元素
  const [mediaFailed, setMediaFailed] = useState<number | null>(null);
  // 最近一次解析失败的 HTTP 状态码：媒体元素 onError 不携带状态码，用它区分 401/403/404/429 文案
  const resolveStatusRef = useRef<number | null>(null);

  // 退出动画期间 file 已置空，保留最后一份文件供渲染
  const lastFileRef = useRef<FileListItem | null>(null);
  if (file) lastFileRef.current = file;
  const shown = file ?? lastFileRef.current;

  // 无密码文件走签名直链优先解析；密码文件由 verify-password 发一次性令牌（verifiedUrl）
  const passwordlessFile = file && !file.hasPassword ? file : null;
  const resolved = usePreviewMediaUrl(passwordlessFile);
  // 图片原始尺寸（宽图/长图/方图自适应基准；objectURL 加载完成后 onLoad 测量）
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    if (!file) return; // 关闭/退出期间不重置，保证退出帧内容完整
    setVerifiedUrl(null);
    setPassword('');
    setZoom(1);
    setRotation(0);
    setContent(null);
    setPlainContent(null);
    setTooLarge(false);
    setTokenBlobUrl(null);
    setMediaFailed(null);
    setNatural(null);
    resolveStatusRef.current = null;
  }, [file?.id]);

  const rawUrl = verifiedUrl ?? resolved.url;
  // rawUrl 是否为一次性网关令牌（needsToken 来自 /download；密码验证 verifiedUrl 亦为令牌）
  const rawIsToken = !!verifiedUrl || resolved.needsToken;
  const isMedia = !!shown && (isImage(shown.name) || isVideo(shown.name) || isAudio(shown.name));
  const isPreviewableText = !!shown && (isCode(shown.name) || isMarkdown(shown.name) || isText(shown.name));

  // 令牌只能消费一次：这里做**唯一**消费（单次 fetch → blob）。
  // 媒体用 objectURL（本地寻址，可重复 Range/seek）；文本从同一 blob 取 text。
  // 绝不把令牌直接交给 <img>/<video>/fetch 之外的任何消费者（浏览器预加载会与其赛跑）。
  const [tokenBlob, setTokenBlob] = useState<Blob | null>(null);
  useEffect(() => {
    console.log('[dbg] blob effect enter rawUrl=', rawUrl?.slice(0, 50) ?? null, 'isMedia=', isMedia, 'isText=', isPreviewableText);
    setTokenBlob(null);
    setTokenBlobUrl(null);
    setMediaFailed(null);
    if (!rawIsToken || !rawUrl || (!isMedia && !isPreviewableText)) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    fetch(rawUrl, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) {
          resolveStatusRef.current = r.status;
          throw new Error(`preview fetch failed: ${r.status}`);
        }
        return r.blob();
      })
      .then((b) => {
        if (cancelled) return;
        setTokenBlob(b);
        if (isMedia) {
          objectUrl = URL.createObjectURL(b);
          setTokenBlobUrl(objectUrl);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        console.log('[dbg] blob FAIL', String(e).slice(0, 90));
        setMediaFailed(resolveStatusRef.current ?? null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [rawUrl, rawIsToken, isMedia, isPreviewableText]);

  // copy-links / download 解析失败的状态码透传给错误文案
  useEffect(() => {
    if (resolved.errorStatus != null) resolveStatusRef.current = resolved.errorStatus;
  }, [resolved.errorStatus]);

  // 媒体地址：仅接受本地 objectURL（令牌绝不直接进媒体元素）
  const url = tokenBlobUrl;
  const tokenPending = rawIsToken && !tokenBlobUrl && mediaFailed == null;
  console.log('[dbg] render blob=', !!tokenBlob, 'plain=', plainContent?.slice(0, 20) ?? null, 'content=', content?.slice(0, 20) ?? null, 'loading=', loadingContent);

  // 媒体元素 onError：按最近一次失败状态码区分提示，而非统一网络错误
  const handleMediaError = () => {
    const status = resolveStatusRef.current;
    resolveStatusRef.current = null;
    const key =
      status === 401
        ? 'err.unauthorized'
        : status === 403
          ? 'err.forbidden'
          : status === 404
            ? 'err.notFound'
            : status === 429
              ? 'err.rateLimit'
              : 'err.network';
    toast('error', t(key));
  };

  // 文本类预览：从已消费的 blob 取文本（2 MiB 上限，超限引导下载）：
  // - 代码：highlight.js 输出本身按规范转义实体（< → &lt;），传原始文本即可；
  // - Markdown：原文交给 react-markdown（默认转义原始 HTML，无 innerHTML 面）；
  // - 纯文本（txt/log）：<pre> 文本节点原样展示，不经任何 HTML 管线。
  // 失败只落 textFailed 布尔（文案在渲染期用 t 计算）——t 不进依赖，避免 i18n 实例
  // 每渲染换引用导致本 effect 无限重跑。
  const [textFailed, setTextFailed] = useState(false);
  useEffect(() => {
    if (!file || !isPreviewableText || !tokenBlob) return;
    if (tokenBlob.size > MAX_CODE_PREVIEW_BYTES) {
      setTooLarge(true);
      return;
    }
    setLoadingContent(true);
    tokenBlob
      .text()
      .then((text) => {
        if (isMarkdown(file.name)) {
          // .md 同时命中 CODE_EXT 与 MARKDOWN_EXT：必须先判 markdown（走格式化渲染），
          // 否则文本写进代码高亮 content，md 分支读 plainContent 恒空 → 预览空白（LAB 用户报告）
          setPlainContent(text);
        } else if (isCode(file.name)) {
          setContent(hljs.highlightAuto(text).value);
        } else {
          setPlainContent(text);
        }
      })
      .catch(() => setTextFailed(true))
      .finally(() => setLoadingContent(false));
  }, [file, tokenBlob, isPreviewableText]);

  const doVerify = async () => {
    if (!shown) return;
    const res = await verify.mutateAsync({ id: shown.id, password });
    setVerifiedUrl(res.url);
    if (isVideo(shown.name) && videoRef.current) void videoRef.current.play();
  };

  const ext = shown?.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  const codeLang = ext.replace('.', '');

  // LAB：图片尺寸两档——
  //   fit（默认，含宽图/长图/方图）：object-contain 一次成型，整图完整落在窗口内，绝不出现
  //   「竖图高过窗口需上下滚动」「16:9 宽度顶满」——原始尺寸仅作装饰性信息；
  //   original：按原始像素显示（width=natural），舞台 overflow-auto 滚动查看。
  //   两档都支持缩放（放大缩小按钮，zoom 仅本地状态，不改全局尺寸模式）：
  //   fit 档 zoom>1 时内层撑大为 zoom×100%（布局式放大，保持 contain，四向皆可滚动）；
  //   original 档 width=natural×zoom。zoom=1 时 fit 内层必须 h-full/w-full
  //  （不能 min-h-full：那会让父被 img 撑开、max-h-full 百分比失去基准 → 竖图溢出窗口）。
  const isFit = previewSizeMode === 'fit';
  const stageRef = useRef<HTMLDivElement>(null);
  // fit 档放大后内层超出舞台：缩放变化时把滚动位置居中，保证四向内容都可达
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !isFit) return;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  }, [isFit, zoom, shown?.id]);
  const imageSizing = isFit
    ? {
        className: 'max-h-full max-w-full object-contain',
        style: { transform: `rotate(${rotation}deg)` },
      }
    : {
        className: 'object-contain',
        style: {
          width: natural ? natural.w * zoom : undefined,
          maxWidth: 'none',
          transform: `rotate(${rotation}deg)`,
        },
      };
  const fitStageStyle = isFit && zoom > 1 ? { width: `${zoom * 100}%`, height: `${zoom * 100}%` } : undefined;

  return (
    <Dialog open={!!file} onClose={onClose} width="w-[min(1400px,94vw)]" title={shown?.name}>
      {shown && (
        <>
          <div className="flex h-[min(72vh,780px)] min-h-0 items-center justify-center overflow-hidden rounded-md bg-black/5 dark:bg-black/40">
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
              // LAB：fit=object-contain 一次成型（zoom=1 不滚动，zoom>1 内层撑大可滚动）；
              // original=按原始像素 + 舞台可滚动。fit 的内层在 zoom=1 时必须是 h-full/w-full
              // （不能 min-h-full：那会让父被 img 撑开、max-h-full 百分比失去基准 → 竖图溢出窗口）。
              <div ref={stageRef} className="h-full min-h-0 w-full overflow-auto">
                <div
                  className={cn('flex items-center justify-center', isFit ? 'h-full w-full' : 'min-h-full min-w-full')}
                  style={fitStageStyle}
                >
                  {tokenPending ? (
                    <CodeSkeleton />
                  ) : mediaFailed != null ? (
                    <PreviewTooLarge onDownload={() => onDownload?.(shown)} retry />
                  ) : (
                    <img
                      src={url ?? ''}
                      alt={shown.name}
                      onError={handleMediaError}
                      onLoad={(e) => {
                        // 测原始尺寸：original 档按它渲染
                        const el = e.currentTarget;
                        if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                          setNatural({ w: el.naturalWidth, h: el.naturalHeight });
                        }
                      }}
                      // fit：object-contain 一次成型（不滚动）；original：原始像素宽（可滚动）
                      className={imageSizing.className}
                      style={imageSizing.style as React.CSSProperties}
                      draggable={false}
                    />
                  )}
                </div>
              </div>
            ) : isVideo(shown.name) ? (
              <VideoPreview
                src={url ?? ''}
                onError={handleMediaError}
                fit={isFit}
                onErrorRetry={mediaFailed != null}
                onRetryDownload={() => onDownload?.(shown)}
                tokenPending={tokenPending}
              />
            ) : isAudio(shown.name) ? (
              <div className="w-full max-w-md p-6 text-center">
                <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 text-4xl">🎵</div>
                {tokenPending ? (
                  <CodeSkeleton />
                ) : mediaFailed != null ? (
                  <PreviewTooLarge onDownload={() => onDownload?.(shown)} retry />
                ) : (
                  <audio ref={audioRef} src={url ?? ''} controls onError={handleMediaError} className="w-full" />
                )}
              </div>
            ) : isMarkdown(shown.name) ? (
              loadingContent || (rawIsToken && !tokenBlob && mediaFailed == null) ? (
                <CodeSkeleton />
              ) : mediaFailed != null || tooLarge || textFailed ? (
                <PreviewTooLarge onDownload={() => onDownload?.(shown)} retry={mediaFailed != null} />
              ) : (
                <MarkdownPreview content={plainContent ?? ''} />
              )
            ) : isCode(shown.name) ? (
              loadingContent || (rawIsToken && !tokenBlob && mediaFailed == null) ? (
                <CodeSkeleton />
              ) : mediaFailed != null || tooLarge || textFailed ? (
                <PreviewTooLarge onDownload={() => onDownload?.(shown)} retry={mediaFailed != null} />
              ) : (
                <pre className="h-full w-full overflow-auto p-4 text-sm scrollbar-thin">
                  <code className={`language-${codeLang}`} dangerouslySetInnerHTML={{ __html: content ?? '' }} />
                </pre>
              )
            ) : isText(shown.name) ? (
              loadingContent || (rawIsToken && !tokenBlob && mediaFailed == null) ? (
                <CodeSkeleton />
              ) : mediaFailed != null || tooLarge || textFailed ? (
                <PreviewTooLarge onDownload={() => onDownload?.(shown)} retry={mediaFailed != null} />
              ) : (
                // 纯文本走 React 文本节点：任何内容都不进 HTML 管线
                <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-words p-4 text-sm leading-relaxed scrollbar-thin">
                  {plainContent ?? ''}
                </pre>
              )
            ) : (
              <div className="text-center text-muted-foreground">
                <p className="mb-2">{t('common.cannotPreview')}</p>
                <Button variant="outline" onClick={() => onDownload?.(shown)}>
                  <Download className="h-4 w-4" /> {t('common.download')}
                </Button>
              </div>
            )}
          </div>

          {/* LAB：媒体预览底部操作行——上一个/下一个 + 缩放/旋转（两档均可用）+ 复制/下载；关闭交给 Dialog 头部 ×/Esc/遮罩。尺寸模式在个性化设置里调整 */}
          <div className="mt-3 flex items-center justify-center gap-2">
            {(isImage(shown.name) || isVideo(shown.name)) && onNavigate && listSize > 1 && (
              <>
                <Button variant="ghost" size="sm" onClick={() => onNavigate(-1)} aria-label={t('files.prevItem')} title={t('files.prevItem')}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onNavigate(1)} aria-label={t('files.nextItem')} title={t('files.nextItem')}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </>
            )}
            {isImage(shown.name) && (
              // LAB：缩放/旋转两档均可用——zoom 是弹窗本地状态（fit 档布局式放大、original 档
              // 原始像素×zoom），不再改写个性化设置里的全局尺寸模式
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}
                  aria-label={t('common.zoomOut')}
                  title={t('common.zoomOut')}
                >
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.1) * 10) / 10))}
                  aria-label={t('common.zoomIn')}
                  title={t('common.zoomIn')}
                >
                  <ZoomIn className="h-4 w-4" />
                </Button>
                {/* rotation 单调递增：transform 永远走累计角度的正向旋转 */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRotation((r) => r + 90)}
                  aria-label={t('common.rotate')}
                  title={t('common.rotate')}
                >
                  <RotateCw className="h-4 w-4" />
                </Button>
              </>
            )}
            <Button variant="outline" size="sm" onClick={() => onCopyLink?.(shown)}>
              <Link2 className="h-4 w-4" /> {t('common.copy')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => onDownload?.(shown)}>
              <Download className="h-4 w-4" /> {t('common.download')}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

export { toast };
