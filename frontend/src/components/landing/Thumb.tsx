// 落地页模拟界面里的「照片」缩略图：纯 SVG 风景插画，不依赖外部图片
import { useId } from 'react';
import { cn } from '@/lib/utils';

const TONES = {
  sunset: ['#fed7aa', '#fb923c', '#fff7ed', '#c2410c', '#7c2d12'],
  ocean: ['#e0f2fe', '#38bdf8', '#f0f9ff', '#0369a1', '#0c4a6e'],
  forest: ['#ecfccb', '#84cc16', '#f7fee7', '#4d7c0f', '#1a2e05'],
  dusk: ['#ede9fe', '#8b5cf6', '#faf5ff', '#6d28d9', '#2e1065'],
  stone: ['#f4f4f5', '#a1a1aa', '#fafafa', '#52525b', '#18181b'],
  sand: ['#fef3c7', '#f59e0b', '#fffbeb', '#b45309', '#451a03'],
} as const;

export type ThumbTone = keyof typeof TONES;

export function Thumb({ tone, className }: { tone: ThumbTone; className?: string }): JSX.Element {
  const [skyTop, skyBottom, sun, hillA, hillB] = TONES[tone];
  // useId 含冒号，url(#…) 引用前去掉
  const id = `lp-sky-${useId().replace(/:/g, '')}`;
  return (
    <svg viewBox="0 0 160 120" preserveAspectRatio="xMidYMid slice" className={cn('block size-full', className)} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={skyTop} />
          <stop offset="1" stopColor={skyBottom} />
        </linearGradient>
      </defs>
      <rect width="160" height="120" fill={`url(#${id})`} />
      <circle cx="112" cy="40" r="15" fill={sun} opacity="0.92" />
      <path d="M0 84 L34 56 L60 78 L96 46 L132 76 L160 62 V120 H0Z" fill={hillA} />
      <path d="M0 100 L40 82 L78 98 L118 80 L160 96 V120 H0Z" fill={hillB} />
    </svg>
  );
}
