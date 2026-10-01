// 用量展示（个人资料卡 + 右上角头像菜单共用）：
// - progress = 两行文本 + 细进度条（默认）
// - activity = 活动圆环风格的双圆环运动卡片
// 样式档位由外观设置 theme.usageStyle 决定，两处消费点走同一组件避免样式漂移。
// 圆环绘制动效（全部动画档）见 index.css「用量展示」小节。
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Progress } from '@/components/ui/core';
import { useTheme } from '@/stores/theme';
import { formatBytes } from '@/lib/utils';
import { cn } from '@/lib/utils';
import type { Quota } from '@shared/types';

/** 双圆环配色：外环 = 存储（红），内环 = 文件数（青） */
const RING_COLORS = [
  { color: '#FF2D55', tint: '#FF6B8B' },
  { color: '#04C7DD', tint: '#4DDFED' },
];

/** 内外环之间留空（px）：过近会糊成一圈，过远会散开 */
const RING_GAP = 4;

interface RingItem {
  label: string;
  /** 当前值展示文本（含 / 上限） */
  current: string;
  percent: number;
  color: string;
  tint: string;
}

function ActivityRings({ items, size, strokeWidth }: { items: RingItem[]; size: number; strokeWidth: number }) {
  // useId 返回含冒号的 id（:r0:），直接放进 url(#...) 片段引用会解析失败 → 渐变描边不渲染；
  // 清洗掉非字母数字字符作为 SVG id
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'usage-rings';
  return (
    <div
      className="usage-rings relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={items.map((i) => `${i.label} ${Math.round(i.percent)}%`).join(', ')}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <defs>
          {items.map((it, i) => (
            <linearGradient key={i} id={`${gid}-${i}`} x1="0%" x2="100%" y1="0%" y2="100%">
              <stop offset="0%" stopColor={it.color} stopOpacity="1" />
              <stop offset="100%" stopColor={it.tint} stopOpacity="1" />
            </linearGradient>
          ))}
        </defs>
        {items.map((it, i) => {
          // 外环贴近盒缘；内环外缘与外环内缘保持 RING_GAP 空隙（紧凑嵌套）。
          // 外环内缘 = size/2 - strokeWidth，内环半径再减一圈 stroke。
          const outerR = (size - strokeWidth) / 2;
          const r = i === 0 ? outerR : outerR - strokeWidth - RING_GAP;
          const circ = 2 * Math.PI * r;
          const offset = circ * (1 - it.percent / 100);
          return (
            <g key={i}>
              <circle
                className="text-muted/60"
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke="currentColor"
                strokeWidth={strokeWidth}
              />
              <circle
                className="usage-ring-value"
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={`url(#${gid}-${i})`}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeDasharray={circ}
                strokeDashoffset={offset}
                style={
                  {
                    '--ring-circ': String(circ),
                    '--ring-delay': `${i * 160}ms`,
                  } as React.CSSProperties
                }
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** 右侧信息列：每条 = 小号大写标签 + 彩色当前值，两行（实际四行）与圆环同高；
 *  文字右对齐、紧贴圆环左侧（环在右、右对齐卡片） */
function ActivityInfo({ items, size, compact }: { items: RingItem[]; size: number; compact: boolean }) {
  return (
    <div className="usage-info flex min-w-0 flex-col justify-between text-right" style={{ height: size }}>
      {items.map((it) => (
        <div key={it.label}>
          <p className={cn('font-medium uppercase tracking-wide text-muted-foreground', compact ? 'text-[10px]' : 'text-[11px]')}>
            {it.label}
          </p>
          <p className={cn('font-semibold leading-tight', compact ? 'text-sm' : 'text-base')} style={{ color: it.color }}>
            {it.current}
          </p>
        </div>
      ))}
    </div>
  );
}

export function UsageDisplay({ quota, compact = false }: { quota: Quota; compact?: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme();
  if (theme.usageStyle === 'activity') {
    const size = compact ? 72 : 96;
    const strokeWidth = compact ? 7 : 9;
    const items: RingItem[] = [
      {
        label: t('settings.profile.storageSpace'),
        current: `${formatBytes(quota.usedStorage)} / ${formatBytes(quota.maxStorage)}`,
        percent: quota.storagePercent,
        color: RING_COLORS[0].color,
        tint: RING_COLORS[0].tint,
      },
      {
        label: t('settings.filesUsed'),
        current: `${quota.usedFiles} / ${quota.maxFiles}`,
        percent: quota.filesPercent,
        color: RING_COLORS[1].color,
        tint: RING_COLORS[1].tint,
      },
    ];
    return (
      <div className="flex items-center justify-end gap-2">
        <ActivityInfo items={items} size={size} compact={compact} />
        <ActivityRings items={items} size={size} strokeWidth={strokeWidth} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div>
        <div className="mb-1 flex justify-between gap-4 text-xs text-muted-foreground">
          <span>{t('settings.profile.storageSpace')}</span>
          <span className="font-medium text-foreground">{formatBytes(quota.usedStorage)} / {formatBytes(quota.maxStorage)}</span>
        </div>
        <Progress value={quota.storagePercent} className="h-1.5" />
      </div>
      <div>
        <div className="mb-1 flex justify-between gap-4 text-xs text-muted-foreground">
          <span>{t('settings.filesUsed')}</span>
          <span className="font-medium text-foreground">{quota.usedFiles} / {quota.maxFiles}</span>
        </div>
        <Progress value={quota.filesPercent} className="h-1.5" />
      </div>
    </div>
  );
}
