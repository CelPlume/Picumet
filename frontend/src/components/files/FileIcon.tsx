// 文件图标（Iconify / Emoji 可切换，图片可显示缩略图）
import { useState } from 'react';
import { Icon } from '@iconify/react';
import { useTheme } from '@/stores/theme';
import { cn, fileIconName, fileIconEmoji, isImage } from '@/lib/utils';

export interface FileIconProps {
  name: string;
  type: 'file' | 'folder';
  className?: string;
  preview?: boolean;
  src?: string;
}

export default function FileIcon({ name, type, className, preview, src }: FileIconProps) {
  const { fileIcons } = useTheme();
  // 记录加载失败的缩略图地址，避免同一地址重复尝试
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

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

  if (type === 'folder') {
    return fileIcons === 'iconify' ? (
      <Icon icon="mdi:folder" className={className} />
    ) : (
      <span className={className}>📁</span>
    );
  }

  return fileIcons === 'iconify' ? (
    <Icon icon={fileIconName(name, type)} className={className} />
  ) : (
    <span className={className}>{fileIconEmoji(name, type)}</span>
  );
}
