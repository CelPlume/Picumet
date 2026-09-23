// 主题与外观（localStorage 持久化）
import { create } from 'zustand';

/** 模糊强度三档：off 全站实底；default 项目默认强度；frosted 文件卡片磨砂配方全局化 */
export type BlurLevel = 'off' | 'default' | 'frosted';

/**
 * 动画三档（与模糊三档并排的外观开关）：
 * - off：全部动画禁用（即时切换，适配低性能设备/动效敏感用户）
 * - default：仅保留功能性动画（图表绘制、tab/弹窗过渡、加载态等反馈）
 * - all：外加装饰性动画（页面分区入场 reveal、卡片浮层等）
 */
export type MotionLevel = 'off' | 'default' | 'all';

export interface AppearanceSettings {
  theme: 'light' | 'dark' | 'system';
  accentColor: string;
  fontColor?: string;
  blurLevel: BlurLevel;
  /** 动画三档（§33）：off 全关 / default 仅功能性动画 / all 加入场装饰动画 */
  motionLevel: MotionLevel;
  backgroundType: 'none' | 'image' | 'color';
  backgroundUrl?: string;
  backgroundColor?: string;
  fileIcons: 'iconify' | 'emoji';
  folderPreview: 'icon' | 'contents';
  /** 文件页卡片视图每行卡片数（桌面 4–8，默认 6） */
  filesPerRow: number;
  /** 文件页卡片视图每行卡片数（手机 2–5，默认 3）；与桌面值分开记忆 */
  filesPerRowMobile: number;
  rightClickAction: 'properties' | 'menu';
  rightClickMultiSelect: boolean;
}

const DEFAULT: AppearanceSettings = {
  theme: 'system',
  accentColor: '#3B82F6',
  blurLevel: 'default',
  motionLevel: 'all',
  backgroundType: 'none',
  fileIcons: 'iconify',
  folderPreview: 'icon',
  filesPerRow: 6,
  filesPerRowMobile: 3,
  rightClickAction: 'properties',
  rightClickMultiSelect: false,
};

function load(): AppearanceSettings {
  try {
    const raw = localStorage.getItem('picumet:appearance');
    if (!raw) return DEFAULT;
    // 旧版布尔模糊开关迁移为三档：false → off，true/unset → default
    const legacy = JSON.parse(raw) as Partial<AppearanceSettings> & { enableBlur?: boolean };
    const { enableBlur: _legacy, ...rest } = legacy;
    const blurLevel = rest.blurLevel ?? (_legacy === false ? 'off' : 'default');
    return { ...DEFAULT, ...rest, blurLevel };
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
    // 按原样输出强调色（不做亮度补偿）
    let l = hsl.l;
    let adj = hslToRgb(hsl.h, hsl.s, l);
    // 浅色模式：白色按钮文字在过亮强调色上不达标时逐步压暗强调色（AA 4.5:1，
    // 最低压到 35% 亮度；压暗后由下方 YIQ 自动决定是否仍用白字）
    if (!dark) {
      const lum = (c: { r: number; g: number; b: number }) => {
        const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      while (l > 35 && 1.05 / (lum(adj) + 0.05) < 4.5) {
        l -= 2;
        adj = hslToRgb(hsl.h, hsl.s, l);
      }
    }
    root.style.setProperty('--primary', `${hsl.h} ${hsl.s}% ${l}%`);
    root.style.setProperty('--ring', `${hsl.h} ${hsl.s}% ${l}%`);
    // 根据调整后强调色亮度（YIQ）动态计算前景色，保证按钮文字对比度
    const yiq = (adj.r * 299 + adj.g * 587 + adj.b * 114) / 1000;
    root.style.setProperty(
      '--primary-foreground',
      yiq >= 128 ? '222.2 47.4% 11.2%' : '210 40% 98%'
    );
  }

  // 背景（先于玻璃不透明度计算：alpha 依赖是否存在背景图）
  const customBg = localStorage.getItem('picumet:custom-background');
  let bgImage = '';
  if (s.backgroundType === 'image') {
    const src = s.backgroundUrl || customBg || '';
    if (src) bgImage = src;
  }
  if (bgImage) {
    root.classList.add('has-bg-image');
    body.style.backgroundImage = `url(${bgImage})`;
    body.style.backgroundSize = 'cover';
    body.style.backgroundPosition = 'center';
    body.style.backgroundAttachment = 'fixed';
    body.style.backgroundColor = '';
  } else {
    root.classList.remove('has-bg-image');
    body.style.backgroundImage = '';
    body.style.backgroundAttachment = '';
    body.style.backgroundColor =
      s.backgroundType === 'color' && s.backgroundColor ? s.backgroundColor : '';
  }

  // 模糊三档（全站统一玻璃表面：--glass-alpha 控制底色透明度，--glass-blur 控制 blur 半径）
  // off：全站实底无模糊（.no-blur 类使所有 backdrop-filter 失效，文件卡片也不再有磨砂底）
  // default：项目默认强度（blur 20px）；毛玻璃：文件卡片磨砂配方（blur 16px + alpha 0.6）全局化
  // 有背景图时提高 default 档不透明度：深色下背景混入会破坏文字对比度，保住 WCAG AA
  // 小型控件（Tabs 轨道/按钮/搜索框/复选框未选态/视图切换器/⋮ 触发钮）与大表面共用
  // --glass-alpha：与所在页面的卡片同色同透，杜绝控件发灰与卡片割裂
  const glass =
    s.blurLevel === 'off'
      ? { alpha: '1', blur: '0px' }
      : s.blurLevel === 'frosted' && bgImage
        ? { alpha: '0.6', blur: '16px' }
        : { alpha: bgImage ? (dark ? '0.92' : '0.82') : dark ? '0.8' : '0.72', blur: '20px' };
  root.classList.toggle('no-blur', s.blurLevel === 'off');
  root.style.setProperty('--glass-alpha', glass.alpha);
  root.style.setProperty('--glass-blur', glass.blur);

  // 动画三档（§33）：落在 <html data-motion> 上，CSS 侧按属性关停对应层级的动画
  // - off：全局动画/过渡禁用（唯一例外：reduced-motion 用户本来就被强制禁用）
  // - default：装饰性入场动画（.reveal 等）禁用；功能性动画（图表/tab/弹窗/加载）保留
  // - all：全开（默认）
  root.setAttribute('data-motion', s.motionLevel === 'all' ? 'all' : s.motionLevel);
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

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
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
