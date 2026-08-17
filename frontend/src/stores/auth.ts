// 认证状态管理（Zustand）
import { create } from 'zustand';
import type { User, Quota } from '@shared/types';
import { apiFetch } from '@/lib/api';

interface AuthState {
  user: User | null;
  quota: Quota | null;
  loading: boolean;
  freeMode: boolean;
  freeModeExpiresAt?: number;
  fetchMe: () => Promise<void>;
  setAuth: (user: User, quota: Quota) => void;
  setFreeMode: (v: boolean, expiresAt?: number) => void;
  logout: () => Promise<void>;
  clear: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  quota: null,
  loading: true,
  freeMode: false,
  fetchMe: async () => {
    try {
      const res = await apiFetch<{ user: User; quota: Quota }>('/api/auth/me');
      set({ user: res.data.user, quota: res.data.quota, loading: false });
    } catch {
      set({ user: null, quota: null, loading: false });
    }
  },
  setAuth: (user, quota) => set({ user, quota, loading: false }),
  setFreeMode: (v, expiresAt) => set({ freeMode: v, freeModeExpiresAt: expiresAt }),
  logout: async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    set({ user: null, quota: null, freeMode: false });
    window.location.href = '/login';
  },
  clear: () => set({ user: null, quota: null, freeMode: false }),
}));
