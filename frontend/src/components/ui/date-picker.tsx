// 3D 滚轮日期时间选择器
// - 弹出式交互：点击触发框弹出 WheelPicker 浮层（类似下拉菜单），不使用浏览器原生 input
// - 触发框样式与创建分享链接中的其他文本框（Input）一致：
//   border border-input bg-transparent dark:bg-input/30 shadow-sm，
//   使弹窗的 .glass-dialog 多级模糊自然透出（再叠一层 glass-control 会造成模糊冲突与实底色块）
// - 首帧直出：所有 <li> 与 <ul> 的旋转角度、位置、颜色、字重、可见性在 JSX style 内联直算，
//   并在 useLayoutEffect 内同步刷入计算值，避免首帧数字空白
// - 单套字体体系：不用两套重叠的 <ul> 列表，所有项统一 text-base（16px）字号与基线，
//   中心项高亮强调色与 700 字重
// - 日期激活器无边框线：中心指示条为纯色软高亮衬底（bg-primary/15），不添加上下 border 线条
// - 浮层复用项目下拉菜单阴影与表面规范（DROPDOWN_MENU_CLASS，shadow-md），一体化单层玻璃窗体
// - 尺寸与排版：每列 flex-1 弹性撑满宽度，itemHeight=40px
// - 语言自适应顺序：中文 YYYY/MM/DD、英文 MM/DD/YYYY；时分秒固定置于日期右侧（带纵向分隔线）
// - 单时间放 1 个（DatePicker），起止时间段放 2 个（DateRangePicker，分别选起止）
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Calendar as CalendarIcon, Clock, Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/core';
import { cn } from '@/lib/utils';

export type WheelPickerOption = string | { label: string; value: string };

