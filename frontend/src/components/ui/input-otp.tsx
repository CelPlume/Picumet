// InputOTP（shadcn input-otp 风格：分段输入、自动跳格、粘贴拆分）
// 动效：字符浮入、激活格光标闪烁、错误整行抖动；
// 功能性微反馈 → 默认/全部动画档可用，off 档由 index.css 全局关停。
// mode="alphanumeric" 供邀请码输入（[0-9A-Z]，自动转大写）。
// 分段格子用 flex-1 拉伸填满容器：OTP＋发送按钮行的总宽与上方文本框一致。
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export type OtpMode = 'numeric' | 'alphanumeric';

const ALLOW: Record<OtpMode, (c: string) => boolean> = {
  numeric: (c) => /^[0-9]$/.test(c),
  alphanumeric: (c) => /^[0-9A-Z]$/.test(c),
};

export function InputOTP({
  value,
  onChange,
  length = 6,
  mode = 'numeric',
  error,
  disabled,
  groupEvery,
  className,
  ariaLabelKey = 'common.otpDigit',
}: {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  mode?: OtpMode;
  /** 错误态：整行抖动一次 + 错误边框（表单校验失败时置 true，输入时清除） */
  error?: boolean;
  disabled?: boolean;
  /** 分组间隔：6 位默认 3-3 拆分（8 位传 4） */
  groupEvery?: number;
  className?: string;
  /** 单元格 aria-label 的 i18n key（默认 common.otpDigit；邀请码用 auth.inviteDigit） */
  ariaLabelKey?: string;
}) {
  const { t } = useTranslation();
  // -1 = 尚未聚焦任何格（空值时首格不再显示激活态）
  const [focused, setFocused] = useState(-1);
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (focused < 0) return;
    refs.current[focused]?.focus();
  }, [focused]);

  const setVal = (idx: number, char: string) => {
    const chars = (value + ' '.repeat(length)).split('').slice(0, length);
    chars[idx] = char;
    onChange(chars.join('').replace(/ /g, ''));
  };

  const handleKey = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (value[idx]) setVal(idx, '');
      else if (idx > 0) setFocused(idx - 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setFocused(Math.max(0, idx - 1));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setFocused(Math.min(length - 1, idx + 1));
    }
  };

  const handleInput = (idx: number, e: React.ChangeEvent<HTMLInputElement>) => {
    if (focused < 0) setFocused(idx);
    const allow = ALLOW[mode];
    // 过滤非法字符（邀请码自动大写），长度封顶
    const raw = e.target.value
      .split('')
      .map((c) => (mode === 'alphanumeric' ? c.toUpperCase() : c))
      .filter((c) => allow(c))
      .join('')
      .slice(0, length);
    const prev = value[idx] ?? '';
    // 已在末尾追加时只取新增部分（否则视为替换/粘贴）
    const typed = raw.length > prev.length && raw.startsWith(prev) ? raw.slice(prev.length) : raw;
    if (!typed) {
      setVal(idx, '');
      return;
    }
    // 一次输入多位（粘贴）：从当前格开始铺开
    if (typed.length > 1) {
      const merged = (value.slice(0, idx) + typed).slice(0, length);
      onChange(merged);
      setFocused(Math.min(length - 1, merged.length));
      return;
    }
    // 已满：忽略新输入（否则整串会被覆盖成最后两位，数字“轮转”到首格）
    if (value.length >= length) return;
    setVal(idx, typed);
    if (idx < length - 1) setFocused(idx + 1);
  };

  const groupAt = groupEvery ?? Math.ceil(length / 2);

  return (
    <div
      role="group"
      aria-label={mode === 'numeric' ? t('auth.emailCode') : t('auth.inviteCode')}
      className={cn(
        'otp-row flex w-full items-stretch gap-1.5',
        error && 'otp-row-error otp-error',
        className
      )}
    >
      {Array.from({ length }).map((_, i) => {
        const char = value[i] ?? '';
        const active = focused === i;
        const groupGap = groupAt > 0 && i > 0 && i % groupAt === 0;
        return (
          <div key={i} className={cn('relative min-w-0 flex-1', groupGap && 'ml-2')}>
            <input
              ref={(el) => { refs.current[i] = el; }}
              value={char}
              onChange={(e) => handleInput(i, e)}
              onKeyDown={(e) => handleKey(i, e)}
              onFocus={() => setFocused(i)}
              onBlur={() => setFocused(-1)}
              inputMode={mode === 'numeric' ? 'numeric' : 'text'}
              autoComplete="one-time-code"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={length}
              disabled={disabled}
              aria-label={t(ariaLabelKey, { index: i + 1 })}
              className={cn(
                // 与表单内其它 Input 同一配方（bg-transparent / dark:bg-input/30）：
                // OTP 叠在玻璃卡片上，自带底色+backdrop 模糊只会与卡片叠加成实底白块
                'otp-cell relative h-9 w-full rounded-md border border-input bg-transparent text-center text-sm text-transparent caret-transparent shadow-sm outline-none transition-[border-color,box-shadow,background-color] selection:bg-transparent dark:bg-input/30',
                'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                'disabled:cursor-not-allowed disabled:opacity-50',
                active && 'otp-cell-active z-10 border-ring ring-[3px] ring-ring/50',
                !active && char && !error && 'border-foreground/30'
              )}
            />
            {/* 字符浮入层：native 输入文本透明，字符由这里绘制（key=char 重挂载触发入场动画）；
                激活空格显示自定义闪烁光标（interior.dev 同款） */}
            <span aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
              {char && (
                <span
                  key={char}
                  className={cn(
                    'otp-char font-mono text-sm tabular-nums text-foreground',
                    error && 'text-destructive'
                  )}
                >
                  {char}
                </span>
              )}
              {active && !char && !disabled && (
                <span className="otp-caret block h-[18px] w-[1.5px] rounded-[1px] bg-foreground/70" />
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
