// 文件图标（Iconify / Emoji 可切换，图片可显示缩略图）
import { useState } from 'react';
import { Icon } from '@iconify/react';
import { useTheme } from '@/stores/theme';
import { cn, fileIconName, fileIconEmoji, fileIconColor, isImage } from '@/lib/utils';

export interface FileIconProps {
  name: string;
  type: 'file' | 'folder';
  className?: string;
  preview?: boolean;
  src?: string;
  iconEmoji?: string;
}

// 根据图标框高度为 emoji 选择合适字号，使自定义 emoji 与 emoji 模式图标同样大小、填满框
function emojiSizeFor(className?: string): string {
  const m = className?.match(/h-(\d+(?:\.\d+)?)/);
  const h = m ? parseFloat(m[1]) : 5;
  if (h <= 4) return 'text-xs';
  if (h <= 5) return 'text-base';
  if (h <= 8) return 'text-xl';
  if (h <= 10) return 'text-2xl';
  if (h <= 12) return 'text-4xl';
  if (h <= 14) return 'text-5xl';
  return 'text-6xl';
}

function emojiSpan(emoji: string, className?: string) {
  return (
    <span className={cn('inline-flex items-center justify-center', emojiSizeFor(className), className)}>
      {emoji}
    </span>
  );
}

// 自定义图标类型判定：图片地址（http/https 或 data:image/）或内联 SVG 代码
export function isIconUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || /^data:image\//i.test(s);
}

export function isIconSvg(s: string): boolean {
  return /<svg[\s/>]/i.test(s);
}

// 统一转为 <img> 可渲染地址：URL 原样返回；SVG 代码编码为 data URL（脚本不会执行）；其余视为 emoji 文本
export function iconToSrc(s: string): string | null {
  if (isIconUrl(s)) return s;
  if (isIconSvg(s)) return `data:image/svg+xml;utf8,${encodeURIComponent(s)}`;
  return null;
}

export default function FileIcon({ name, type, className, preview, src, iconEmoji }: FileIconProps) {
  const { fileIcons } = useTheme();
  // 记录加载失败的缩略图/图标地址，避免同一地址重复尝试
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [failedIconSrc, setFailedIconSrc] = useState<string | null>(null);

  const showImage =
    preview && type !== 'folder' && isImage(name) && !!src && failedSrc !== src;

  if (showImage) {
    return (
      <img
        src={src}
        alt={name}
        onError={() => setFailedSrc(src ?? null)}
        className={cn('object-cover', className)}
      />
    );
  }

  // 用户自定义图标优先显示：图片/SVG 用 <img> 承载，emoji 文本按原样渲染
  const iconSrc = iconEmoji ? iconToSrc(iconEmoji) : null;
  if (iconSrc && failedIconSrc !== iconSrc) {
    return (
      <img
        src={iconSrc}
        alt={name}
        onError={() => setFailedIconSrc(iconSrc)}
        className={cn('object-contain', className)}
      />
    );
  }
  if (iconEmoji && !iconSrc) {
    return emojiSpan(iconEmoji, className);
  }
  // 自定义图标为图片但加载失败 → 回退默认图标

  const colorClass = fileIconColor(name, type);

  if (type === 'folder') {
    return fileIcons === 'iconify' ? (
      <Icon icon="mdi:folder" className={cn(colorClass, className)} />
    ) : (
      emojiSpan('📁', cn(colorClass, className))
    );
  }

  return fileIcons === 'iconify' ? (
    <Icon icon={fileIconName(name, type)} className={cn(colorClass, className)} />
  ) : (
    emojiSpan(fileIconEmoji(name, type), cn(colorClass, className))
  );
}
