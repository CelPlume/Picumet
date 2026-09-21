// InputOTP 回归：填满后再输入不得覆盖整体（曾经的 bug：末格再输入被当成粘贴，值变成最后两位 → 数字“轮转”到首格）
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, act } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { InputOTP } from './input-otp';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => `${k}${o?.index ?? ''}` }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

function Harness() {
  const [value, setValue] = useState('');
  return <InputOTP value={value} onChange={setValue} />;
}

function cells(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('input[autocomplete="one-time-code"]')) as HTMLInputElement[];
}

describe('InputOTP', () => {
  it('失焦后激活态清除：点击其他位置不再保留高亮', () => {
    render(<Harness />);
    const inputs = cells();
    const tokens = () => inputs[0].className.split(/\s+/);
    // React 的 onFocus/onBlur 委托在 focusin/focusout 上：fireEvent.focus 只派发 focus 事件不会触发，
    // 直接派发 focusin/focusout（act 保证状态同步落盘）
    act(() => {
      inputs[0].dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(tokens()).toContain('ring-[3px]');
    act(() => {
      inputs[0].dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(tokens()).not.toContain('ring-[3px]');
    expect(tokens()).not.toContain('border-ring');
  });
  it('逐格输入六位后，第七次输入不会覆盖已有值', () => {
    render(<Harness />);
    const inputs = cells();
    expect(inputs).toHaveLength(6);

    '123456'.split('').forEach((ch, i) => {
      fireEvent.change(inputs[i], { target: { value: ch } });
    });
    expect(cells().map((c) => c.value).join('')).toBe('123456');

    // 在最后一格继续输入（真实 DOM 会变成 prev+新字符）：既有实现会整体被覆盖成 "56"，现在是忽略
    fireEvent.change(cells()[5], { target: { value: cells()[5].value + '7' } });
    expect(cells().map((c) => c.value).join('')).toBe('123456');
  });

  it('单格替换与清空仍然可用', () => {
    render(<Harness />);
    const inputs = cells();
    fireEvent.change(inputs[0], { target: { value: '7' } });
    fireEvent.change(cells()[1], { target: { value: '8' } });
    expect(cells().map((c) => c.value).join('')).toBe('78');

    // 选中单元格内容后输入数字 = 替换该格
    fireEvent.change(cells()[0], { target: { value: '9' } });
    expect(cells()[0].value).toBe('9');

    // 清空该格：打包语义下其余数字左移（与逐格输入一致）
    fireEvent.change(cells()[0], { target: { value: '' } });
    expect(cells().map((c) => c.value).join('')).toBe('8');
  });

  it('粘贴六位码：从当前格开始铺开', () => {
    render(<Harness />);
    fireEvent.change(cells()[0], { target: { value: '123456' } });
    expect(cells().map((c) => c.value).join('')).toBe('123456');
    expect(screen.getAllByRole('textbox')).toHaveLength(6);
  });
});
