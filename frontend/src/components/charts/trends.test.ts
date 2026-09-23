// 趋势面板区间 / 粒度计算的行为回归：本地时区取整、后端上限预判、自定义区间校验
import { describe, expect, it } from 'vitest';
import {
  customRangeFromInput,
  fitGranularity,
  MAX_BUCKETS,
  MAX_SPAN_MS,
  parseDateEnd,
  parseDateStart,
  resolveRange,
  toDateInput,
  validateCustomRange,
} from './trends';

// 2026-09-22（周二）15:30 本地时间
const NOW = new Date(2026, 8, 22, 15, 30, 0, 0).getTime();

describe('resolveRange', () => {
  it('今天从本地 00:00 起，到当前时刻止', () => {
    const { from, to } = resolveRange('today', NOW);
    expect(to).toBe(NOW);
    expect(new Date(from).getHours()).toBe(0);
    expect(new Date(from).getDate()).toBe(22);
  });

  it('本周从周一 00:00 起（周日归上一周）', () => {
    const monday = resolveRange('thisWeek', NOW).from;
    expect(new Date(monday).getDay()).toBe(1);
    expect(new Date(monday).getDate()).toBe(21);
    // 周日（9/27）仍应落在 9/21 那一周
    const sunday = resolveRange('thisWeek', new Date(2026, 8, 27, 10, 0, 0, 0).getTime()).from;
    expect(new Date(sunday).getDate()).toBe(21);
  });

  it('本月 / 今年取本地自然月年起点', () => {
    expect(new Date(resolveRange('thisMonth', NOW).from).getDate()).toBe(1);
    const yearStart = new Date(resolveRange('thisYear', NOW).from);
    expect([yearStart.getMonth(), yearStart.getDate(), yearStart.getHours()]).toEqual([0, 1, 0]);
  });

  it('最近 N 天按滚动窗口计算，最近 6/12 个月按日历月回退', () => {
    expect(resolveRange('last7d', NOW).from).toBe(NOW - 7 * 86400000);
    expect(new Date(resolveRange('last6m', NOW).from).getMonth()).toBe(2); // 2026-03
    expect(new Date(resolveRange('last12m', NOW).from).getFullYear()).toBe(2025);
  });

  it('所有时间段取后端允许的最宽区间（不超过 2 年上限）', () => {
    const { from, to } = resolveRange('all', NOW);
    expect(to - from).toBe(MAX_SPAN_MS);
    expect(to - from).toBeLessThanOrEqual(2 * 366 * 86400000);
  });

  it('自定义缺省时回退到最宽区间', () => {
    expect(resolveRange('custom', NOW)).toEqual({ from: NOW - MAX_SPAN_MS, to: NOW });
    expect(resolveRange('custom', NOW, { from: 1, to: 2 })).toEqual({ from: 1, to: 2 });
  });
});

describe('fitGranularity', () => {
  const days = (n: number) => n * 86400000;

  it('桶数在上限内时保持用户选择的粒度', () => {
    expect(fitGranularity('day', days(7))).toEqual({ granularity: 'day', coarsened: false });
    expect(fitGranularity('hour', days(16))).toEqual({ granularity: 'hour', coarsened: false });
  });

  it('桶数超上限时自动加粗到能装下的最细粒度并标记 coarsened', () => {
    // 31 天的小时桶 744 个 > 400 → 天（31 个）
    expect(fitGranularity('hour', days(31))).toEqual({ granularity: 'day', coarsened: true });
    // 2 年的天桶 730 个 > 400 → 周
    expect(fitGranularity('day', MAX_SPAN_MS)).toEqual({ granularity: 'week', coarsened: true });
  });

  it('任何粒度下加粗结果都不超桶数上限（除月粒度本身的区间上限外）', () => {
    for (const requested of ['hour', 'day', 'week', 'month'] as const) {
      const { granularity } = fitGranularity(requested, MAX_SPAN_MS);
      const span = MAX_SPAN_MS;
      const approx = { hour: 3600000, day: 86400000, week: 7 * 86400000, month: 30 * 86400000 }[granularity];
      expect(Math.ceil(span / approx)).toBeLessThanOrEqual(MAX_BUCKETS);
    }
  });
});

describe('customRangeFromInput', () => {
  it('起止日期按本地时区取 00:00 与当日 23:59:59.999', () => {
    const range = customRangeFromInput({ from: '2026-09-01', to: '2026-09-22' });
    expect(range).toEqual({ from: parseDateStart('2026-09-01'), to: parseDateEnd('2026-09-22') });
    expect(new Date(range!.to).getDate()).toBe(22);
    expect(new Date(range!.to).getHours()).toBe(23);
  });

  it('起止倒置 / 缺日期 / 超过 2 年一律拒绝', () => {
    expect(validateCustomRange(parseDateStart('2026-09-22'), parseDateEnd('2026-09-01'))).toBe('order');
    // 同一天可选：结束日取当日 23:59:59.999，仍严格大于起始日 00:00
    expect(validateCustomRange(parseDateStart('2026-09-22'), parseDateEnd('2026-09-22'))).toBeNull();
    expect(validateCustomRange(null, parseDateEnd('2026-09-22'))).toBe('missing');
    expect(validateCustomRange(parseDateStart('2024-01-01'), parseDateEnd('2026-09-22'))).toBe('tooLong');
    expect(customRangeFromInput({ from: '2026-09-22', to: '2026-09-01' })).toBeNull();
    expect(customRangeFromInput({ from: '', to: '2026-09-01' })).toBeNull();
  });

  it('2 年整的区间仍被接受（上限是闭区间）', () => {
    const from = parseDateStart('2024-09-23');
    const to = parseDateEnd('2026-09-22');
    expect(validateCustomRange(from, to)).toBeNull();
  });
});

describe('toDateInput', () => {
  it('输出本地日期串，与 parseDateStart 互逆', () => {
    expect(toDateInput(NOW)).toBe('2026-09-22');
    expect(parseDateStart(toDateInput(NOW))).toBe(new Date(2026, 8, 22, 0, 0, 0, 0).getTime());
  });
});
