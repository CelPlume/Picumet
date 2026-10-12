import { Input } from '@/components/ui/core';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export type CapacityUnit = 'MiB' | 'GiB' | 'TiB';

export const CAPACITY_MULTIPLIERS: Record<CapacityUnit, number> = {
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

export const CAPACITY_UNIT_OPTIONS = [
  { value: 'MiB', label: 'MiB' },
  { value: 'GiB', label: 'GiB' },
  { value: 'TiB', label: 'TiB' },
];

/** 将字节数拆分为合理的初始数值和单位（1024 进制） */
export function bytesToValueAndUnit(bytes: number | null | undefined): { value: string; unit: CapacityUnit } {
  if (bytes == null || bytes === 0) return { value: '', unit: 'GiB' };
  const TiB = CAPACITY_MULTIPLIERS.TiB;
  const GiB = CAPACITY_MULTIPLIERS.GiB;
  const MiB = CAPACITY_MULTIPLIERS.MiB;

  if (bytes >= TiB && bytes % GiB === 0) {
    return { value: String(Math.round((bytes / TiB) * 100) / 100), unit: 'TiB' };
  }
  if (bytes >= GiB) {
    return { value: String(Math.round((bytes / GiB) * 100) / 100), unit: 'GiB' };
  }
  return { value: String(Math.round((bytes / MiB) * 100) / 100), unit: 'MiB' };
}

/** 将数值与单位转为字节数（1024 进制，四舍五入到整数字节） */
export function valueAndUnitToBytes(value: string, unit: CapacityUnit): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * CAPACITY_MULTIPLIERS[unit]);
}

interface CapacityInputProps {
  value: string;
  unit: CapacityUnit;
  onValueChange: (val: string) => void;
  onUnitChange: (unit: CapacityUnit) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function CapacityInput({
  value,
  unit,
  onValueChange,
  onUnitChange,
  placeholder,
  className,
  disabled,
}: CapacityInputProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Input
        type="number"
        step="any"
        min="0"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1 min-w-0"
      />
      <div className="w-24 shrink-0">
        <Select
          value={unit}
          onValueChange={(v) => onUnitChange(v as CapacityUnit)}
          options={CAPACITY_UNIT_OPTIONS}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
