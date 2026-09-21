// InputOTP（shadcn input-otp 风格：分组输入、自动跳格、粘贴拆分）
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export function InputOTP({
  value,
  onChange,
  length = 6,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  className?: string;
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
    const raw = e.target.value.replace(/\D/g, '');
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
    // 已满：不再接受新输入（此前会把整体覆盖成最后两位，导致数字“轮转”到首格）
    if (value.length >= length) return;
    setVal(idx, typed);
    if (idx < length - 1) setFocused(idx + 1);
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {Array.from({ length }).map((_, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          value={value[i] ?? ''}
          onChange={(e) => handleInput(i, e)}
          onKeyDown={(e) => handleKey(i, e)}
          onFocus={() => setFocused(i)}
          onBlur={() => setFocused(-1)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={length}
          aria-label={t('common.otpDigit', { index: i + 1 })}
          className={cn(
            // 与表单内其它 Input 同一配方（bg-transparent / dark:bg-input/30）：
            // OTP 叠在玻璃卡片上，自带底色+backdrop 模糊只会与卡片叠加成实底白块
            // （用户原则：避免叠加导致模糊不明显），因此不自带玻璃，让卡片玻璃透出来
            'relative flex h-9 w-9 items-center justify-center border-y border-r border-input bg-transparent text-center text-sm shadow-sm transition-all outline-none dark:bg-input/30',
            'first:rounded-l-md first:border-l last:rounded-r-md',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            focused === i && 'z-10 border-ring ring-[3px] ring-ring/50'
          )}
        />
      ))}
    </div>
  );
}
