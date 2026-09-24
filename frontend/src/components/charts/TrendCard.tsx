// 管理员仪表板「趋势」面板：文件下载量 / 分享 / 登录 三条曲线。
// 图表用 EvilCharts（Recharts 引擎，registry 组件已 vendor 到 ./evilcharts/**），
// 系列色走 evilcharts 的 config → CSS 变量编译（亮/暗各一套，随主题切换无需 JS）；
// 数据源 GET /api/admin/dashboard/trends，粒度与区间都进 React Query 的 key。
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CalendarRange, Download, LogIn, RotateCcw, Share2, TrendingUp } from 'lucide-react';
import { Button, Card, CardContent, Dialog, EmptyState, Input, Label } from '@/components/ui/core';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { innerDelay } from '@/components/ui/reveal';
import { apiFetch } from '@/lib/api';
import { EvilAreaChart } from './evilcharts/charts/recharts-area-chart';
import type { ChartConfig } from './evilcharts/ui/recharts-chart';
import {
  customRangeFromInput,
  fitGranularity,
  formatBucketFullLabel,
  formatBucketLabel,
  parseDateEnd,
  parseDateStart,
  resolveRange,
  toDateInput,
  TREND_GRANULARITIES,
  TREND_METRICS,
  TREND_RANGES,
  validateCustomRange,
  type CustomRangeError,
  type CustomRangeInput,
  type TrendGranularity,
  type TrendMetric,
  type TrendRange,
  type TrendRangeKey,
  type TrendsResponse,
} from './trends';

/** 每张图的系列色：亮/暗成对交给 evilcharts 编译成 CSS 变量，禁止只给单主题色。
    下载量跟随主题强调色 --primary（用户换强调色时图表一起变），分享/登录用固定色相。 */
const METRIC_COLORS: Record<TrendMetric, { light: string[]; dark: string[] }> = {
  downloads: { light: ['hsl(var(--primary))'], dark: ['hsl(var(--primary))'] },
  shares: { light: ['hsl(174 78% 32%)'], dark: ['hsl(172 66% 60%)'] },
  logins: { light: ['hsl(263 70% 52%)'], dark: ['hsl(258 90% 74%)'] },
};

const METRIC_ICONS: Record<TrendMetric, typeof Download> = {
  downloads: Download,
  shares: Share2,
  logins: LogIn,
};

/** 粒度选项按「由细到粗」排（与 trends.ts 的可加粗顺序一致） */
const GRANULARITY_LABEL_KEY: Record<TrendGranularity, string> = {
  hour: 'hour',
  day: 'day',
  week: 'week',
  month: 'month',
};

const CHART_HEIGHT = 'h-[170px]';

