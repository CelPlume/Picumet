// 路由与页面组织（页面按路由懒加载，降低首屏 JS）
import { Routes, Route, Navigate, Outlet, useLocation, Link } from 'react-router-dom';
import { useEffect, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { FullPageSpinner } from '@/components/ui/core';
import { Toaster } from '@/components/ui/toast';
import { useAuth } from '@/stores/auth';
import { useSite } from '@/stores/site';
import { apiFetch } from '@/lib/api';

const Landing = lazy(() => import('@/pages/Landing'));
const Login = lazy(() => import('@/pages/Login'));
const Register = lazy(() => import('@/pages/Register'));
const ResetPassword = lazy(() => import('@/pages/ResetPassword'));
const FreeMode = lazy(() => import('@/pages/FreeMode'));
const Files = lazy(() => import('@/pages/Files'));
const MyShares = lazy(() => import('@/pages/MyShares'));
const SharePage = lazy(() => import('@/pages/SharePage'));
const SettingsLayout = lazy(() => import('@/pages/settings/SettingsLayout'));
const ProfilePage = lazy(() => import('@/pages/settings/Profile'));
const SecurityPage = lazy(() => import('@/pages/settings/Security'));
const ApiKeysPage = lazy(() => import('@/pages/settings/ApiKeys'));
const AppearancePage = lazy(() => import('@/pages/settings/Appearance'));
const AdminLayout = lazy(() => import('@/pages/admin/AdminLayout'));
const AdminDashboard = lazy(() => import('@/pages/admin/Dashboard'));
const AdminUsers = lazy(() => import('@/pages/admin/Users'));
const AdminStorage = lazy(() => import('@/pages/admin/Storage'));
const AdminMounts = lazy(() => import('@/pages/admin/Mounts'));
const AdminPermissions = lazy(() => import('@/pages/admin/Permissions'));
const AdminShares = lazy(() => import('@/pages/admin/Shares'));
const AdminFiles = lazy(() => import('@/pages/admin/Files'));
const AdminLogs = lazy(() => import('@/pages/admin/Logs'));
const AdminSettings = lazy(() => import('@/pages/admin/Settings'));

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
    // 读取站点设置（标题/Logo/Favicon）
    void useSite.getState().load();
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
    <Suspense fallback={<FullPageSpinner />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/reset-password" element={<ResetPassword />} />
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
    </Suspense>
  );
}
