interface Env {
  API: { fetch(request: Request): Promise<Response> };
}

/**
 * 公网扫描器噪声（`.env*` / `.git/*` / `*.bak` / `.aws/*` …）。
 *
 * 两层都要拦，缺一不可：
 *   · Worker 的 path-serve —— 避免 3 次 D1 查询后才 404，拖慢正常直链；
 *   · Pages Functions —— 否则 Worker 返回的 404 会走到下面第 5 步的 SPA 兜底，
 *     把 `/.env` 变成 200 + index.html（看起来像站点在响应，其实是无意义的 HTML 外壳）。
 * 这些路径不可能是合法文件（上传侧 isValidFileName 禁止点开头），直接在此终结。
 */
const SCANNER_SEGMENT = /^\.|^(\.git|\.svn|\.hg|\.aws|\.ssh|\.docker|wp-admin|wp-content|phpmyadmin|adminer)$/i;
const SCANNER_FILE = /^(web\.config|appsettings|composer\.(json|lock)|package(-lock)?\.json|yarn\.lock|docker-compose|makefile|id_rsa|authorized_keys|wp-config|configuration)\./i;
const SCANNER_SUFFIX = /\.(bak|old|orig|save|swp|swo|dist|example|sample|tmp|temp|ini|sql|db|sqlite|key|pem|crt|p12|pfx|conf|config)$/i;

function isScannerNoise(pathname: string): boolean {
  for (const seg of pathname.split('/').filter(Boolean)) {
    if (SCANNER_SEGMENT.test(seg) || SCANNER_FILE.test(seg) || SCANNER_SUFFIX.test(seg)) return true;
  }
  return false;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const path = url.pathname;

  // 0. 扫描器噪声：Worker 与 Pages 之前直接 404（零 D1、零 SPA 回退、不产生日志噪声）
  if (isScannerNoise(path)) {
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  // 1. 协议通道（API、WebDAV、S3、OpenList、直链固定前缀）：全量直通 Worker
  //    S3 根路径入口（MinIO 式 endpoint = 裸域名）：携带 SigV4 签名的请求按 S3 API 解析，
  //    否则 `/uploads` 这类桶路径会被当成 SPA 路由返回 index.html
  const isSigV4 =
    url.searchParams.has('X-Amz-Signature') ||
    (context.request.headers.get('authorization') ?? '').startsWith('AWS4-HMAC-SHA256');
  if (
    isSigV4 ||
    path.startsWith('/api') ||
    path.startsWith('/webdav') ||
    path.startsWith('/s3') ||
    path.startsWith('/openlist') ||
    path.startsWith('/d/') ||
    path.startsWith('/raw/') ||
    path.startsWith('/download/')
  ) {
    return context.env.API.fetch(context.request);
  }

  // 2. Pages 静态前端产物：优先由 Pages 边缘静态分发
  if (
    path.startsWith('/assets/') ||
    path === '/favicon.svg' ||
    path === '/favicon.ico' ||
    path === '/site.webmanifest' ||
    path === '/robots.txt'
  ) {
    return context.next();
  }

  // 3. 已知 SPA 路由：交由 Pages 响应 index.html
  const isSpa =
    path === '/' ||
    path === '/files' ||
    path.startsWith('/files/') ||
    path === '/login' ||
    path === '/register' ||
    path === '/forgot-password' ||
    path === '/reset-password' ||
    path.startsWith('/settings') ||
    path.startsWith('/admin') ||
    path.startsWith('/share') ||
    path.startsWith('/sso') ||
    path === '/landing';

  // 4. 图床直链（带 ?sign= 或包含文件扩展名且非前端页面）：转发至 Worker 的 path-serve 直服。
  //    转发即定案：Worker 的 404 是**真实结论**（该路径没有文件），不能落到下面第 5 步
  //    的 SPA 兜底 —— 那会把「文件不存在」伪装成 200 + index.html，图床直链因此拿到 HTML 而非图片。
  if (url.searchParams.has('sign') || (!isSpa && path.includes('.'))) {
    return context.env.API.fetch(context.request);
  }

  // 5. 其余路由回退至 Pages（SPA 路由由 Pages 返回 index.html）
  return context.next();
};
