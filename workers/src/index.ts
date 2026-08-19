// Picumet Workers 入口：Hono 应用组装
import { Hono } from 'hono';
import { corsHeaders, securityHeaders, initContext, errorHandler } from './middleware/global';
import { authMiddleware, adminMiddleware, optionalAuthMiddleware, apiKeyAuthMiddleware } from './middleware/auth';
import { csrfMiddleware } from './middleware/csrf';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { authRoutes } from './services/auth/handlers';
import { filesRoutes } from './services/files/handlers';
import { fileOpsRoutes } from './services/files/operations';
import { uploadRoutes } from './services/uploads/handlers';
import { shareRoutes } from './services/shares/handlers';
import { userRoutes } from './services/users/handlers';
import { keyRoutes } from './services/keys/handlers';
import { adminRoutes } from './services/admin/handlers';
import { adminStorageRoutes } from './services/admin/storage';
import { compatRoutes } from './services/uploads/compat';
import { webdavRoutes } from './services/webdav/handlers';
import { freeModeRoutes } from './services/free-mode/handlers';
import { gatewayRoutes } from './services/shares/gateway';
import { publicRoutes } from './services/public/handlers';
import { pathPublicRoutes } from './services/files/path-serve';
import { ensureSeed } from './seed';
import { runScheduledTasks } from './services/cleanup';
import { ok, fail } from './shared/response';
import { ApiError } from './shared/errors';
import type { AppVariables, Env } from './shared/types';

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

// 公开路径文件服务（最后注册，避免遮蔽 /api、/webdav 等路由）
app.use('/*', optionalAuthMiddleware);
app.route('/', pathPublicRoutes);

// 全局错误处理
app.onError(errorHandler);
app.notFound((c) => fail(c, new ApiError(404, 'NOT_FOUND', '接口不存在')));

// ---------- 入口 ----------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 生产 fail-closed（审计 H-02/M-06）：未完成初始化（缺管理员或 seed 失败）时，
    // 业务 API 返回 503，仅放行健康检查与公共路由；不再静默吞错继续服务。
    const isProd = (env.ENVIRONMENT as string) === 'production';
    let seedReady = false;
    if (isProd) {
      try {
        const marker = await env.KV.get('seed:done');
        seedReady = marker === '1';
        if (!seedReady) {
          // 尝试完成初始化；失败则由下方 fail-closed 拦截
          await ensureSeed(env);
          seedReady = true;
        }
      } catch (err) {
        console.error('seed failed (production fail-closed)', err);
        seedReady = false;
      }
      if (!seedReady) {
        const url = new URL(request.url);
        const publicPath = url.pathname === '/' ||
          url.pathname.startsWith('/api/health') ||
          url.pathname.startsWith('/api/public');
        if (!publicPath) {
          return new Response(
            JSON.stringify({
              success: false,
              error: { code: 'INITIALIZATION_REQUIRED', message: '服务尚未完成初始化，请联系管理员' },
              timestamp: Date.now(),
            }),
            { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
          );
        }
      }
    } else {
      try {
        await ensureSeed(env);
      } catch (err) {
        console.error('seed failed', err);
      }
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
