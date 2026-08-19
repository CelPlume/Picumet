// 颜色选择器（HeroUI 风格：色块预览 + 弹出色板 + HEX 输入）
import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from './core';

const DEFAULT_PRESETS = ['#3B82F6', '#8B5CF6', '#EC4899', '#EF4444', '#F59E0B', '#10B981', '#0EA5E9', '#64748B'];

const HEX_RE = /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/;

export function ColorPicker({
  value,
  onChange,
  presets = DEFAULT_PRESETS,
  className,
}: {
  value: string;
  onChange: (color: string) => void;
  presets?: string[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setText(value), [value]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const commit = (color: string) => {
    onChange(color);
    setText(color);
    setOpen(false);
  };

  return (
    <div ref={ref} className={cn('relative inline-block', className)}>
      {/* 触发器 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 items-center gap-2 rounded-md border px-2 transition-colors hover:bg-accent"
        aria-label="选择颜色"
      >
        <span
          className="h-5 w-5 rounded-full border border-border shadow-sm"
          style={{ background: value }}
        />
        <span className="font-mono text-xs text-muted-foreground">{value}</span>
      </button>

      {open && (
        <div className="animate-dropdown absolute z-50 mt-1 w-60 rounded-md border bg-card p-3 shadow-lg">
          {/* 预设色板 */}
          <div className="grid grid-cols-4 gap-2">
            {presets.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => commit(c)}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-md border border-border transition-transform hover:scale-105',
                  value.toLowerCase() === c.toLowerCase() && 'ring-2 ring-foreground/60 ring-offset-1'
                )}
                style={{ background: c }}
                aria-label={c}
              >
                {value.toLowerCase() === c.toLowerCase() && <Check className="h-4 w-4 text-white drop-shadow" />}
              </button>
            ))}
          </div>

          {/* HEX 输入 + 原生取色 */}
          <div className="mt-3 flex items-center gap-2">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => {
                if (HEX_RE.test(text.trim())) {
                  const t = text.trim();
                  onChange(t.length === 3 ? '#' + t.slice(1).split('').map((x) => x + x).join('') : t);
                } else {
                  setText(value);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && HEX_RE.test(text.trim())) commit(text.trim());
              }}
              placeholder="#3B82F6"
              className="h-8 font-mono text-xs"
            />
            <input
              type="color"
              value={value}
              onChange={(e) => { onChange(e.target.value); setText(e.target.value); }}
              className="h-8 w-9 cursor-pointer rounded border"
              aria-label="取色器"
            />
          </div>
        </div>
      )}
    </div>
  );
}
