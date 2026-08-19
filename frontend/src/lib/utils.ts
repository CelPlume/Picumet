import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

export function formatDate(ts: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function formatDateTime(ts?: number): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timeAgo(ts?: number): string {
  if (!ts) return '-';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return formatDate(ts);
}

export function fileExt(name: string): string {
  const m = name.toLowerCase().match(/\.[^.]+$/);
  return m ? m[0] : '';
}

export const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif'];
export const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.ogv'];
export const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus'];
export const CODE_EXT = [
  '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.html', '.css', '.json', '.md', '.yaml', '.yml', '.sh', '.sql', '.toml', '.ini', '.xml',
];

export function isImage(name: string) {
  return IMAGE_EXT.includes(fileExt(name));
}
export function isVideo(name: string) {
  return VIDEO_EXT.includes(fileExt(name));
}
export function isAudio(name: string) {
  return AUDIO_EXT.includes(fileExt(name));
}
export function isCode(name: string) {
  return CODE_EXT.includes(fileExt(name));
}

export function fileIconEmoji(name: string, type: string): string {
  if (type === 'folder') return '📁';
  const ext = fileExt(name);
  if (IMAGE_EXT.includes(ext)) return '🖼️';
  if (VIDEO_EXT.includes(ext)) return '🎬';
  if (AUDIO_EXT.includes(ext)) return '🎵';
  if (['.pdf'].includes(ext)) return '📕';
  if (['.doc', '.docx'].includes(ext)) return '📘';
  if (['.xls', '.xlsx', '.csv'].includes(ext)) return '📊';
  if (['.ppt', '.pptx'].includes(ext)) return '📙';
  if (['.zip', '.tar', '.gz', '.rar', '.7z'].includes(ext)) return '🗜️';
  if (CODE_EXT.includes(ext)) return '📄';
  return '📄';
}

export function fileIconColor(name: string, type: string): string {
  if (type === 'folder') return 'text-sky-500';
  const ext = fileExt(name);
  if (IMAGE_EXT.includes(ext)) return 'text-emerald-500';
  if (VIDEO_EXT.includes(ext)) return 'text-rose-500';
  if (AUDIO_EXT.includes(ext)) return 'text-purple-500';
  if (['.pdf'].includes(ext)) return 'text-red-600';
  if (['.doc', '.docx'].includes(ext)) return 'text-blue-600';
  if (['.xls', '.xlsx', '.csv'].includes(ext)) return 'text-green-600';
  if (['.ppt', '.pptx'].includes(ext)) return 'text-orange-500';
  if (['.zip', '.tar', '.gz', '.rar', '.7z'].includes(ext)) return 'text-amber-600';
  if (['.txt', '.log', '.text'].includes(ext)) return 'text-sky-600';
  if (CODE_EXT.includes(ext)) return 'text-slate-600';
  return 'text-muted-foreground';
}

export function fileIconName(name: string, type: string): string {
  if (type === 'folder') return 'mdi:folder';
  const ext = fileExt(name);
  if (IMAGE_EXT.includes(ext)) return 'mdi:file-image';
  if (VIDEO_EXT.includes(ext)) return 'mdi:file-video';
  if (AUDIO_EXT.includes(ext)) return 'mdi:file-music';
  if (['.pdf'].includes(ext)) return 'mdi:file-pdf-box';
  if (['.doc', '.docx'].includes(ext)) return 'mdi:file-word';
  if (['.xls', '.xlsx', '.csv'].includes(ext)) return 'mdi:file-excel';
  if (['.ppt', '.pptx'].includes(ext)) return 'mdi:file-powerpoint';
  if (['.zip', '.tar', '.gz', '.rar', '.7z'].includes(ext)) return 'mdi:archive';
  if (CODE_EXT.includes(ext)) return 'mdi:file-code';
  return 'mdi:file';
}

export function normalizeVirtualPath(p: string): string {
  if (!p) return '/';
  let s = p;
  try {
    s = decodeURIComponent(s);
  } catch {
    /* ignore */
  }
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/+/g, '/').replace(/\/+$/, '');
  return s || '/';
}

export function joinPath(base: string, name: string): string {
  const b = normalizeVirtualPath(base);
  return b === '/' ? `/${name}` : `${b}/${name}`;
}

export function parentOf(path: string): string {
  const p = normalizeVirtualPath(path);
  if (p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}
