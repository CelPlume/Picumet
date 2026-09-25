// 落地页各区块。每个区块自包含，文案全部走 landing.* / 复用应用已有 key。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Code,
  Cookie,
  Copy,
  Database,
  Eye,
  FileCode,
  Fingerprint,
  Gauge,
  KeyRound,
  Languages,
  LockKeyhole,
  Network,
  Palette,
  Plus,
  Route,
  Server,
  ShieldCheck,
  Ticket,
  Timer,
  Zap,
  ZoomIn,
  RotateCw,
  Link2,
  Layers,
  Boxes,
  HardDrive,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ACCENT_PRESETS } from '@/stores/theme';
import { BRAND_MARKS, BrandIcon } from './brands';
import { DashboardMock, FileManagerMock } from './mockups';
import { Thumb } from './Thumb';
import { SHARE_QR_PATH, SHARE_QR_SIZE } from './share-qr';
import {
  CountUp,
  Corners,
  EdgeGlobe,
  SectionHeading,
  docsUrl,
  lpDelay,
  useCycle,
  useIsDark,
  useTicker,
  useVisible,
} from './primitives';

function TwoTone({ a, b }: { a: string; b: string }): JSX.Element {
  return (
    <>
      {a}
      <br />
      <span className="text-muted-foreground">{b}</span>
    </>
  );
}

// ============ Hero ============
export function Hero({ loggedIn }: { loggedIn: boolean }): JSX.Element {
  const { t, i18n } = useTranslation();
  const zh = i18n.language?.startsWith('zh') ?? true;
  return (
    <section className="relative overflow-hidden pt-32 max-md:pt-28">
      <div className="lp-dots pointer-events-none absolute inset-0" aria-hidden />
      <div className="lp-container relative">
        <p className="lp-eyebrow lp-rise">{t('landing.hero.eyebrow')}</p>
        <h1 className="lp-display lp-rise mt-6 max-w-4xl text-[clamp(2.75rem,7.2vw,5.75rem)]" style={lpDelay(80)}>
          {t('landing.hero.titleA')}
          <br />
          <span className="text-muted-foreground">{t('landing.hero.titleB')}</span>
        </h1>
        <p className="lp-lede lp-rise mt-7 text-lg" style={lpDelay(160)}>
          {t('landing.hero.lede')}
        </p>
        <div className="lp-rise mt-9 flex flex-wrap items-center gap-x-6 gap-y-4" style={lpDelay(240)}>
          <Link to={loggedIn ? '/files' : '/login'} className="lp-btn lp-btn-ink">
            {loggedIn ? t('landing.hero.openApp') : t('landing.hero.start')}
            <ArrowRight className="size-4" />
          </Link>
          <a href={docsUrl(zh)} target="_blank" rel="noreferrer" className="lp-link">
            <BookOpen className="size-4" />
            {t('landing.hero.docs')}
            <ArrowUpRight className="size-4" />
          </a>
        </div>
      </div>
      <div className="lp-stage lp-fade-rb relative mt-16 h-[640px] max-md:mt-12 max-md:h-auto max-md:[mask-image:none]">
        <div className="lp-container">
          <div className="lp-tilt lp-tilt-in origin-top-left pl-[6vw] max-md:pl-0">
            <FileManagerMock />
          </div>
        </div>
      </div>
    </section>
  );
}

// ============ 服务商跑马灯 ============
export function Providers(): JSX.Element {
  const { t } = useTranslation();
  const row = BRAND_MARKS.map((b) => (
    <span key={b.id} className="flex shrink-0 items-center gap-2.5 px-8 text-muted-foreground">
      <BrandIcon path={b.path} className="size-5" />
      <span className="whitespace-nowrap text-sm font-medium">{b.name}</span>
    </span>
  ));
  return (
    <section className="border-y py-10">
      <div className="lp-container">
        <p className="text-center text-sm text-muted-foreground" data-reveal>
          {t('landing.providers.label')}
        </p>
      </div>
      <div className="lp-fade-x mt-7 overflow-hidden" data-reveal style={lpDelay(80)}>
        <div className="lp-marquee">
          {row}
          <span aria-hidden className="flex">
            {row}
          </span>
        </div>
      </div>
    </section>
  );
}

