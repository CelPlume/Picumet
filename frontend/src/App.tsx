// 路由与页面组织
import { Routes, Route, Navigate, Outlet, useLocation, Link } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FullPageSpinner } from '@/components/ui/core';
import { Toaster } from '@/components/ui/toast';
import { useAuth } from '@/stores/auth';
import { apiFetch } from '@/lib/api';
import Landing from '@/pages/Landing';
import Login from '@/pages/Login';
import FreeMode from '@/pages/FreeMode';
import Files from '@/pages/Files';
import MyShares from '@/pages/MyShares';
import SharePage from '@/pages/SharePage';
import SettingsLayout from '@/pages/settings/SettingsLayout';
import ProfilePage from '@/pages/settings/Profile';
import SecurityPage from '@/pages/settings/Security';
import ApiKeysPage from '@/pages/settings/ApiKeys';
import AppearancePage from '@/pages/settings/Appearance';
import AdminLayout from '@/pages/admin/AdminLayout';
import AdminDashboard from '@/pages/admin/Dashboard';
import AdminUsers from '@/pages/admin/Users';
import AdminStorage from '@/pages/admin/Storage';
import AdminMounts from '@/pages/admin/Mounts';
import AdminPermissions from '@/pages/admin/Permissions';
import AdminShares from '@/pages/admin/Shares';
import AdminFiles from '@/pages/admin/Files';
import AdminLogs from '@/pages/admin/Logs';
import AdminSettings from '@/pages/admin/Settings';

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  useEffect(() => {
    void useAuth.getState().fetchMe();
  }, []);
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname)}`} replace />;
  return <Outlet />;
}

function RequireAdmin() {
  const { user } = useAuth();
  if (!user || user.role !== 'admin') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <h1 className="text-lg font-semibold">需要管理员权限</h1>
        <Link to="/files" className="text-sm text-primary">返回文件</Link>
      </div>
    );
  }
  return <Outlet />;
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3">
      <h1 className="text-3xl font-bold">404</h1>
      <p className="text-muted-foreground">{t('err.notFound')}</p>
      <Link to="/" className="text-sm text-primary">← {t('common.back')}</Link>
    </div>
  );
}

export default function App() {
  const { user } = useAuth();
  useEffect(() => {
    // 同步主题语言到账号（可选）
    void useAuth.getState().fetchMe();
    // 校验免费模式会话
    if (document.cookie.includes('fm_token=')) {
      useAuth.getState().setFreeMode(true);
    }
  }, []);

  // 未登录用户也拉取公开设置（用于 landing）
  useEffect(() => {
    apiFetch('/api/public/settings').catch(() => undefined);
  }, []);

  void user;
  return (
    <>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/free-mode" element={<FreeMode />} />
        <Route path="/share/:id" element={<SharePage />} />
        <Route path="/i/:id" element={<SharePage imageMode />} />

        <Route element={<RequireAuth />}>
          <Route path="/files" element={<Files />} />
          <Route path="/files/*" element={<Files />} />
          <Route path="/shares" element={<MyShares />} />
          <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path="profile" element={<ProfilePage />} />
            <Route path="security" element={<SecurityPage />} />
            <Route path="api-keys" element={<ApiKeysPage />} />
            <Route path="appearance" element={<AppearancePage />} />
          </Route>
        </Route>

        <Route element={<RequireAdmin />}>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminDashboard />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="storage" element={<AdminStorage />} />
            <Route path="mounts" element={<AdminMounts />} />
            <Route path="permissions" element={<AdminPermissions />} />
            <Route path="shares" element={<AdminShares />} />
            <Route path="files" element={<AdminFiles />} />
            <Route path="logs" element={<AdminLogs />} />
            <Route path="settings" element={<AdminSettings />} />
          </Route>
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
      <Toaster />
    </>
  );
}