export interface WheelPickerProps {
  options: WheelPickerOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** 视窗内可见行数，奇数，默认 5 */
  visibleCount?: number;
  /** 每行高度（px），40px 保障大字呼吸感 */
  itemHeight?: number;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

const DEG = Math.PI / 180;
const DECELERATION = 0.00042;
const MAX_VELOCITY = 0.18;
const VELOCITY_WINDOW = 90;
const WHEEL_SENS = 0.012;
const WHEEL_SETTLE = 110;
const BACK = 1.35;

const easeOutCubic = (p: number) => 1 - (1 - p) ** 3;
const easeOutBack = (p: number) => 1 + (BACK + 1) * (p - 1) ** 3 + BACK * (p - 1) ** 2;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

function optionValue(option: WheelPickerOption): string {
  return typeof option === 'string' ? option : option.value;
}

function optionLabel(option: WheelPickerOption): string {
  return typeof option === 'string' ? option : option.label;
}

/** 单列 3D 滚轮 drum（单套字体体系，弹性列 flex-1 撑满容器，首帧内联直出） */
export function WheelPicker({
  options,
  value,
  defaultValue,
  onValueChange,
  visibleCount = 5,
  itemHeight = 40,
  disabled = false,
  className,
  'aria-label': ariaLabel,
}: WheelPickerProps) {
  const controlled = value !== undefined;
  const last = Math.max(0, options.length - 1);

  const indexOf = useCallback(
    (v: string | undefined) => {
      const i = options.findIndex((o) => optionValue(o) === v);
      return i < 0 ? 0 : i;
    },
    [options]
  );

  const [internal, setInternal] = useState(() => defaultValue ?? value ?? optionValue(options[0]));
  const currentValue = controlled ? value : internal;
  const [grabbing, setGrabbing] = useState(false);

  // 圆柱体几何
  const { itemAngle, radius, height, hideBeyond } = useMemo(() => {
    const rowsEachSide = Math.max(1, Math.floor(visibleCount / 2));
    const cutoff = rowsEachSide + 1;
    const angle = 90 / cutoff;
    const r = itemHeight / Math.tan(angle * DEG);
    return {
      itemAngle: angle,
      radius: r,
      hideBeyond: cutoff,
      height: Math.round(2 * r * Math.sin(rowsEachSide * angle * DEG) + itemHeight),
    };
  }, [visibleCount, itemHeight]);

  const container = useRef<HTMLDivElement>(null);
  const drumRef = useRef<HTMLUListElement>(null);
  const scroll = useRef(indexOf(currentValue));
  const raf = useRef(0);
  const emitted = useRef(currentValue);

  // 单套字体渲染：中心项赋予强调色与粗体，远离项半透明淡化；绝不在上层叠加第二个列表！
  const paint = useCallback(
    (s: number) => {
      const drum = drumRef.current;
      const deg = itemAngle * s;
      if (!drum) return;
      drum.style.transform = `translateZ(${-radius}px) rotateX(${deg}deg)`;
      for (const node of Array.from(drum.children)) {
        const li = node as HTMLLIElement;
        const i = Number(li.dataset.index);
        const dist = Math.abs(i - s);
        const isHidden = dist > hideBeyond;
        li.style.visibility = isHidden ? 'hidden' : 'visible';
        if (!isHidden) {
          const isActive = dist < 0.5;
          li.style.color = isActive ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground) / 0.7)';
          li.style.fontWeight = isActive ? '700' : '500';
          // 中间向两边透明度增大（中间为 100% 不透明，向上下两侧平滑增大透明度至完全透明）
          const alpha = Math.max(0, 1 - (dist / hideBeyond) ** 1.35);
          li.style.opacity = String(Math.round(alpha * 1000) / 1000);
        }
      }
    },
    [radius, itemAngle, hideBeyond]
  );

  // useLayoutEffect 在首帧绘制前同步刷入 paint，避免首帧数字因异步不呈现
  useLayoutEffect(() => {
    scroll.current = indexOf(currentValue);
    paint(scroll.current);
  }, [currentValue, indexOf, paint]);

  const emit = useCallback(
    (i: number) => {
      if (options.length === 0) return;
      const v = optionValue(options[clamp(i, 0, last)]);
      if (v === emitted.current) return;
      emitted.current = v;
      if (!controlled) setInternal(v);
      onValueChange?.(v);
    },
    [options, last, controlled, onValueChange]
  );

  const stop = useCallback(() => cancelAnimationFrame(raf.current), []);

  const glide = useCallback(
    (to: number, duration: number, ease: (p: number) => number = easeOutCubic) => {
      stop();
      const from = scroll.current;
      const dist = to - from;
      if (!dist || duration <= 0) {
        scroll.current = to;
        paint(to);
        emit(to);
        return;
      }
      const start = performance.now();
      const tick = (now: number) => {
        const p = (now - start) / duration;
        if (p >= 1) {
          scroll.current = to;
          paint(to);
          emit(to);
          return;
        }
        scroll.current = from + dist * ease(p);
        paint(scroll.current);
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    },
    [stop, paint, emit]
  );

  const fling = useCallback(
    (velocity: number) => {
      const from = scroll.current;
      if (from < 0 || from > last) {
        glide(clamp(Math.round(from), 0, last), 260);
        return;
      }
      const dir = Math.sign(velocity);
      const coast = ((velocity * velocity) / (2 * DECELERATION)) * dir;
      const to = clamp(Math.round(from + coast), 0, last);
      const duration = clamp(Math.sqrt(Math.abs(to - from)) * 300 + 240, 280, 1500);
      glide(to, duration, easeOutBack);
    },
    [glide, last]
  );

  const step = useCallback(
    (by: number) => glide(clamp(Math.round(scroll.current) + by, 0, last), 260, easeOutBack),
    [glide, last]
  );

  // 拖拽与指针捕获
  const drag = useRef<{ y: number; scroll: number; pts: [number, number][] } | null>(null);
  const dragFrame = useRef(0);
  const latestY = useRef(0);

  const beginDrag = useCallback(
    (y: number) => {
      stop();
      setGrabbing(true);
      drag.current = { y, scroll: scroll.current, pts: [[y, performance.now()]] };
    },
    [stop]
  );

  const moveDrag = useCallback(
    (y: number) => {
      const d = drag.current;
      if (!d) return;
      latestY.current = y;
      d.pts.push([y, performance.now()]);
      if (d.pts.length > 8) d.pts.shift();
      if (dragFrame.current) return;
      dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = 0;
        const dd = drag.current;
        if (!dd) return;
        let next = dd.scroll + (dd.y - latestY.current) / itemHeight;
        if (next < 0) next *= 0.3;
        else if (next > last) next = last + (next - last) * 0.3;
        scroll.current = next;
        paint(next);
        emit(Math.round(clamp(next, 0, last)));
      });
    },
    [itemHeight, last, paint, emit]
  );

  const endDrag = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    if (dragFrame.current) {
      cancelAnimationFrame(dragFrame.current);
      dragFrame.current = 0;
    }
    drag.current = null;
    setGrabbing(false);
    const pts = d.pts;
    let v = 0;
    if (pts.length > 1) {
      const latest = pts[pts.length - 1];
      let ref = pts[0];
      for (const p of pts) {
        if (latest[1] - p[1] <= VELOCITY_WINDOW) {
          ref = p;
          break;
        }
      }
      const dt = latest[1] - ref[1];
      if (dt > 0) {
        const raw = (ref[0] - latest[0]) / itemHeight / dt;
        v = clamp(raw, -MAX_VELOCITY, MAX_VELOCITY);
      }
    }
    fling(v);
  }, [itemHeight, fling]);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      beginDrag(e.clientY);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 忽略 */
      }
    },
    [disabled, beginDrag]
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      moveDrag(e.clientY);
    },
    [moveDrag]
  );

  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        /* 忽略 */
      }
      endDrag();
    },
    [endDrag]
  );

  const wheelSnap = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (disabled) return;
      e.preventDefault();
      stop();
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const next = clamp(scroll.current + px * WHEEL_SENS, 0, last);
      scroll.current = next;
      paint(next);
      emit(Math.round(next));
      clearTimeout(wheelSnap.current ?? undefined);
      wheelSnap.current = setTimeout(() => {
        glide(clamp(Math.round(scroll.current), 0, last), 240, easeOutBack);
      }, WHEEL_SETTLE);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [disabled, last, paint, emit, stop, glide]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const at = Math.round(scroll.current);
      const map: Record<string, number> = {
        ArrowUp: -1,
        ArrowDown: 1,
        Home: -at,
        End: last - at,
      };
      if (e.key in map) {
        e.preventDefault();
        step(map[e.key]);
      }
    },
    [disabled, last, step]
  );

  useEffect(() => {
    if (drag.current) return;
    const target = indexOf(currentValue);
    emitted.current = currentValue;
    if (Math.abs(Math.round(scroll.current) - target) < 0.001) {
      paint(scroll.current);
      return;
    }
    glide(target, 240);
  }, [currentValue, indexOf, paint, glide]);

  const initialScroll = indexOf(currentValue);

  return (
    <div
      ref={container}
      role="listbox"
      aria-label={ariaLabel}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        'relative select-none touch-none overflow-hidden outline-none w-full shrink-0',
        grabbing ? 'cursor-grabbing' : 'cursor-grab',
        disabled && 'pointer-events-none opacity-50',
        className
      )}
      style={{ height, perspective: 1000 }}
    >
      {/* 中心高亮带：纯色软高亮衬底，绝不加上下 border 线条（日期激活器上线不要添加线条） */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0.5 top-1/2 z-0 -translate-y-1/2 rounded-lg bg-primary/15"
        style={{ height: itemHeight }}
      />

      {/* 3D 滚轮列表：首帧内联 transform，绝不在首屏等待 JS 跑完才画出数字 */}
      <ul
        ref={drumRef}
        aria-hidden
        className="absolute inset-x-0 top-1/2 m-0 h-0 list-none p-0 [transform-style:preserve-3d]"
        style={{
          transform: `translateZ(${-radius}px) rotateX(${itemAngle * initialScroll}deg)`,
        }}
      >
        {options.map((option, i) => {
          const dist = Math.abs(i - initialScroll);
          const isHidden = dist > hideBeyond;
          const isActive = dist < 0.5;
          return (
            <li
              key={optionValue(option)}
              data-index={i}
              className="absolute inset-x-0 flex items-center justify-center text-base transition-colors"
              style={{
                top: -itemHeight / 2,
                height: itemHeight,
                transform: `rotateX(${-itemAngle * i}deg) translateZ(${radius}px)`,
                visibility: isHidden ? 'hidden' : 'visible',
                color: isActive ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground) / 0.7)',
                fontWeight: isActive ? 700 : 500,
                opacity: Math.max(0, 1 - (dist / hideBeyond) ** 1.35),
              }}
            >
              {optionLabel(option)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const pad2 = (n: number | string) => String(n).padStart(2, '0');

function daysInMonth(year: number, month1To12: number): number {
  return new Date(year, month1To12, 0).getDate();
}

const YEARS = Array.from({ length: 30 }, (_, i) => String(2020 + i));
const MONTHS = Array.from({ length: 12 }, (_, i) => pad2(i + 1));
const HOURS = Array.from({ length: 24 }, (_, i) => pad2(i));
const MINUTES = Array.from({ length: 60 }, (_, i) => pad2(i));
const SECONDS = Array.from({ length: 60 }, (_, i) => pad2(i));

/** 解析 ISO / 本地时间串（YYYY-MM-DD 或 YYYY-MM-DDTHH:mm / YYYY-MM-DDTHH:mm:ss） */
export function parseDateTimeString(val?: string) {
  const now = new Date();
  if (!val) {
    return {
      year: String(now.getFullYear()),
      month: pad2(now.getMonth() + 1),
      day: pad2(now.getDate()),
      hour: pad2(now.getHours()),
      minute: pad2(now.getMinutes()),
      second: pad2(now.getSeconds()),
    };
  }
  const [dPart, tPart] = val.split(/[T ]/);
  const [y, m, d] = (dPart || '').split('-').map(Number);
  const [hh, mm, ss] = (tPart || '').split(':').map(Number);
  return {
    year: String(y || now.getFullYear()),
    month: pad2(m || now.getMonth() + 1),
    day: pad2(d || now.getDate()),
    hour: pad2(Number.isFinite(hh) ? hh : now.getHours()),
    minute: pad2(Number.isFinite(mm) ? mm : now.getMinutes()),
    second: pad2(Number.isFinite(ss) ? ss : 0),
  };
}

/** 格式化日期时间用于输入框回显 */
export function formatDisplayDateTime(val: string | undefined, isEn: boolean, includeTime: boolean): string {
  if (!val) return '';
  const p = parseDateTimeString(val);
  const dateStr = isEn ? `${p.month}/${p.day}/${p.year}` : `${p.year}/${p.month}/${p.day}`;
  if (!includeTime) return dateStr;
  return `${dateStr} ${p.hour}:${p.minute}:${p.second}`;
}

export interface WheelPickerViewProps {
  value?: string;
  onChange?: (val: string) => void;
  includeTime?: boolean;
  disabled?: boolean;
  className?: string;
}

/** 3D 滚轮纯面板视图：与外层弹窗窗体一体化（内部不再额外嵌多余边框卡片盒）
 *  - 宽度必须撑满整个卡片（w-full + 每列 flex-1）
 *  - 日期顺序随语言（英文 MM/DD/YYYY，中文 YYYY/MM/DD），时分秒固定置于日期右侧 */
export function WheelPickerView({
  value,
  onChange,
  includeTime = true,
  disabled = false,
  className,
}: WheelPickerViewProps) {
  const { i18n, t } = useTranslation();
  const isEn = i18n.language?.startsWith('en');

  const parsed = useMemo(() => parseDateTimeString(value), [value]);
  const [year, setYear] = useState(parsed.year);
  const [month, setMonth] = useState(parsed.month);
  const [day, setDay] = useState(parsed.day);
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [second, setSecond] = useState(parsed.second);

  useEffect(() => {
    setYear(parsed.year);
    setMonth(parsed.month);
    setDay(parsed.day);
    setHour(parsed.hour);
    setMinute(parsed.minute);
    setSecond(parsed.second);
  }, [parsed]);

  const maxDay = daysInMonth(Number(year), Number(month));
  const days = useMemo(() => Array.from({ length: maxDay }, (_, i) => pad2(i + 1)), [maxDay]);

  useEffect(() => {
    if (Number(day) > maxDay) setDay(pad2(maxDay));
  }, [day, maxDay]);

  const emit = (y: string, m: string, d: string, hh: string, mm: string, ss: string) => {
    const safeDay = pad2(Math.min(Number(d), daysInMonth(Number(y), Number(m))));
    if (includeTime) {
      onChange?.(`${y}-${m}-${safeDay}T${hh}:${mm}:${ss}`);
    } else {
      onChange?.(`${y}-${m}-${safeDay}`);
    }
  };

  const handleYear = (v: string) => { setYear(v); emit(v, month, day, hour, minute, second); };
  const handleMonth = (v: string) => { setMonth(v); emit(year, v, day, hour, minute, second); };
  const handleDay = (v: string) => { setDay(v); emit(year, month, v, hour, minute, second); };
  const handleHour = (v: string) => { setHour(v); emit(year, month, day, v, minute, second); };
  const handleMinute = (v: string) => { setMinute(v); emit(year, month, day, hour, v, second); };
  const handleSecond = (v: string) => { setSecond(v); emit(year, month, day, hour, minute, v); };

  const yearPicker = (
    <div key="y" className="flex flex-1 min-w-0 flex-col items-center">
      <span className="mb-1 text-xs font-semibold text-muted-foreground">{t('common.year', '年')}</span>
      <WheelPicker
        options={YEARS}
        value={year}
        onValueChange={handleYear}
        disabled={disabled}
        className="w-full"
        aria-label="Year"
      />
    </div>
  );

  const monthPicker = (
    <div key="m" className="flex flex-1 min-w-0 flex-col items-center">
      <span className="mb-1 text-xs font-semibold text-muted-foreground">{t('common.month', '月')}</span>
      <WheelPicker
        options={MONTHS}
        value={month}
        onValueChange={handleMonth}
        disabled={disabled}
        className="w-full"
        aria-label="Month"
      />
    </div>
  );

  const dayPicker = (
    <div key="d" className="flex flex-1 min-w-0 flex-col items-center">
      <span className="mb-1 text-xs font-semibold text-muted-foreground">{t('common.day', '日')}</span>
      <WheelPicker
        options={days}
        value={day}
        onValueChange={handleDay}
        disabled={disabled}
        className="w-full"
        aria-label="Day"
      />
    </div>
  );

  // 语言自适应顺序：英文 MM/DD/YYYY，中文 YYYY/MM/DD
  const dateDrums = isEn
    ? [monthPicker, dayPicker, yearPicker]
    : [yearPicker, monthPicker, dayPicker];

  return (
    <div
      className={cn(
        // 与弹窗窗体一体化模糊，不再嵌套第二层玻璃边框盒子
        'flex w-full items-stretch gap-2 py-1',
        disabled && 'opacity-60 pointer-events-none',
        className
      )}
    >
      {/* 日期滚轮组（flex-1 弹性平分宽度） */}
      <div className="flex flex-1 min-w-0 items-center gap-1.5">{dateDrums}</div>

      {includeTime && (
        <>
          {/* 日期与时间的纵向视觉分隔线 */}
          <div className="mx-1 w-px bg-border/60 self-center h-28 shrink-0" aria-hidden />

          {/* 时分秒滚轮组（置于日期右侧，同样 flex-1 撑满） */}
          <div className="flex flex-1 min-w-0 items-center gap-1">
            <div className="flex flex-1 min-w-0 flex-col items-center">
              <span className="mb-1 text-xs font-semibold text-muted-foreground">{t('common.hour', '时')}</span>
              <WheelPicker
                options={HOURS}
                value={hour}
                onValueChange={handleHour}
                disabled={disabled}
                className="w-full"
                aria-label="Hour"
              />
            </div>
            <span className="text-sm font-bold text-muted-foreground mt-5 shrink-0">:</span>
            <div className="flex flex-1 min-w-0 flex-col items-center">
              <span className="mb-1 text-xs font-semibold text-muted-foreground">{t('common.minute', '分')}</span>
              <WheelPicker
                options={MINUTES}
                value={minute}
                onValueChange={handleMinute}
                disabled={disabled}
                className="w-full"
                aria-label="Minute"
              />
            </div>
            <span className="text-sm font-bold text-muted-foreground mt-5 shrink-0">:</span>
            <div className="flex flex-1 min-w-0 flex-col items-center">
              <span className="mb-1 text-xs font-semibold text-muted-foreground">{t('common.second', '秒')}</span>
              <WheelPicker
                options={SECONDS}
                value={second}
                onValueChange={handleSecond}
                disabled={disabled}
                className="w-full"
                aria-label="Second"
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export interface DatePickerProps {
  /** 格式支持 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm / YYYY-MM-DDTHH:mm:ss */
  value?: string;
  onChange?: (val: string) => void;
  /** 是否包含时分秒（默认 true） */
  includeTime?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

/** 弹出式日期时间选择器（点击触发框弹出 WheelPicker 浮层，类似下拉菜单）
 *  - 触发框样式与创建分享链接中的其他文本框（Input）一致：
 *    border border-input bg-transparent dark:bg-input/30 shadow-sm，
 *    使弹窗的 .glass-dialog 多级模糊自然透出（再挂一层 glass-control 会造成模糊冲突）
 *  - 浮层复用项目下拉菜单阴影与表面规范（DROPDOWN_MENU_CLASS，shadow-md）
 *  - 选择器与弹窗窗体一体化模糊，不嵌套双重盒子 */
export function DatePicker({
  value,
  onChange,
  includeTime = true,
  disabled = false,
  placeholder,
  className,
}: DatePickerProps) {
  const { i18n, t } = useTranslation();
  const isEn = i18n.language?.startsWith('en');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width?: number } | null>(null);

  const displayText = useMemo(
    () => formatDisplayDateTime(value, !!isEn, includeTime),
    [value, isEn, includeTime]
  );

  // 打开时计算绝对位置（Portal 到 body，边缘碰撞翻转）
  useLayoutEffect(() => {
    if (!open) return;
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const popWidth = Math.max(includeTime ? 440 : 300, Math.min(r.width, 540));
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.left;
    if (left + popWidth > vw - 12) left = Math.max(12, vw - popWidth - 12);
    let top = r.bottom + 6;
    if (top + 280 > vh - 12 && r.top - 280 > 12) {
      top = r.top - 280 - 6;
    }
    setPos({ left, top, width: popWidth });
  }, [open, includeTime]);

  // 点击外部 / Escape 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const defaultPlaceholder = includeTime
    ? isEn
      ? 'MM/DD/YYYY HH:mm:ss'
      : 'YYYY/MM/DD HH:mm:ss'
    : isEn
      ? 'MM/DD/YYYY'
      : 'YYYY/MM/DD';

  return (
    <div className={cn('relative w-full', className)}>
      {/* 触发输入框：与创建分享链接中的其他文本框（Input）同款样式，
          bg-transparent dark:bg-input/30 使弹窗背景的多级模糊自然透出 */}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-full min-w-0 items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-[color,box-shadow] outline-none dark:bg-input/30',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          'disabled:cursor-not-allowed disabled:opacity-50',
          open && 'border-ring ring-[3px] ring-ring/50'
        )}
      >
        <span className="flex items-center gap-2 truncate">
          {includeTime ? (
            <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <CalendarIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className={cn('font-mono', !displayText && 'text-muted-foreground')}>
            {displayText || placeholder || defaultPlaceholder}
          </span>
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>

      {/* 弹出式 WheelPicker 浮层：复用 DROPDOWN_MENU_CLASS 规范（shadow-md，一体化单层玻璃窗体） */}
      {open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            className="animate-dropdown glass-surface-popover glass-blur fixed z-[120] rounded-xl border border-border/60 p-3 shadow-md text-popover-foreground"
            style={{ left: pos.left, top: pos.top, width: pos.width }}
          >
            <WheelPickerView
              value={value}
              onChange={onChange}
              includeTime={includeTime}
              disabled={disabled}
              className="w-full"
            />
            {/* 底部确认栏 */}
            <div className="mt-2.5 flex items-center justify-between border-t border-border/40 pt-2 text-xs">
              <span className="font-mono text-muted-foreground">
                {displayText || defaultPlaceholder}
              </span>
              <Button size="sm" onClick={() => setOpen(false)}>
                <Check className="h-3.5 w-3.5" /> {t('common.confirm', '确定')}
              </Button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

export interface DateRangePickerProps {
  from?: string;
  to?: string;
  onChange?: (range: { from: string; to: string }) => void;
  fromLabel?: string;
  toLabel?: string;
  includeTime?: boolean;
  disabled?: boolean;
  className?: string;
}

/** 起止时间段选择组件（放 2 个 DatePicker 分别选起止）
 *  - 弹出式交互：点击各自的输入框弹出对应时间的 WheelPicker 浮层
 *  - 起止并列两栏，各占一半宽度（grid grid-cols-1 sm:grid-cols-2） */
export function DateRangePicker({
  from = '',
  to = '',
  onChange,
  fromLabel,
  toLabel,
  includeTime = false,
  disabled = false,
  className,
}: DateRangePickerProps) {
  const { t } = useTranslation();
  const startLabel = fromLabel || t('common.fromTime', '起始');
  const endLabel = toLabel || t('common.toTime', '截至');

  return (
    <div className={cn('grid w-full grid-cols-1 gap-3 sm:grid-cols-2', className)}>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{startLabel}</span>
        <DatePicker
          value={from}
          onChange={(v) => onChange?.({ from: v, to })}
          includeTime={includeTime}
          disabled={disabled}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{endLabel}</span>
        <DatePicker
          value={to}
          onChange={(v) => onChange?.({ from, to: v })}
          includeTime={includeTime}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

// 兼容别名
export const DateTimePicker = DatePicker;
export type DateTimePickerProps = DatePickerProps;
export const DateTimeRangePicker = DateRangePicker;
export type DateTimeRangePickerProps = DateRangePickerProps;
