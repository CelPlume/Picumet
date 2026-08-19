// 主题与外观（localStorage 持久化）
import { create } from 'zustand';

export interface AppearanceSettings {
  theme: 'light' | 'dark' | 'system';
  accentColor: string;
  fontColor?: string;
  enableBlur: boolean;
  backgroundType: 'none' | 'image' | 'color';
  backgroundUrl?: string;
  backgroundColor?: string;
  fileIcons: 'iconify' | 'emoji';
  folderPreview: 'icon' | 'contents';
}

const DEFAULT: AppearanceSettings = {
  theme: 'system',
  accentColor: '#3B82F6',
  enableBlur: true,
  backgroundType: 'none',
  fileIcons: 'iconify',
  folderPreview: 'icon',
};

function load(): AppearanceSettings {
  try {
    const raw = localStorage.getItem('picumet:appearance');
    return raw ? { ...DEFAULT, ...JSON.parse(raw) } : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

interface ThemeState extends AppearanceSettings {
  set: (patch: Partial<AppearanceSettings>) => void;
}

function applyTheme(s: AppearanceSettings) {
  const root = document.documentElement;
  const body = document.body;
  const dark =
    s.theme === 'dark' ||
    (s.theme === 'system' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.classList.toggle('dark', dark);

  // 强调色（--primary/--ring 需为 HSL 三元组，tailwind 以 hsl(var(--primary)) 消费）
  if (s.accentColor) {
    const { r, g, b } = hexToRgb(s.accentColor);
    const hsl = rgbToHsl(r, g, b);
    root.style.setProperty('--primary', `${hsl.h} ${hsl.s}% ${hsl.l}%`);
    root.style.setProperty('--ring', `${hsl.h} ${hsl.s}% ${hsl.l}%`);
    // 根据强调色亮度（YIQ）动态计算前景色，避免浅色强调色在浅色主题下文字/图标变白
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    root.style.setProperty(
      '--primary-foreground',
      yiq >= 128 ? '222.2 47.4% 11.2%' : '210 40% 98%'
    );
  }

  // 模糊
  root.style.setProperty('--enable-blur', s.enableBlur ? '1' : '0');

  // 背景
  const customBg = localStorage.getItem('picumet:custom-background');
  let bgImage = '';
  if (s.backgroundType === 'image') {
    const src = s.backgroundUrl || customBg || '';
    if (src) bgImage = src;
  }
  if (bgImage) {
    body.style.backgroundImage = `url(${bgImage})`;
    body.style.backgroundSize = 'cover';
    body.style.backgroundPosition = 'center';
    body.style.backgroundAttachment = 'fixed';
    body.style.backgroundColor = '';
  } else {
    body.style.backgroundImage = '';
    body.style.backgroundAttachment = '';
    body.style.backgroundColor =
      s.backgroundType === 'color' && s.backgroundColor ? s.backgroundColor : '';
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

const initial = load();
applyTheme(initial);

export const useTheme = create<ThemeState>((set, get) => ({
  ...initial,
  set: (patch) => {
    const next = { ...get(), ...patch };
    localStorage.setItem('picumet:appearance', JSON.stringify(next));
    applyTheme(next);
    set(next);
  },
}));

// 跟随系统主题变化
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const s = useTheme.getState();
    if (s.theme === 'system') applyTheme(s);
  });
}

export { applyTheme };
