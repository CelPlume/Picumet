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
}

const DEFAULT: AppearanceSettings = {
  theme: 'system',
  accentColor: '#3B82F6',
  enableBlur: true,
  backgroundType: 'none',
  fileIcons: 'iconify',
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
    (s.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.classList.toggle('dark', dark);

  // 强调色
  if (s.accentColor) {
    const { r, g, b } = hexToRgb(s.accentColor);
    root.style.setProperty('--primary', `${r} ${g} ${b}`);
    root.style.setProperty('--ring', `${r} ${g} ${b}`);
  }

  // 模糊
  root.style.setProperty('--enable-blur', s.enableBlur ? '1' : '0');

  // 背景
  let bg = '';
  let bgImage = '';
  if (s.backgroundType === 'color' && s.backgroundColor) bg = s.backgroundColor;
  // 自定义背景图片（LocalStorage 优先）
  const customBg = localStorage.getItem('picumet:custom-background');
  if (s.backgroundType === 'image') {
    const src = s.backgroundUrl || customBg || '';
    if (src) bgImage = src;
  }
  if (bgImage) {
    body.style.backgroundImage = `url(${bgImage})`;
    body.style.backgroundSize = 'cover';
    body.style.backgroundPosition = 'center';
    body.style.backgroundAttachment = 'fixed';
  } else {
    body.style.backgroundImage = '';
    body.style.backgroundAttachment = '';
  }
  root.style.setProperty('--app-bg', bg);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
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
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const s = useTheme.getState();
    if (s.theme === 'system') applyTheme(s);
  });
}

export { applyTheme };
