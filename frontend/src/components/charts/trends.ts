// 管理员仪表板「趋势」面板的区间 / 粒度计算（纯函数，全部按浏览器本地时区）。
//
// 后端契约 GET /api/admin/dashboard/trends?metric&granularity&from&to：
//   - from / to 为毫秒时间戳，语义 [from, to)；缺省 to = 当前时间、from = to − 30 天。
//   - 区间长度 > 2 年 → 400；桶数 > 400 → 400；from >= to → 400。
//   - 桶按 UTC 对齐（hour 整点 / day 0 点 / week 周一 0 点 / month 1 日 0 点）并零填充。

export type TrendMetric = 'downloads' | 'shares' | 'logins';
export type TrendGranularity = 'hour' | 'day' | 'week' | 'month';
export type TrendRangeKey =
  | 'today'
  | 'last24h'
  | 'thisWeek'
  | 'last7d'
  | 'thisMonth'
  | 'last30d'
  | 'last90d'
  | 'thisYear'
  | 'last6m'
  | 'last12m'
  | 'all'
  | 'custom';

export interface TrendBucket {
  t: number;
  count: number;
}

export interface TrendsResponse {
  metric: TrendMetric;
  granularity: TrendGranularity;
  buckets: TrendBucket[];
}

export interface TrendRange {
  from: number;
  to: number;
}

/** 自定义区间的 date 输入值（本地时区，YYYY-MM-DD） */
export interface CustomRangeInput {
  from: string;
  to: string;
}

export type CustomRangeError = 'missing' | 'order' | 'tooLong' | null;

export const TREND_METRICS: TrendMetric[] = ['downloads', 'shares', 'logins'];
/** 由细到粗：区间过长时按这个顺序自动加粗，保证桶数落在后端上限内 */
export const TREND_GRANULARITIES: TrendGranularity[] = ['hour', 'day', 'week', 'month'];
export const TREND_RANGES: TrendRangeKey[] = [
  'today',
  'last24h',
  'thisWeek',
  'last7d',
  'thisMonth',
  'last30d',
  'last90d',
  'thisYear',
  'last6m',
  'last12m',
  'all',
  'custom',
];

/** 后端桶数上限（超过即 400） */
export const MAX_BUCKETS = 400;
/** 后端区间上限「2 年」；用 730 天，落在任何一侧解释（730 天 / 日历 2 年）之内 */
export const MAX_SPAN_MS = 730 * 86400000;

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
/** 粗粒度按「平均桶长」估算桶数，只用于前端预判（真实分桶由后端负责） */
const APPROX_BUCKET_MS: Record<TrendGranularity, number> = {
  hour: HOUR_MS,
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};

/** 本地时区当天 00:00:00.000 */
function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** 本地时区当周周一 00:00:00.000（中文习惯周一为一周起点） */
function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const offset = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - offset);
  return x;
}

function startOfMonth(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}

function startOfYear(d: Date): Date {
  const x = startOfMonth(d);
  x.setMonth(0);
  return x;
}

function addMonths(d: Date, months: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + months);
  return x;
}

/**
 * 把预设区间解析成本地时区毫秒区间。
 * `now`/`custom` 由调用方传入（不在函数内读时钟，便于测试与 useMemo 稳定）。
 * `custom` 缺省或非法时回退到 `all`。
 */
export function resolveRange(key: TrendRangeKey, now: number, custom?: TrendRange): TrendRange {
  const d = new Date(now);
  switch (key) {
    case 'today':
      return { from: startOfDay(d).getTime(), to: now };
    case 'last24h':
      return { from: now - DAY_MS, to: now };
    case 'thisWeek':
      return { from: startOfWeek(d).getTime(), to: now };
    case 'last7d':
      return { from: now - 7 * DAY_MS, to: now };
    case 'thisMonth':
      return { from: startOfMonth(d).getTime(), to: now };
    case 'last30d':
      return { from: now - 30 * DAY_MS, to: now };
    case 'last90d':
      return { from: now - 90 * DAY_MS, to: now };
    case 'thisYear':
      return { from: startOfYear(d).getTime(), to: now };
    case 'last6m':
      return { from: addMonths(d, -6).getTime(), to: now };
    case 'last12m':
      return { from: addMonths(d, -12).getTime(), to: now };
    case 'custom':
      return custom ?? { from: now - MAX_SPAN_MS, to: now };
    case 'all':
    default:
      // 「所有时间段」= 后端允许的最宽区间（2 年）；更早的数据受契约限制取不到
      return { from: now - MAX_SPAN_MS, to: now };
  }
}

/** date 输入值 → 本地时区当天 00:00:00.000；非法返回 null */
export function parseDateStart(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** date 输入值 → 本地时区当天 23:59:59.999（作为闭区间右端）；非法返回 null */
export function parseDateEnd(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** 自定义区间校验：日期是否填满 + 起止顺序 + 是否超出后端 2 年上限 */
export function validateCustomRange(fromMs: number | null, toMs: number | null): CustomRangeError {
  if (fromMs === null || toMs === null) return 'missing';
  if (fromMs >= toMs) return 'order';
  if (toMs - fromMs > MAX_SPAN_MS) return 'tooLong';
  return null;
}

/** date 输入值 → 毫秒区间（起始日 00:00 → 结束日 23:59:59.999） */
export function customRangeFromInput(input: CustomRangeInput): TrendRange | null {
  const from = parseDateStart(input.from);
  const to = parseDateEnd(input.to);
  if (validateCustomRange(from, to) !== null) return null;
  return { from: from as number, to: to as number };
}

/** date 输入值 → `YYYY-MM-DD`（本地时区） */
export function toDateInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 预判粒度：从用户选的粒度起由细到粗找第一个桶数 ≤ 400 的粒度。
 * 返回 `coarsened` 让界面能提示「区间过长，已自动使用更粗的粒度」，避免直接撞后端 400。
 */
export function fitGranularity(
  requested: TrendGranularity,
  spanMs: number
): { granularity: TrendGranularity; coarsened: boolean } {
  const span = Math.max(0, spanMs);
  const start = TREND_GRANULARITIES.indexOf(requested);
  for (let i = Math.max(0, start); i < TREND_GRANULARITIES.length; i++) {
    const g = TREND_GRANULARITIES[i];
    if (Math.ceil(span / APPROX_BUCKET_MS[g]) <= MAX_BUCKETS) {
      return { granularity: g, coarsened: g !== requested };
    }
  }
  return { granularity: 'month', coarsened: requested !== 'month' };
}

/** 坐标轴刻度标签（本地时区；与后端 UTC 对齐的桶起点落在同一本地日历日内） */
export function formatBucketLabel(t: number, granularity: TrendGranularity, locale: string): string {
  const d = new Date(t);
  if (granularity === 'hour') {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  }
  if (granularity === 'month') {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric' }).format(d);
  }
  return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(d);
}

/** Tooltip 用完整标签：小时粒度带日期，其余粒度只到日 */
export function formatBucketFullLabel(t: number, granularity: TrendGranularity, locale: string): string {
  const d = new Date(t);
  const opts: Intl.DateTimeFormatOptions =
    granularity === 'hour'
      ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
      : granularity === 'month'
        ? { year: 'numeric', month: 'numeric' }
        : { year: 'numeric', month: 'numeric', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, opts).format(d);
}