export function TrendCard() {
  const { t } = useTranslation();
  const [granularity, setGranularity] = useState<TrendGranularity>('day');
  const [rangeKey, setRangeKey] = useState<TrendRangeKey>('last7d');
  const [customRange, setCustomRange] = useState<TrendRange | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [customInput, setCustomInput] = useState<CustomRangeInput>({ from: '', to: '' });

  // 区间只在 预设 / 自定义区间 变化时重算（时钟按分钟取整），避免每帧换 key 触发无限重取
  const range = useMemo(
    () => resolveRange(rangeKey, Math.floor(Date.now() / 60000) * 60000, customRange ?? undefined),
    [rangeKey, customRange]
  );
  // 用户选的粒度 × 当前区间可能超出后端 400 桶上限（如「小时 + 今年」）：
  // 这里自动加粗到能装下的最细粒度，并在界面提示，避免落到 400 错误态
  const { granularity: effectiveGranularity, coarsened } = fitGranularity(granularity, range.to - range.from);

  const openCustomDialog = () => {
    setCustomInput((prev) =>
      prev.from && prev.to
        ? prev
        : {
            from: toDateInput(customRange?.from ?? range.from),
            to: toDateInput(customRange?.to ?? range.to),
          }
    );
    setDialogOpen(true);
  };

  const handleRangeChange = (value: string) => {
    const key = value as TrendRangeKey;
    if (key === 'custom') {
      openCustomDialog();
      return;
    }
    setRangeKey(key);
  };

  const customFromMs = parseDateStart(customInput.from);
  const customToMs = parseDateEnd(customInput.to);
  const customError: CustomRangeError = validateCustomRange(customFromMs, customToMs);
  const customErrorMessage = customError ? t(`admin.dashboard.trends.custom.${customError}`) : null;

  const applyCustomRange = () => {
    const next = customRangeFromInput(customInput);
    if (!next) return;
    setCustomRange(next);
    setRangeKey('custom');
    setDialogOpen(false);
  };

  return (
    <Card className="py-3">
      <CardContent className="p-3">
        {/* 卡内逐行入场：本卡只服务于仪表盘（卡序 6，外层容器已带 revealDelay(6)），
            行延迟与 Dashboard 其它卡统一走 innerDelay 的「卡片 → 卡内行」两层节奏 */}
        <div className="reveal-row mb-3 flex flex-wrap items-center gap-x-2 gap-y-2" style={innerDelay(6, 0)}>
          <h3 className="flex items-center gap-2 font-medium">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            {t('admin.dashboard.trends.title')}
          </h3>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Select
              value={granularity}
              onValueChange={(v) => setGranularity(v as TrendGranularity)}
              options={TREND_GRANULARITIES.map((g) => ({
                value: g,
                label: `${t('admin.dashboard.trends.granularityLabel')}：${t(`admin.dashboard.trends.granularity.${GRANULARITY_LABEL_KEY[g]}`)}`,
              }))}
            />
            <Select
              value={rangeKey}
              onValueChange={handleRangeChange}
              options={TREND_RANGES.map((k) => ({ value: k, label: t(`admin.dashboard.trends.range.${k}`) }))}
            />
          </div>
        </div>

        {coarsened && (
          <p className="reveal-row mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground" style={innerDelay(6, 1)}>
            <CalendarRange className="h-3.5 w-3.5" />
            {t('admin.dashboard.trends.coarsened', {
              granularity: t(`admin.dashboard.trends.granularity.${GRANULARITY_LABEL_KEY[effectiveGranularity]}`),
            })}
          </p>
        )}

        {/* 三张图一行一个（各占一整行）：不做横向网格，无论面板多宽都竖排；
            卡内分区用分隔线（divide-y）而非再嵌边框盒 —— 卡中卡原则，见 docs/UI_CN.md */}
        <div className="divide-y">
          {TREND_METRICS.map((metric, i) => (
            <div key={metric} className="reveal-row pt-4 first:pt-0" style={innerDelay(6, i + 1)}>
              <MetricChart
                metric={metric}
                granularity={effectiveGranularity}
                from={range.from}
                to={range.to}
              />
            </div>
          ))}
        </div>
      </CardContent>

      {/* 自定义区间弹窗 Portal 到 body：外层玻璃卡的 backdrop-filter 会成为 fixed 后代的包含块，
          内联渲染时遮罩只盖住趋势卡（实测 458×797 而非整屏 1440×1000），Portal 后遮罩覆盖整个仪表盘 */}
      {createPortal(
        <Dialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          title={t('admin.dashboard.trends.custom.title')}
          description={t('admin.dashboard.trends.custom.description')}
          width="max-w-sm"
          footer={
            <>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button disabled={customError !== null} onClick={applyCustomRange}>
                {t('admin.dashboard.trends.custom.apply')}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="trends-custom-from">{t('admin.dashboard.trends.custom.from')}</Label>
              <Input
                id="trends-custom-from"
                type="date"
                value={customInput.from}
                max={customInput.to || undefined}
                onChange={(e) => setCustomInput((prev) => ({ ...prev, from: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="trends-custom-to">{t('admin.dashboard.trends.custom.to')}</Label>
              <Input
                id="trends-custom-to"
                type="date"
                value={customInput.to}
                min={customInput.from || undefined}
                onChange={(e) => setCustomInput((prev) => ({ ...prev, to: e.target.value }))}
              />
            </div>
            {customErrorMessage && <p className="text-xs text-destructive">{customErrorMessage}</p>}
          </div>
        </Dialog>,
        document.body
      )}
    </Card>
  );
}

/** 单指标曲线：加载骨架 / 空态 / 错误态 / 曲线四态互斥 */
function MetricChart({
  metric,
  granularity,
  from,
  to,
}: {
  metric: TrendMetric;
  granularity: TrendGranularity;
  from: number;
  to: number;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const Icon = METRIC_ICONS[metric];

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['admin-dashboard-trends', metric, granularity, from, to],
    queryFn: async () => {
      const q = new URLSearchParams({ metric, granularity, from: String(from), to: String(to) });
      return (await apiFetch<TrendsResponse>(`/api/admin/dashboard/trends?${q.toString()}`)).data;
    },
  });

  // 纵轴用短标签、tooltip 用完整标签（同一桶两个格式，短标签表按完整标签索引）
  const { rows, shortLabels, total } = useMemo(() => {
    const buckets = data?.buckets ?? [];
    const shortByFull = new Map<string, string>();
    const mapped = buckets.map((b) => {
      const full = formatBucketFullLabel(b.t, granularity, locale);
      shortByFull.set(full, formatBucketLabel(b.t, granularity, locale));
      return { label: full, count: b.count };
    });
    return {
      rows: mapped,
      shortLabels: shortByFull,
      total: mapped.reduce((sum, r) => sum + r.count, 0),
    };
  }, [data, granularity, locale]);

  const config = useMemo(
    () =>
      ({
        count: { label: t(`admin.dashboard.trends.metrics.${metric}`), colors: METRIC_COLORS[metric] },
      }) satisfies ChartConfig,
    [metric, t]
  );

  const body = (() => {
    if (isPending) {
      return (
        <div className={`${CHART_HEIGHT} space-y-2`}>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-[130px] w-full" />
        </div>
      );
    }
    if (isError) {
      return (
        <div className={`${CHART_HEIGHT} flex flex-col items-center justify-center gap-1 text-center`}>
          <p className="text-sm text-muted-foreground">{error instanceof Error ? error.message : t('admin.dashboard.trends.error')}</p>
          <p className="text-[11px] text-muted-foreground">{t('admin.dashboard.trends.errorHint')}</p>
          <Button variant="outline" size="sm" className="mt-1" onClick={() => void refetch()}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t('common.retry')}
          </Button>
        </div>
      );
    }
    if (rows.length === 0) {
      return (
        <div className={`${CHART_HEIGHT} flex items-center justify-center`}>
          <EmptyState
            compact
            icon={<Icon className="h-4 w-4" />}
            title={t('admin.dashboard.trends.empty')}
            description={t('admin.dashboard.trends.emptyDesc')}
          />
        </div>
      );
    }
    return (
      <EvilAreaChart data={rows} config={config} className={`${CHART_HEIGHT} w-full`}>
        <EvilAreaChart.Grid />
        <EvilAreaChart.XAxis dataKey="label" minTickGap={24} tickFormatter={(value: string) => shortLabels.get(value) ?? value} />
        <EvilAreaChart.YAxis width={38} allowDecimals={false} />
        <EvilAreaChart.Tooltip />
        <EvilAreaChart.Area dataKey="count" variant="gradient" strokeVariant="solid" curveType="monotone" />
      </EvilAreaChart>
    );
  })();

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-sm">
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {t(`admin.dashboard.trends.metrics.${metric}`)}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {isPending || isError ? '' : t('admin.dashboard.trends.totalCount', { count: total })}
        </span>
      </div>
      {body}
    </div>
  );
}
