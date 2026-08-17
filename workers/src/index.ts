// Picumet Workers 入口：Hono 应用组装
import { Hono } from 'hono';
import { corsHeaders, securityHeaders, initContext, errorHandler } from './middleware/global';
import { authMiddleware, adminMiddleware, optionalAuthMiddleware, apiKeyAuthMiddleware } from './middleware/auth';
import { csrfMiddleware } from './middleware/csrf';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { authRoutes } from './routes/auth';
import { filesRoutes } from './routes/files';
import { fileOpsRoutes } from './routes/file-ops';
import { uploadRoutes } from './routes/uploads';
import { shareRoutes } from './routes/shares';
import { userRoutes } from './routes/users';
import { keyRoutes } from './routes/keys';
import { adminRoutes } from './routes/admin';
import { adminStorageRoutes } from './routes/admin-storage';
import { compatRoutes } from './routes/compat';
import { webdavRoutes } from './routes/webdav';
import { freeModeRoutes } from './routes/free-mode';
import { gatewayRoutes } from './routes/gateway';
import { publicRoutes } from './routes/public';
import { ensureSeed } from './seed';
import { runScheduledTasks } from './services/cleanup';
import { ok, fail } from './utils/response';
import { ApiError } from './utils/errors';
import type { AppVariables, Env } from './types';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use('*', initContext);
app.use('*', corsHeaders);
app.use('*', securityHeaders);

// 公共 API
app.route('/api/public', publicRoutes);
app.route('/api/gateway', gatewayRoutes);

// 认证（注册/登录公开，/me 需认证）
app.use('/api/auth/*', optionalAuthMiddleware, rateLimitMiddleware);
app.route('/api/auth', authRoutes);

// 兼容上传（PicGo）：Bearer API Key
app.use('/api/upload', apiKeyAuthMiddleware, rateLimitMiddleware);
app.route('/api/upload', compatRoutes);
app.use('/api/compat/*', apiKeyAuthMiddleware, rateLimitMiddleware);
app.route('/api/compat', compatRoutes);

// WebDAV
app.route('/webdav', webdavRoutes);

// 自由模式
app.route('/api/free-mode', freeModeRoutes);

// 需登录的 API
const protectedApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();
protectedApi.use('*', authMiddleware, csrfMiddleware, rateLimitMiddleware);

// 文件
protectedApi.route('/files', uploadRoutes);
protectedApi.route('/files', filesRoutes);
protectedApi.route('/files', fileOpsRoutes);

// 分享（公开 GET /:id、/:id/download、/:id/preview，其余需登录）
const sharesApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();
sharesApi.use('*', optionalAuthMiddleware, rateLimitMiddleware);
sharesApi.route('/', shareRoutes);
app.route('/api/shares', sharesApi);

protectedApi.route('/users', userRoutes);
protectedApi.route('/keys', keyRoutes);

// 管理员
const adminApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();
adminApi.use('*', authMiddleware, adminMiddleware, csrfMiddleware, rateLimitMiddleware);
adminApi.route('/', adminRoutes);
adminApi.route('/', adminStorageRoutes);
protectedApi.route('/admin', adminApi);

app.route('/api', protectedApi);

// 根路径健康检查
app.get('/', (c) => c.json({ service: 'picumet-api', status: 'ok' }));
app.get('/api', (c) => ok(c, { service: 'picumet-api', status: 'ok' }));

// 全局错误处理
app.onError(errorHandler);
app.notFound((c) => fail(c, new ApiError(404, 'NOT_FOUND', '接口不存在')));

// ---------- 入口 ----------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      await ensureSeed(env);
    } catch (err) {
      console.error('seed failed', err);
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScheduledTasks(env).catch((err) => {
        console.error('scheduled tasks failed', err);
      })
    );
  },
};

// 供测试直接构建 app（内存绑定场景）
export { app as buildApp };