// ============ 日常使用：三栏演示面板 ============
export function Workflow(): JSX.Element {
  const { t } = useTranslation();
  const [ref, visible] = useVisible<HTMLDivElement>();
  const tick = useTicker(900, visible);
  const files = [
    { name: 'glacier.jpg', speed: 17 },
    { name: 'night-run.mp4', speed: 9 },
    { name: 'notes.pdf', speed: 31 },
  ];
  return (
    <section id="workflow" className="lp-section">
      <div className="lp-container">
        <SectionHeading
          eyebrow={t('landing.workflow.eyebrow')}
          title={<TwoTone a={t('landing.workflow.titleA')} b={t('landing.workflow.titleB')} />}
          lede={t('landing.workflow.lede')}
        />
        <div ref={ref} className="relative mt-16 grid border-l border-t md:grid-cols-3">
          <Corners />
          {/* 上传 */}
          <div className="border-b border-r p-7" data-reveal>
            <div className="lp-bg-sunken h-52 rounded-xl border p-4">
              {files.map((f, i) => {
                const p = Math.min(100, ((tick * f.speed + i * 23) % 130));
                const done = p >= 100;
                return (
                  <div key={f.name} className="mb-3.5 last:mb-0">
                    <div className="flex justify-between text-xs">
                      <span className="truncate">{f.name}</span>
                      <span className={cn('lp-num', done ? 'lp-ok' : 'text-muted-foreground')}>
                        {done ? t('upload.completed') : `${p}%`}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-foreground/10">
                      <div className={cn('lp-ease h-full rounded-full', done ? 'bg-[hsl(var(--lp-ok))]' : 'bg-primary')} style={{ width: `${p}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <h3 className="mt-6 font-medium">{t('landing.workflow.upload.title')}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t('landing.workflow.upload.desc')}</p>
          </div>
          {/* 整理 */}
          <div className="border-b border-r p-7" data-reveal style={lpDelay(80)}>
            <div className="lp-bg-sunken grid h-52 grid-cols-3 gap-2 rounded-xl border p-3">
              {(['dusk', 'ocean', 'forest', 'sand', 'sunset', 'stone'] as const).map((tone, i) => {
                const selected = (tick % 6) >= i && i < 3 + (tick % 3);
                return (
                  <div key={tone} className={cn('lp-ease overflow-hidden rounded-md border-2', selected ? 'border-primary' : 'border-transparent')}>
                    <Thumb tone={tone} />
                  </div>
                );
              })}
            </div>
            <h3 className="mt-6 font-medium">{t('landing.workflow.organize.title')}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t('landing.workflow.organize.desc')}</p>
          </div>
          {/* 分享 */}
          <div className="border-b border-r p-7" data-reveal style={lpDelay(160)}>
            <div className="lp-bg-sunken flex h-52 items-center gap-4 rounded-xl border p-4">
              <svg viewBox={`-2 -2 ${SHARE_QR_SIZE + 4} ${SHARE_QR_SIZE + 4}`} className="size-24 shrink-0 rounded-md bg-white p-1 text-black" aria-hidden>
                <path d={SHARE_QR_PATH} fill="currentColor" />
              </svg>
              <div className="min-w-0 space-y-1.5 text-xs">
                <p className="lp-mono truncate">/s/q7Lm2x</p>
                <p className="flex items-center gap-1.5 text-muted-foreground">
                  <LockKeyhole className="size-3.5" /> {t('share.password')}
                </p>
                <p className="flex items-center gap-1.5 text-muted-foreground">
                  <Timer className="size-3.5" /> {t('share.days7')}
                </p>
                <p className="lp-num flex items-center gap-1.5 text-muted-foreground">
                  <Eye className="size-3.5" /> {t('share.downloads', { used: 3 + (tick % 5), max: 20 })}
                </p>
              </div>
            </div>
            <h3 className="mt-6 font-medium">{t('landing.workflow.share.title')}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t('landing.workflow.share.desc')}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ============ 存储池 ============
const STRATEGIES = ['leastUsed', 'roundRobin', 'hash', 'freeWeighted', 'ordered'] as const;

export function Pool(): JSX.Element {
  const { t } = useTranslation();
  const [strategy, setStrategy] = useState<(typeof STRATEGIES)[number]>('leastUsed');
  const [ref, visible] = useVisible<HTMLDivElement>();
  const tick = useCycle(6, 1500, visible);
  const buckets = [
    { id: 'r2-main', base: 0.58 },
    { id: 's3-archive', base: 0.34 },
    { id: 'minio-lab', base: 0.46 },
  ];
  // 每档策略的落桶目标（演示用，与策略语义一致）
  const target = (() => {
    switch (strategy) {
      case 'leastUsed':
        return 1;
      case 'roundRobin':
        return tick % 3;
      case 'hash':
        return [2, 0, 2][tick % 3];
      case 'freeWeighted':
        return 1;
      case 'ordered':
        return 0;
    }
  })();
  return (
    <section id="storage" className="lp-section lp-bg-surface border-y">
      <div className="lp-container">
        <SectionHeading
          eyebrow={t('landing.pool.eyebrow')}
          title={<TwoTone a={t('landing.pool.titleA')} b={t('landing.pool.titleB')} />}
          lede={t('landing.pool.lede')}
        />
        <div ref={ref} className="mt-16 grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <div data-reveal>
            <p className="text-xs text-muted-foreground">{t('landing.pool.strategyLabel')}</p>
            <div className="mt-3 divide-y border-y">
              {STRATEGIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStrategy(s)}
                  className={cn('block w-full py-4 text-left transition-colors', strategy === s ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
                >
                  <span className="flex items-center gap-3 text-sm font-medium">
                    <span className={cn('lp-ease size-1.5', strategy === s ? 'bg-primary' : 'bg-transparent')} />
                    {t(`landing.pool.strategies.${s}.name`)}
                  </span>
                  {strategy === s && <span className="lp-swap mt-1.5 block pl-[18px] text-sm text-muted-foreground">{t(`landing.pool.strategies.${s}.desc`)}</span>}
                </button>
              ))}
            </div>
          </div>
          <div data-reveal style={lpDelay(100)}>
            <div className="rounded-2xl border bg-background p-6">
              <div className="flex items-center gap-2 text-xs">
                <span className="lp-mono rounded-full border px-2.5 py-1">/drive/photos/tide.jpg</span>
                <span className="text-muted-foreground">{t('landing.pool.incoming')}</span>
              </div>
              <div className="mt-10 grid grid-cols-3 gap-4">
                {buckets.map((b, i) => (
                  <div key={b.id} className="relative">
                    {target === i && <span key={`${strategy}-${tick}`} className="lp-drop absolute -top-8 left-1/2 size-4 rounded-sm bg-primary" />}
                    <div
                      key={`${strategy}-${tick}-${i}`}
                      className={cn('lp-bump flex h-40 flex-col justify-end overflow-hidden rounded-xl border bg-foreground/[0.04]', target === i && 'border-primary/60')}
                    >
                      <div className="lp-ease border-t border-primary/50 bg-primary/25" style={{ height: `${(b.base + (target === i ? 0.04 : 0)) * 100}%` }} />
                    </div>
                    <p className="lp-mono mt-2 text-center text-[11px]">{b.id}</p>
                    <p className="lp-num lp-mono text-center text-[10px] text-muted-foreground">{Math.round(b.base * 100)}%</p>
                  </div>
                ))}
              </div>
              <div className="lp-term mt-8 p-4 text-[12px] leading-relaxed">
                <p className="lp-mono font-medium text-[hsl(var(--lp-term-fg))]">{t('landing.pool.failoverTitle')}</p>
                <p className="lp-mono mt-2">
                  <span className="lp-dim">GET</span> /drive/photos/tide.jpg
                </p>
                <p className="lp-mono">
                  <span className="lp-bad">✕</span> r2-main <span className="lp-dim">— {t('landing.pool.trace.upstream')} · 8s</span>
                </p>
                <p className="lp-mono">
                  <span className="lp-ok">✓</span> s3-archive <span className="lp-dim">— {t('landing.pool.trace.served')}</span>
                </p>
                <p className="lp-mono lp-dim">↳ {t('landing.pool.trace.hint')}</p>
              </div>
              <p className="mt-4 text-sm text-muted-foreground">{t('landing.pool.failoverDesc')}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ============ 管理后台 ============
const CHAIN = ['admin', 'mount', 'root', 'key', 'rules', 'owner', 'bucket', 'mountMatrix', 'role', 'deny'] as const;

export function Admin(): JSX.Element {
  const { t } = useTranslation();
  const [ref, visible] = useVisible<HTMLDivElement>();
  const step = useCycle(CHAIN.length, 700, visible);
  const logs = [
    { action: 'login', path: '/', via: 'web', ip: '203.0.113.8' },
    { action: 'share', path: '/drive/photos', via: 'web', ip: '198.51.100.4' },
    { action: 'download', path: '/public/logo.svg', via: 's3', ip: '192.0.2.61' },
    { action: 'visibility_change', path: '/drive/poster.png', via: 'web', ip: '203.0.113.8' },
  ];
  return (
    <section id="admin" className="lp-section overflow-hidden">
      <div className="lp-container">
        <SectionHeading
          eyebrow={t('landing.admin.eyebrow')}
          title={<TwoTone a={t('landing.admin.titleA')} b={t('landing.admin.titleB')} />}
          lede={t('landing.admin.lede')}
        />
      </div>
      <div className="lp-stage lp-fade-b mt-12 h-[560px] max-md:h-auto max-md:[mask-image:none]" data-reveal="fade">
        <div className="lp-container flex justify-end">
          <div className="lp-tilt-alt origin-top-right">
            <DashboardMock />
          </div>
        </div>
      </div>
      <div ref={ref} className="lp-container">
        <div className="relative mt-6 grid border-l border-t md:grid-cols-2">
          <Corners />
          <div className="border-b border-r p-7" data-reveal>
            <h3 className="font-medium">{t('landing.admin.chain.title')}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{t('landing.admin.chain.desc')}</p>
            <ol className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              {CHAIN.map((s, i) => (
                <li key={s} className={cn('lp-ease flex items-center gap-2.5', i === step ? 'text-foreground' : i < step ? 'text-muted-foreground' : 'text-muted-foreground/50')}>
                  <span className={cn('lp-num lp-mono lp-ease flex size-5 items-center justify-center rounded text-[10px]', i === step ? 'bg-[hsl(var(--lp-ink))] text-[hsl(var(--lp-ink-fg))]' : 'bg-foreground/5')}>
                    {i + 1}
                  </span>
                  {t(`landing.admin.chain.steps.${s}`)}
                </li>
              ))}
            </ol>
            <p className="lp-mono mt-6 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span>
                /users/alice/a.jpg <span className="lp-ok">{t('landing.admin.chain.allow')}</span>
              </span>
              <span>
                /users/alice2/b.jpg <span className="lp-bad">{t('landing.admin.chain.deny')}</span>
              </span>
            </p>
          </div>
          <div className="border-b border-r p-7" data-reveal style={lpDelay(80)}>
            <h3 className="font-medium">{t('landing.admin.audit.title')}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{t('landing.admin.audit.desc')}</p>
            <div className="mt-6 divide-y rounded-lg border text-xs">
              <div className="grid grid-cols-[1.1fr_1.4fr_0.5fr] gap-3 px-3 py-2 text-muted-foreground max-sm:grid-cols-[1fr_1fr]">
                <span>{t('admin.logs.action')}</span>
                <span>{t('admin.logs.path')}</span>
                <span className="max-sm:hidden">via</span>
              </div>
              {logs.map((l) => (
                <div key={l.action + l.path} className="lp-mono grid grid-cols-[1.1fr_1.4fr_0.5fr] gap-3 px-3 py-2 max-sm:grid-cols-[1fr_1fr]">
                  <span className="truncate">{l.action}</span>
                  <span className="truncate text-muted-foreground">{l.path}</span>
                  <span className="text-muted-foreground max-sm:hidden">{l.via}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="border-b border-r p-7" data-reveal>
            <h3 className="font-medium">{t('landing.admin.review.title')}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{t('landing.admin.review.desc')}</p>
          </div>
          <div className="border-b border-r p-7" data-reveal style={lpDelay(80)}>
            <h3 className="font-medium">{t('landing.admin.matrix.title')}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{t('landing.admin.matrix.desc')}</p>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1.5 text-left font-normal" />
                    {(['read', 'write', 'delete', 'share'] as const).map((p) => (
                      <th key={p} className="px-2 py-1.5 font-normal">
                        {t(`perm.${p}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { role: 'admin', v: [1, 1, 1, 1] },
                    { role: 'user', v: [1, 1, 0, 1] },
                    { role: 'guest', v: [1, 0, 0, 0] },
                  ].map((r) => (
                    <tr key={r.role} className="border-t">
                      <td className="py-2">{t(`admin.${r.role}`)}</td>
                      {r.v.map((on, i) => (
                        <td key={i} className="px-2 py-2 text-center">
                          {on ? <span className="lp-ok">●</span> : <span className="text-muted-foreground/40">○</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ============ 细节：发丝网格 ============
export function Details(): JSX.Element {
  const { t } = useTranslation();
  const items = [
    {
      key: 'dedupe',
      icon: Fingerprint,
      art: (
        <div className="flex flex-wrap items-center gap-2">
          {['a.jpg', 'b.jpg', 'c.jpg'].map((n) => (
            <span key={n} className="lp-mono rounded border px-1.5 py-0.5 text-[10px]">
              {n}
            </span>
          ))}
          <ArrowRight className="size-3 text-muted-foreground" />
          <span className="lp-mono rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">sha256:9f3c…</span>
        </div>
      ),
      extra: t('landing.details.refs', { n: 3 }),
    },
    {
      key: 'preview',
      icon: ZoomIn,
      art: (
        <div className="flex items-center gap-2">
          <span className="h-10 w-14 overflow-hidden rounded">
            <Thumb tone="ocean" />
          </span>
          <ZoomIn className="size-3.5 text-muted-foreground" />
          <RotateCw className="size-3.5 text-muted-foreground" />
          <Code className="size-3.5 text-muted-foreground" />
        </div>
      ),
    },
    {
      key: 'links',
      icon: Link2,
      art: (
        <div className="flex flex-wrap gap-1.5">
          {[t('landing.details.links.direct'), 'HTML', 'Markdown', 'BBCode'].map((f) => (
            <span key={f} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]">
              <Copy className="size-2.5" /> {f}
            </span>
          ))}
        </div>
      ),
    },
    {
      key: 'appearance',
      icon: Palette,
      art: (
        <div className="flex gap-1.5">
          {ACCENT_PRESETS.slice(0, 5).map((c) => (
            <span key={c} className="size-5 rounded-full" style={{ backgroundColor: c }} />
          ))}
        </div>
      ),
    },
    {
      key: 'i18n',
      icon: Languages,
      art: (
        <div className="flex gap-1.5 text-[11px]">
          <span className="rounded-full border px-2 py-0.5">中文</span>
          <span className="rounded-full border px-2 py-0.5">English</span>
        </div>
      ),
    },
    {
      key: 'freeMode',
      icon: KeyRound,
      art: <span className="lp-mono text-[10px] text-muted-foreground">fm_token · AES-GCM · TTL</span>,
    },
  ];
  return (
    <section className="lp-section">
      <div className="lp-container">
        <SectionHeading eyebrow={t('landing.details.eyebrow')} title={t('landing.details.title')} />
        <div className="relative mt-16 grid border-l border-t sm:grid-cols-2 lg:grid-cols-3">
          <Corners />
          {items.map(({ key, icon: Icon, art, extra }, i) => (
            <div key={key} className="group border-b border-r p-7 transition-colors hover:bg-foreground/[0.02]" data-reveal style={lpDelay((i % 3) * 70)}>
              <Icon className="size-5 text-muted-foreground transition-colors group-hover:text-primary" />
              <div className="mt-6 flex h-10 items-center">{art}</div>
              <h3 className="mt-5 font-medium">{t(`landing.details.${key}.title`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t(`landing.details.${key}.desc`)}</p>
              {extra && <p className="lp-mono mt-3 text-[11px] text-muted-foreground">{extra}</p>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============ 集成：代码标签页 ============
const INTEGRATIONS = [
  {
    id: 'rest',
    icon: FileCode,
    code: `curl -X POST https://pic.example.com/api/upload \\
  -H "Authorization: Bearer pk_xxx.sk_yyy" \\
  -F "file=@photo.jpg" \\
  -F "path=/uploads/"`,
  },
  {
    id: 's3',
    icon: Boxes,
    code: `aws s3 cp photo.jpg s3://uploads/2026/photo.jpg \\
  --endpoint-url https://pic.example.com/s3
# AWS_ACCESS_KEY_ID=pk_xxx  AWS_SECRET_ACCESS_KEY=sk_yyy
# path-style addressing, region: auto`,
  },
  {
    id: 'webdav',
    icon: HardDrive,
    code: `curl -X PROPFIND https://pic.example.com/webdav/ \\
  -u "pk_xxx:sk_yyy" -H "Depth: 1"

curl -T photo.jpg -u "pk_xxx:sk_yyy" \\
  https://pic.example.com/webdav/uploads/photo.jpg`,
  },
  {
    id: 'lsky',
    icon: Layers,
    code: `# PicList → Lsky Pro
server:  https://pic.example.com
version: V2
token:   pk_xxx.sk_yyy
# POST /api/v1/upload`,
  },
  {
    id: 'alist',
    icon: Network,
    code: `# PicList → AList / OpenList
url:      https://pic.example.com/openlist
username: pk_xxx
password: sk_yyy
uploadPath: /uploads`,
  },
] as const;

export function Integrations(): JSX.Element {
  const { t } = useTranslation();
  const [active, setActive] = useState<(typeof INTEGRATIONS)[number]['id']>('rest');
  const current = INTEGRATIONS.find((i) => i.id === active)!;
  return (
    <section id="integrations" className="lp-section lp-bg-surface border-y">
      <div className="lp-container grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
        <div>
          <SectionHeading
            eyebrow={t('landing.integrations.eyebrow')}
            title={<TwoTone a={t('landing.integrations.titleA')} b={t('landing.integrations.titleB')} />}
            lede={t('landing.integrations.lede')}
          />
          <div className="mt-10 divide-y border-y" role="tablist" data-reveal>
            {INTEGRATIONS.map(({ id, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active === id}
                onClick={() => setActive(id)}
                className={cn('flex w-full items-center gap-3 py-3.5 text-left transition-colors', active === id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                <Icon className={cn('size-4 shrink-0', active === id && 'text-primary')} />
                <span className="text-sm font-medium">{t(`landing.integrations.${id}.name`)}</span>
                <span className="ml-auto truncate text-xs text-muted-foreground max-sm:hidden">{t(`landing.integrations.${id}.desc`)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="lp-term min-w-0 lg:sticky lg:top-24" data-reveal style={lpDelay(120)}>
          <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="lp-mono lp-dim ml-3 text-[11px]">{t(`landing.integrations.${active}.name`)}</span>
          </div>
          <pre key={active} className="lp-mono lp-swap whitespace-pre-wrap break-words p-5 text-[13px] leading-relaxed">
            <code>{current.code}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}

// ============ 安全 ============
const SECURITY = [
  { key: 'cookie', icon: Cookie },
  { key: 'csrf', icon: ShieldCheck },
  { key: 'rate', icon: Gauge },
  { key: 'path', icon: Route },
  { key: 'ssrf', icon: Network },
  { key: 'sql', icon: Database },
  { key: 'token', icon: Ticket },
  { key: 'keys', icon: KeyRound },
  { key: 'secrets', icon: LockKeyhole },
  { key: 'csp', icon: FileCode },
] as const;

export function Security(): JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="lp-section">
      <div className="lp-container">
        <SectionHeading
          eyebrow={t('landing.security.eyebrow')}
          title={<TwoTone a={t('landing.security.titleA')} b={t('landing.security.titleB')} />}
          lede={t('landing.security.lede')}
        />
        <div className="relative mt-16 grid border-l border-t sm:grid-cols-2 lg:grid-cols-5">
          <Corners />
          {SECURITY.map(({ key, icon: Icon }, i) => (
            <div key={key} className="border-b border-r p-6" data-reveal style={lpDelay((i % 5) * 50)}>
              <Icon className="size-4 text-primary" />
              <p className="mt-4 text-sm leading-relaxed">{t(`landing.security.items.${key}`)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============ 边缘网络 ============
export function Edge(): JSX.Element {
  const { t } = useTranslation();
  const dark = useIsDark();
  const stack = [
    { key: 'workers', name: 'Workers', icon: Zap },
    { key: 'd1', name: 'D1', icon: Database },
    { key: 'kv', name: 'KV', icon: Server },
    { key: 'r2', name: 'R2', icon: HardDrive },
  ];
  const stats = [
    { key: 'checks', value: <CountUp to={10} /> },
    { key: 'strategies', value: <CountUp to={5} /> },
    { key: 'protocols', value: <CountUp to={5} /> },
    { key: 'egress', value: <>$<CountUp to={0} /></> },
  ];
  return (
    <section className="lp-section lp-bg-surface overflow-hidden border-y">
      <div className="lp-container grid items-center gap-12 lg:grid-cols-2">
        <div>
          <SectionHeading
            eyebrow={t('landing.edge.eyebrow')}
            title={<TwoTone a={t('landing.edge.titleA')} b={t('landing.edge.titleB')} />}
            lede={t('landing.edge.lede')}
          />
          <div className="mt-10 divide-y border-y" data-reveal>
            {stack.map(({ key, name, icon: Icon }) => (
              <div key={key} className="flex items-center gap-4 py-3.5">
                <Icon className="size-4 shrink-0 text-primary" />
                <span className="w-20 shrink-0 text-sm font-medium">{name}</span>
                <span className="text-sm text-muted-foreground">{t(`landing.edge.stack.${key}`)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="lp-fade-radial mx-auto w-full max-w-[560px]" data-reveal="fade">
          <EdgeGlobe dark={dark} />
        </div>
      </div>
      <div className="lp-container mt-16">
        <div className="grid grid-cols-2 border-l border-t md:grid-cols-4">
          {stats.map((s) => (
            <div key={s.key} className="border-b border-r p-6" data-reveal>
              <p className="text-4xl font-semibold tracking-tight">{s.value}</p>
              <p className="mt-2 text-sm text-muted-foreground">{t(`landing.edge.stats.${s.key}`)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============ 部署 ============
const DEPLOY_STEPS = [
  {
    key: 'resources',
    lines: ['wrangler d1 create picumet-db', 'wrangler kv namespace create PICUMET_KV', 'wrangler r2 bucket create picumet-storage'],
  },
  {
    key: 'worker',
    lines: ['cd workers && bun install', 'bunx wrangler secret put JWT_SECRET', 'bunx wrangler d1 migrations apply picumet-db --remote', 'bun run deploy'],
  },
  {
    key: 'pages',
    lines: ['cd frontend && bun run build', 'bunx wrangler pages deploy dist --project-name=picumet'],
  },
] as const;

export function Deploy(): JSX.Element {
  const { t, i18n } = useTranslation();
  const zh = i18n.language?.startsWith('zh') ?? true;
  return (
    <section id="deploy" className="lp-section">
      <div className="lp-container">
        <SectionHeading
          eyebrow={t('landing.deploy.eyebrow')}
          title={t('landing.deploy.title')}
          lede={t('landing.deploy.lede')}
          aside={
            <a href={docsUrl(zh, 'deployment')} target="_blank" rel="noreferrer" className="lp-link">
              {t('landing.deploy.guide')} <ArrowUpRight className="size-4" />
            </a>
          }
        />
        <div className="mt-16 grid gap-6 lg:grid-cols-3">
          {DEPLOY_STEPS.map((s, i) => (
            <div key={s.key} className="min-w-0" data-reveal style={lpDelay(i * 90)}>
              <p className="lp-num lp-mono text-xs text-muted-foreground">0{i + 1}</p>
              <h3 className="mt-3 font-medium">{t(`landing.deploy.steps.${s.key}.title`)}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{t(`landing.deploy.steps.${s.key}.desc`)}</p>
              <div className="lp-term mt-5 min-w-0 p-4">
                {s.lines.map((l, j) => (
                  <p key={l} className="lp-mono lp-line whitespace-pre-wrap break-words text-[12px] leading-7" style={lpDelay(300 + i * 90 + j * 140)}>
                    <span className="lp-dim">$ </span>
                    {l}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============ FAQ ============
const FAQ = ['what', 'need', 'storage', 'picgo', 'failover', 'data'] as const;

export function Faq(): JSX.Element {
  const { t } = useTranslation();
  return (
    <section id="faq" className="lp-section lp-bg-surface border-y">
      <div className="lp-container grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:items-start">
        <SectionHeading eyebrow={t('landing.faq.eyebrow')} title={t('landing.faq.title')} />
        <div className="divide-y border-y" data-reveal>
          {FAQ.map((k) => (
            <details key={k} className="lp-faq group">
              <summary className="flex cursor-pointer items-center justify-between gap-6 py-5 text-left font-medium">
                {t(`landing.faq.items.${k}.q`)}
                <Plus className="lp-faq-icon size-4 shrink-0 text-muted-foreground" />
              </summary>
              <p className="pb-6 pr-10 text-sm leading-relaxed text-muted-foreground">{t(`landing.faq.items.${k}.a`)}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============ CTA ============
export function Cta({ loggedIn }: { loggedIn: boolean }): JSX.Element {
  const { t, i18n } = useTranslation();
  const zh = i18n.language?.startsWith('zh') ?? true;
  return (
    <section className="lp-section relative overflow-hidden">
      <div className="lp-dots pointer-events-none absolute inset-0" aria-hidden />
      <div className="lp-container relative text-center">
        <h2 className="lp-display mx-auto max-w-3xl text-[clamp(2.5rem,6vw,4.5rem)]" data-reveal>
          {t('landing.cta.titleA')}
          <br />
          <span className="text-muted-foreground">{t('landing.cta.titleB')}</span>
        </h2>
        <p className="lp-lede mx-auto mt-6" data-reveal style={lpDelay(80)}>
          {t('landing.cta.lede')}
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-x-6 gap-y-4" data-reveal style={lpDelay(160)}>
          <Link to={loggedIn ? '/files' : '/login'} className="lp-btn lp-btn-ink">
            {loggedIn ? t('landing.hero.openApp') : t('landing.hero.start')}
            <ArrowRight className="size-4" />
          </Link>
          <a href={docsUrl(zh)} target="_blank" rel="noreferrer" className="lp-link">
            <BookOpen className="size-4" />
            {t('landing.hero.docs')}
            <ArrowUpRight className="size-4" />
          </a>
        </div>
      </div>
    </section>
  );
}
