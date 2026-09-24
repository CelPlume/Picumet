// 站点公开设置（站点标题 / Logo / Favicon）——从 /api/public/settings 读取并应用到文档
import { create } from 'zustand';
import { apiFetch } from '@/lib/api';

export interface SiteSettings {
  siteTitle?: string;
  /** 左上角标题：undefined（后端未设置）= 跟随 siteTitle；'' = 只显示 Logo 不出文字 */
  siteHeaderTitle?: string;
  siteLogo?: string;
  siteFavicon?: string;
}

interface SiteState extends SiteSettings {
  loaded: boolean;
  load: () => Promise<void>;
}

function applySite(s: Partial<SiteSettings>) {
  if (s.siteTitle) document.title = s.siteTitle;
  if (s.siteFavicon) {
    let link = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = s.siteFavicon;
  }
}

export const useSite = create<SiteState>((set) => ({
  siteTitle: undefined,
  siteHeaderTitle: undefined,
  siteLogo: undefined,
  siteFavicon: undefined,
  loaded: false,
  load: async () => {
    try {
      const res = await apiFetch<SiteSettings>('/api/public/settings');
      const data = res.data;
      set({ ...data, loaded: true });
      applySite(data);
    } catch {
      set({ loaded: true });
    }
  },
}));

