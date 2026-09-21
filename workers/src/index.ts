// Picumet Workers 入口：Hono 应用组装
import { Hono } from 'hono';
import { corsHeaders, securityHeaders, initContext, errorHandler } from './middleware/global';
import { authMiddleware, adminMiddleware, optionalAuthMiddleware, apiKeyAuthMiddleware, apiKeyTokenAuthMiddleware } from './middleware/auth';
import { csrfMiddleware } from './middleware/csrf';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { transferConcurrencyMiddleware } from './middleware/concurrency';
import { downloadRateLimitMiddleware } from './middleware/download-limit';
import { authRoutes } from './services/auth/handlers';
import { filesRoutes } from './services/files/handlers';
import { fileOpsRoutes } from './services/files/operations';
import { uploadRoutes } from './services/uploads/handlers';
import { shareRoutes } from './services/shares/handlers';
import { userRoutes } from './services/users/handlers';
import { userRuleRoutes } from './services/users/rules';
import { keyRoutes } from './services/keys/handlers';
import { adminRoutes } from './services/admin/handlers';
import { adminStorageRoutes } from './services/admin/storage';
import { compatRoutes } from './services/uploads/compat';
import { lskyRoutes } from './services/uploads/lsky';
import { webdavRoutes } from './services/webdav/handlers';
import { s3gwRoutes } from './services/s3gw/handlers';
import { alistRoutes } from './services/alist/handlers';
import { freeModeRoutes } from './services/free-mode/handlers';
import { gatewayRoutes } from './services/shares/gateway';
import { publicRoutes } from './services/public/handlers';
import { publicFsRoutes } from './services/public/fs';
import { galleryRoutes } from './services/public/gallery';
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
// 公开目录浏览（§C 游客）：可选认证（区分匿名/登录可见性）+ 限速
const publicFsApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();
publicFsApi.use('*', optionalAuthMiddleware, rateLimitMiddleware, downloadRateLimitMiddleware);
publicFsApi.route('/', publicFsRoutes);
app.route('/api/public', publicFsApi);
// 下载网关：可选认证（登录态用于分享访问策略实时校验）+ 限速
const gatewayApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();
gatewayApi.use('*', optionalAuthMiddleware, rateLimitMiddleware, downloadRateLimitMiddleware, transferConcurrencyMiddleware);
gatewayApi.route('/', gatewayRoutes);
app.route('/api/gateway', gatewayApi);

// 认证（注册/登录公开，/me 需认证）
app.use('/api/auth/*', optionalAuthMiddleware, rateLimitMiddleware);
app.route('/api/auth', authRoutes);

// 兼容上传（PicGo）：Bearer API Key
app.use('/api/upload', apiKeyAuthMiddleware, rateLimitMiddleware, transferConcurrencyMiddleware);
app.route('/api/upload', compatRoutes);
app.use('/api/compat/*', apiKeyAuthMiddleware, rateLimitMiddleware, transferConcurrencyMiddleware);
app.route('/api/compat', compatRoutes);

// Lsky Pro V2 兼容壳（PicList 内置 lskyplist 通道）：Bearer/裸 token API Key
app.use('/api/v1/*', apiKeyTokenAuthMiddleware, rateLimitMiddleware, transferConcurrencyMiddleware);
app.route('/api/v1', lskyRoutes);

// WebDAV
app.route('/webdav', webdavRoutes);

// S3 兼容网关（SigV4；路径式寻址，endpoint = https://host/s3）
app.use('/s3', rateLimitMiddleware);
app.use('/s3/*', rateLimitMiddleware);
app.route('/s3', s3gwRoutes);

// AList/OpenList 兼容 shim（PicList 内置 alistplist 通道；独立前缀避开自有 /api/auth/login）
app.use('/openlist/*', rateLimitMiddleware);
app.route('/openlist', alistRoutes);

// 自由模式
app.route('/api/free-mode', freeModeRoutes);

// 公开空间 gallery（§4.2：匿名面，显式列表接口，非池子）
const galleryApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();
galleryApi.use('*', optionalAuthMiddleware, rateLimitMiddleware);
galleryApi.route('/', galleryRoutes);
app.route('/api/gallery', galleryApi);

// 需登录的 API
const protectedApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();
protectedApi.use('*', authMiddleware, csrfMiddleware, rateLimitMiddleware, downloadRateLimitMiddleware);

// 文件（上传类接口额外叠传输并发限制：并发数由系统设置 max_concurrent_transfers 控制）
protectedApi.use('/files/upload-session', transferConcurrencyMiddleware);
protectedApi.use('/files/upload/*', transferConcurrencyMiddleware);
protectedApi.use('/files/upload-complete', transferConcurrencyMiddleware);
protectedApi.route('/files', uploadRoutes);
protectedApi.route('/files', filesRoutes);
protectedApi.route('/files', fileOpsRoutes);

// 分享（公开 GET /:id、/:id/download、/:id/preview，其余需登录）
const sharesApi = new Hono<{ Bindings: Env; Variables: AppVariables }>();
sharesApi.use('*', optionalAuthMiddleware, rateLimitMiddleware, downloadRateLimitMiddleware);
sharesApi.route('/', shareRoutes);
app.route('/api/shares', sharesApi);

protectedApi.route('/users', userRoutes);
protectedApi.route('/users', userRuleRoutes);
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
