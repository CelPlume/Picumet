import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { BlurSlider, FilesPerRowSlider, MotionSlider } from './slider';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function BlurHarness() {
  const [value, setValue] = useState<'off' | 'default' | 'frosted'>('default');
  return <BlurSlider value={value} onChange={setValue} />;
}

describe('slider', () => {
  it('renders a native range with accessible value text and only valid stop anchors', () => {
    const { container } = render(<BlurHarness />);
    const input = screen.getByRole('slider', { name: 'common.blurStrength' });
    expect(input).toHaveAttribute('aria-valuetext', 'common.blurDefault');
    expect(container.querySelectorAll('.pill-slider-tick')).toHaveLength(3);
    expect(container.querySelector('.pill-slider-track')).not.toHaveAttribute('data-pulling');
  });

  it('updates discrete values by the native range event and updates the description', () => {
    render(<BlurHarness />);
    const input = screen.getByRole('slider', { name: 'common.blurStrength' });
    fireEvent.change(input, { target: { value: '2' } });
    expect(input).toHaveValue('2');
    expect(input).toHaveAttribute('aria-valuetext', 'common.blurFrosted');
    expect(screen.getByText('common.blurDescFrosted')).toBeInTheDocument();
  });

  it('marks the track pressed only while the pointer is down', () => {
    const { container } = render(<MotionSlider value="default" onChange={vi.fn()} />);
    const input = screen.getByRole('slider', { name: 'common.motionLevel' });
    const track = container.querySelector('.pill-slider-track') as HTMLElement;
    fireEvent.pointerDown(input, { pointerId: 1 });
    expect(track).toHaveAttribute('data-pressed', 'true');
    fireEvent.pointerUp(input, { pointerId: 1 });
    expect(track).not.toHaveAttribute('data-pressed');
  });

  it('rounds and clamps the cards-per-row value', () => {
    const onChange = vi.fn();
    render(<FilesPerRowSlider value={99} min={4} max={8} label="cards" onChange={onChange} />);
    const input = screen.getByRole('slider', { name: 'settings.filesPerRow' });
    expect(input).toHaveValue('8');
    fireEvent.change(input, { target: { value: '6' } });
    expect(onChange).toHaveBeenCalledWith(6);
  });
});
