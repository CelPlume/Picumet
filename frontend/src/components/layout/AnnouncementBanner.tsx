// 公告横幅 + 临时弹窗（§27）：
// - banner 常驻横幅：AppShell 顶部展示，可关闭并本地持久化
// - toast 临时弹窗：经 toast 系统展示片刻自动关闭，支持标题/内容与频率（once/interval）或窗口（until/duration）
// 显示时长策略（display_mode）：always 总是 / daily 当日 / interval 每 x 间隔 / until 到 expires_at / duration 发布后 x 秒。
// 关闭与展示记录均本地持久化（旧版数组结构迁移为带时间戳的映射）。
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Info, AlertTriangle, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast';

interface Announcement {
  id: string;
  title: string;
  content: string;
  level: 'info' | 'warning' | 'danger';
  active: boolean;
  createdAt?: number;
  displayMode?: 'always' | 'daily' | 'interval' | 'until' | 'duration' | 'once';
  intervalSeconds?: number;
  endsAt?: number;
  kind?: 'banner' | 'toast';
}

/** id → 关闭/展示时间戳（ms） */
type DismissMap = Record<string, number>;

const BANNER_KEY = 'picumet:dismissed-announcements';
const TOAST_KEY = 'picumet:toast-announcements';

function loadMap(key: string): DismissMap {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DismissMap | string[];
    // 旧版数组（无时间戳）→ 0：always 语义下仍视为已关闭；daily/interval 按时间窗口判断
    if (Array.isArray(parsed)) return Object.fromEntries(parsed.map((id) => [id, 0]));
    return parsed;
  } catch {
    return {};
  }
}

/** 窗口 + 频率判定：banner 的关闭记录 / toast 的展示记录统一走此规则 */
function isVisible(a: Announcement, markedAt: number | undefined, now: number): boolean {
  const mode = a.displayMode ?? 'always';
  if (mode === 'until' || mode === 'duration') {
    const end = mode === 'until' ? (a.endsAt ?? 0) : (a.createdAt ?? 0) + (a.intervalSeconds ?? 0) * 1000;
    if (end && now >= end) return false; // 窗口外自动隐藏
    return markedAt === undefined; // 窗口内：关闭/展示过即不再弹
  }
  if (mode === 'daily') {
    return !(markedAt !== undefined && new Date(markedAt).toDateString() === new Date(now).toDateString());
  }
  if (mode === 'interval') {
    return !(markedAt !== undefined && now - markedAt < (a.intervalSeconds ?? 0) * 1000);
  }
  if (mode === 'once') {
    return markedAt === undefined; // 临时弹窗单次：展示过即不再弹
  }
  return markedAt === undefined; // always
}

const levelStyles = {
  info: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100',
  warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
  danger: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100',
};

const levelIcons = {
  info: Info,
  warning: AlertTriangle,
  danger: AlertCircle,
};

export function AnnouncementBanner() {
  const { t } = useTranslation();
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [dismissed, setDismissed] = useState<DismissMap>(() => loadMap(BANNER_KEY));
  const dispatched = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    apiFetch<{ items: Announcement[] }>('/api/public/announcements')
      .then((res) => {
        if (alive) setAnnouncements(res.data.items);
        // 登录用户：拉取服务端撤回记录，补齐跨设备/清 localStorage 的场景（未登录 401、失败静默走本地）
        return apiFetch<{ ids: string[] }>('/api/users/announcements/dismissed-ids');
      })
      .then((res) => {
        if (!alive) return;
        const now = Date.now();
        setDismissed((prev) => {
          const next: DismissMap = { ...prev };
          let changed = false;
          for (const id of res.data.ids) {
            if (next[id] === undefined) {
              next[id] = now;
              changed = true;
            }
          }
          if (changed) localStorage.setItem(BANNER_KEY, JSON.stringify(next));
          return changed ? next : prev;
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // 临时弹窗（kind=toast）：展示片刻自动关闭；每次加载按频率/窗口判定，展示即记录
  useEffect(() => {
    const now = Date.now();
    const shown = loadMap(TOAST_KEY);
    for (const a of announcements) {
      if (a.kind !== 'toast' || dispatched.current.has(a.id)) continue;
      if (!isVisible({ ...a, displayMode: a.displayMode === 'always' ? 'once' : a.displayMode }, shown[a.id], now)) continue;
      dispatched.current.add(a.id);
      // toast 类型只有 success/error/info：danger→error，warning/info→info
      toast(a.level === 'danger' ? 'error' : 'info', a.content, {
        title: a.title,
        duration: 8000,
      });
      shown[a.id] = now;
    }
    localStorage.setItem(TOAST_KEY, JSON.stringify(shown));
  }, [announcements]);

  const dismiss = (id: string) => {
    const next: DismissMap = { ...dismissed, [id]: Date.now() };
    setDismissed(next);
    localStorage.setItem(BANNER_KEY, JSON.stringify(next));
    // 服务端同步（fire-and-forget）：游客 401 静默；跨设备由 dismissed-ids 拉取补齐
    void apiFetch(`/api/users/announcements/${id}/dismiss`, { method: 'POST', body: { forever: true } }).catch(() => {});
  };

  const now = Date.now();
  const banners = announcements.filter((a) => {
    if ((a.kind ?? 'banner') !== 'banner') return false;
    return isVisible(a, dismissed[a.id], now);
  });
  if (banners.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {banners.map((a) => {
        const Icon = levelIcons[a.level] ?? Info;
        return (
          <div
            key={a.id}
            className={cn('animate-fade-in flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm', levelStyles[a.level])}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium leading-tight">{a.title}</p>
              {a.content && <p className="mt-0.5 text-xs opacity-90">{a.content}</p>}
            </div>
            <button
              onClick={() => dismiss(a.id)}
              className="shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
              aria-label={t('common.dismissAnnouncement')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
