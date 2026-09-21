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
  const [focused, setFocused] = useState(0);
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
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
    const input = e.target.value.replace(/\D/g, '');
    if (input.length > 1) {
      // 粘贴/输入多位：整体填充
      const chars = input.split('').slice(0, length);
      onChange(chars.join(''));
      setFocused(Math.min(length - 1, chars.length));
      return;
    }
    if (input) {
      setVal(idx, input);
      if (idx < length - 1) setFocused(idx + 1);
    }
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
          onBlur={() => setFocused((f) => f)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={length}
          aria-label={t('common.otpDigit', { index: i + 1 })}
          className={cn(
            'relative flex h-9 w-9 items-center justify-center border-y border-r border-input text-sm shadow-sm transition-all outline-none',
            'first:rounded-l-md first:border-l last:rounded-r-md',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30',
            focused === i && 'z-10 border-ring ring-[3px] ring-ring/50'
          )}
        />
      ))}
    </div>
  );
}
