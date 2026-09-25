// 落地页里的产品模拟界面：文件管理器（首屏倾斜舞台）与管理后台（管理区块）。
// 纯展示：数据是写死的示例，文案复用应用本身的 i18n key，与真实界面同名同义。
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronRight,
  Database,
  Files,
  Folder,
  HardDrive,
  LayoutDashboard,
  LayoutGrid,
  List,
  ScrollText,
  Search,
  Settings,
  Share2,
  Shield,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Thumb, type ThumbTone } from './Thumb';
import { SHARE_QR_PATH, SHARE_QR_SIZE } from './share-qr';

function WindowBar({ title }: { title: string }): JSX.Element {
  return (
    <div className="flex h-9 items-center gap-2 border-b px-3">
      <span className="size-2.5 rounded-full bg-foreground/15" />
      <span className="size-2.5 rounded-full bg-foreground/15" />
      <span className="size-2.5 rounded-full bg-foreground/15" />
      <span className="lp-mono ml-3 truncate text-[11px] text-muted-foreground">{title}</span>
    </div>
  );
}

const PHOTOS: Array<{ name: string; size: string; tone: ThumbTone }> = [
  { name: 'aurora.jpg', size: '4.2 MB', tone: 'dusk' },
  { name: 'harbor.png', size: '2.8 MB', tone: 'ocean' },
  { name: 'ridge.jpg', size: '3.1 MB', tone: 'forest' },
  { name: 'dune.webp', size: '1.6 MB', tone: 'sand' },
  { name: 'ember.jpg', size: '5.0 MB', tone: 'sunset' },
  { name: 'quarry.jpg', size: '2.2 MB', tone: 'stone' },
];

/** 首屏文件管理器：侧栏挂载点 + 卡片网格 + 浮起的上传与分享面板 */
export function FileManagerMock(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="relative" style={{ transformStyle: 'preserve-3d' }}>
      <div className="lp-window w-[min(980px,92vw)] max-md:w-full">
        <WindowBar title="pic.example.com/files/drive/photos" />
        <div className="grid grid-cols-[180px_minmax(0,1fr)] max-md:grid-cols-1">
          <aside className="lp-bg-sunken border-r p-3 max-md:hidden">
            {[
              { path: '/drive', bucket: 'r2-main', active: true },
              { path: '/archive', bucket: 's3-archive' },
              { path: '/public', bucket: 'minio-lab' },
            ].map((m) => (
              <div
                key={m.path}
                className={cn('mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs', m.active && 'bg-background shadow-sm')}
              >
                <HardDrive className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{m.path}</span>
                <span className="lp-mono ml-auto truncate text-[10px] text-muted-foreground">{m.bucket}</span>
              </div>
            ))}
          </aside>
          <div className="p-4">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>drive</span>
                <ChevronRight className="size-3" />
                <span className="font-medium text-foreground">photos</span>
              </div>
              <div className="ml-auto flex h-7 w-44 items-center gap-1.5 rounded-full border px-2.5 text-[11px] text-muted-foreground max-sm:hidden">
                <Search className="size-3" />
                {t('files.searchPlaceholder')}
              </div>
              <div className="flex rounded-full border p-0.5">
                <span className="rounded-full bg-foreground/10 p-1">
                  <LayoutGrid className="size-3" />
                </span>
                <span className="p-1 text-muted-foreground">
                  <List className="size-3" />
                </span>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3 max-sm:grid-cols-3">
              <div className="flex flex-col items-center justify-center gap-1 rounded-lg border p-2">
                <Folder className="size-9 text-primary" />
                <span className="text-[11px] font-medium">raw</span>
              </div>
              {PHOTOS.map((p) => (
                <div key={p.name} className="rounded-lg border p-1.5">
                  <div className="aspect-[4/3] overflow-hidden rounded-md">
                    <Thumb tone={p.tone} />
                  </div>
                  <p className="mt-1 truncate text-[11px] font-medium">{p.name}</p>
                  <p className="text-[10px] text-muted-foreground">{p.size}</p>
                </div>
              ))}
              <div className="rounded-lg border border-primary/60 bg-primary/5 p-1.5 max-sm:hidden">
                <div className="aspect-[4/3] overflow-hidden rounded-md">
                  <Thumb tone="ocean" />
                </div>
                <p className="mt-1 truncate text-[11px] font-medium">tide.jpg</p>
                <p className="text-[10px] text-muted-foreground">3.4 MB</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 浮起的上传面板 */}
      <div className="lp-floating absolute -right-10 top-24 w-64 p-3 max-lg:hidden" style={{ transform: 'translateZ(70px)' }}>
        <p className="flex items-center gap-2 text-xs font-medium">
          <Upload className="size-3.5" /> {t('upload.uploading')}
        </p>
        {[
          { name: 'glacier.jpg', v: 0.72 },
          { name: 'night-run.mp4', v: 0.38 },
          { name: 'notes.pdf', v: 1 },
        ].map((f) => (
          <div key={f.name} className="mt-2.5">
            <div className="flex justify-between text-[10px]">
              <span className="truncate">{f.name}</span>
              <span className="lp-num text-muted-foreground">{Math.round(f.v * 100)}%</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-foreground/10">
              <div className="h-full rounded-full bg-primary" style={{ width: `${f.v * 100}%` }} />
            </div>
          </div>
        ))}
      </div>

      {/* 浮起的分享卡片 */}
      <div className="lp-floating absolute -bottom-10 left-10 flex w-72 gap-3 p-3 max-lg:hidden" style={{ transform: 'translateZ(110px)' }}>
        <svg viewBox={`-2 -2 ${SHARE_QR_SIZE + 4} ${SHARE_QR_SIZE + 4}`} className="size-20 shrink-0 rounded-md bg-white p-1 text-black" aria-hidden>
          <path d={SHARE_QR_PATH} fill="currentColor" />
        </svg>
        <div className="min-w-0 text-[11px]">
          <p className="flex items-center gap-1.5 font-medium">
            <Share2 className="size-3.5" /> {t('share.link')}
          </p>
          <p className="lp-mono mt-1 truncate text-muted-foreground">pic.example.com/s/q7Lm2x</p>
          <p className="mt-2 text-muted-foreground">
            {t('share.expiresIn')} · {t('share.days7')}
          </p>
          <p className="text-muted-foreground">{t('share.downloads', { used: 3, max: 20 })}</p>
        </div>
      </div>
    </div>
  );
}

