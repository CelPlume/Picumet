// 路由与页面组织（页面按路由懒加载，降低首屏 JS）
import { Routes, Route, Navigate, Outlet, useLocation, Link } from 'react-router-dom';
import { useEffect, lazy, Suspense } from 'react';
import { AppSkeleton } from '@/components/ui/skeleton';
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
const SharePage = lazy(() => import('@/pages/SharePage'));
const Browse = lazy(() => import('@/pages/Browse'));
const SettingsLayout = lazy(() => import('@/pages/settings/SettingsLayout'));
const PersonalizationPage = lazy(() => import('@/pages/settings/Personalization'));
const SharesPage = lazy(() => import('@/pages/settings/Shares'));
const ApiKeysPage = lazy(() => import('@/pages/settings/ApiKeys'));
const AccessRulesPage = lazy(() => import('@/pages/settings/AccessRules'));
const AdminLayout = lazy(() => import('@/pages/admin/AdminLayout'));
const AdminDashboard = lazy(() => import('@/pages/admin/Dashboard'));
const AdminUsers = lazy(() => import('@/pages/admin/Users'));
const AdminStorage = lazy(() => import('@/pages/admin/Storage'));
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
  if (loading) return <AppSkeleton />;
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
    <Suspense fallback={<AppSkeleton />}>
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
          <Route path="/shares" element={<Navigate to="/settings/shares" replace />} />
          <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path="profile" element={<PersonalizationPage />} />
            <Route path="shares" element={<SharesPage />} />
            <Route path="security" element={<Navigate to="/settings/profile" replace />} />
            <Route path="appearance" element={<Navigate to="/settings/profile" replace />} />
            <Route path="api-keys" element={<ApiKeysPage />} />
            <Route path="access-rules" element={<AccessRulesPage />} />
          </Route>
        </Route>

        <Route element={<RequireAdmin />}>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminDashboard />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="storage" element={<AdminStorage />} />
            <Route path="mounts" element={<Navigate to="/admin/storage?tab=mounts" replace />} />
            <Route path="permissions" element={<AdminPermissions />} />
            <Route path="shares" element={<AdminShares />} />
            <Route path="files" element={<AdminFiles />} />
            <Route path="logs" element={<AdminLogs />} />
            <Route path="settings" element={<AdminSettings />} />
          </Route>
        </Route>

        {/* 公开浏览（§C 游客）：未知路径按虚拟路径渲染只读文件页；挂载不存在时页内显示 404 态 */}
        <Route path="*" element={<Browse />} />
      </Routes>
      <Toaster />
    </Suspense>
  );
}
