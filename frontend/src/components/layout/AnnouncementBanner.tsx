// 公告横幅：AppShell 顶部展示活跃公告，可关闭并本地持久化
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Info, AlertTriangle, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';

interface Announcement {
  id: string;
  title: string;
  content: string;
  level: 'info' | 'warning' | 'danger';
  active: boolean;
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
  const [dismissed, setDismissed] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem('picumet:dismissed-announcements') || '[]'))
  );

  useEffect(() => {
    let alive = true;
    apiFetch<{ items: Announcement[] }>('/api/public/announcements')
      .then((res) => {
        if (alive) setAnnouncements(res.data.items);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const dismiss = (id: string) => {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    localStorage.setItem('picumet:dismissed-announcements', JSON.stringify([...next]));
  };

  const visible = announcements.filter((a) => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {visible.map((a) => {
        const Icon = levelIcons[a.level] ?? Info;
        return (
          <div
            key={a.id}
            className={cn('animate-fade-in flex items-start gap-2.5 rounded-md border-l-4 px-3 py-2 text-sm', levelStyles[a.level])}
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