/** 管理后台：侧栏 + 指标 + 桶泳道 + 审核队列 */
export function DashboardMock(): JSX.Element {
  const { t } = useTranslation();
  const nav = [
    { icon: LayoutDashboard, key: 'dashboard', active: true },
    { icon: Users, key: 'users' },
    { icon: Database, key: 'storage' },
    { icon: Shield, key: 'permissions' },
    { icon: Share2, key: 'shares' },
    { icon: Files, key: 'files' },
    { icon: ScrollText, key: 'logs' },
    { icon: Settings, key: 'settings' },
  ];
  const stats = [
    { label: t('admin.totalUsers'), value: '128' },
    { label: t('admin.totalFiles'), value: '24,310' },
    { label: t('admin.dashboard.bucketCount'), value: '3' },
    { label: t('admin.dashboard.activeMounts'), value: '5' },
  ];
  const lanes = [
    { bucket: 'r2-main', mounts: ['/drive', '/public'], used: 0.62 },
    { bucket: 's3-archive', mounts: ['/drive', '/archive'], used: 0.38 },
    { bucket: 'minio-lab', mounts: ['/lab'], used: 0.21 },
  ];
  return (
    <div className="lp-window w-[min(960px,92vw)] max-md:w-full">
      <WindowBar title="pic.example.com/admin" />
      <div className="grid grid-cols-[170px_minmax(0,1fr)] max-md:grid-cols-1">
        <aside className="lp-bg-sunken border-r p-2.5 max-md:hidden">
          {nav.map(({ icon: Icon, key, active }) => (
            <div key={key} className={cn('mb-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs', active ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}>
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{t(`admin.nav.${key}`)}</span>
            </div>
          ))}
        </aside>
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-4 divide-x rounded-lg border max-sm:grid-cols-2 max-sm:divide-x-0">
            {stats.map((s) => (
              <div key={s.label} className="p-3">
                <p className="truncate text-[10px] text-muted-foreground">{s.label}</p>
                <p className="lp-num mt-1 text-lg font-semibold tracking-tight">{s.value}</p>
              </div>
            ))}
          </div>
          <div className="rounded-lg border p-3">
            <p className="mb-3 text-[11px] font-medium">{t('admin.dashboard.bucketCount')}</p>
            <div className="space-y-2.5">
              {lanes.map((l) => (
                <div key={l.bucket} className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-3">
                  <div>
                    <p className="lp-mono truncate text-[10px]">{l.bucket}</p>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-foreground/10">
                      <div className="h-full bg-primary" style={{ width: `${l.used * 100}%` }} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-px flex-1 bg-border" />
                    {l.mounts.map((m) => (
                      <span key={m} className="lp-mono rounded-full border px-2 py-0.5 text-[10px]">
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border">
            <p className="border-b px-3 py-2 text-[11px] font-medium">{t('admin.allFiles.pendingReview')}</p>
            {[
              { name: 'poster-final.png', user: 'mika', tone: 'sunset' as const },
              { name: 'team-offsite.jpg', user: 'jun', tone: 'forest' as const },
            ].map((r) => (
              <div key={r.name} className="flex items-center gap-2.5 border-b px-3 py-2 last:border-b-0">
                <span className="size-7 shrink-0 overflow-hidden rounded">
                  <Thumb tone={r.tone} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-medium">{r.name}</span>
                  <span className="block text-[10px] text-muted-foreground">@{r.user}</span>
                </span>
                <span className="lp-ok flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]">
                  <Check className="size-3" /> {t('admin.allFiles.approve')}
                </span>
                <span className="lp-bad flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] max-sm:hidden">
                  <X className="size-3" /> {t('admin.allFiles.reject')}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
