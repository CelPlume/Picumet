// 路径处理工具：归一化、边界判断、通配符匹配、对象键生成

/**
 * 规范化路径：
 * 1. 移除多余斜杠：//a///b -> /a/b
 * 2. 解析相对路径：/a/b/../c -> /a/c（禁止 .. 逃逸）
 * 3. 移除尾部斜杠：/a/b/ -> /a/b
 * 4. 确保以 / 开头
 * 5. Unicode NFC 归一化
 */
export function normalizePath(path: string): string {
  if (!path) return '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path;
  }
  decoded = decoded.normalize('NFC');

  // 拒绝 .. 与 ~（路径遍历防护）
  if (decoded.includes('..') || decoded.includes('~')) {
    throw new PathError('INVALID_PATH', '路径包含非法字符');
  }

  if (!decoded.startsWith('/')) {
    decoded = '/' + decoded;
  }

  const segments: string[] = [];
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) {
        throw new PathError('INVALID_PATH', '路径越界');
      }
      segments.pop();
      continue;
    }
    segments.push(seg);
  }

  const normalized = '/' + segments.join('/');
  return normalized === '/' ? '/' : normalized;
}

export class PathError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'PathError';
  }
}

/**
 * 路径段判断：path 是否在 boundary 边界内。
 * 使用路径段边界而非 startsWith，防止 /users/alice 访问 /users/alice2。
 */
export function isPathWithinBoundary(path: string, boundary: string): boolean {
  const p = normalizePath(path);
  const b = normalizePath(boundary);
  if (b === '/') return true;
  if (p === b) return true;
  return p.startsWith(b + '/');
}

/** 严格路径段相等（供 /users/alice vs /users/alice2 测试） */
export function isSamePathSegment(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (na === nb) return true;
  return na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

/** 获取父路径 */
export function parentPath(path: string): string {
  const p = normalizePath(path);
  if (p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

/** 获取路径段数组 */
export function pathSegments(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean);
}

/** 获取文件名（路径最后一段） */
export function basename(path: string): string {
  const p = normalizePath(path);
  if (p === '/') return '/';
  const segs = p.split('/').filter(Boolean);
  return segs[segs.length - 1] || '/';
}

/**
 * 路径模式匹配（支持通配符）
 * - 精确模式 P：匹配 P 及其所有后代（路径段边界，继承父路径）
 * - /images/*      单层通配
 * - /images/**     递归通配
 */
export function pathMatches(path: string, pattern: string): boolean {
  const p = normalizePath(path);
  const pat = normalizePath(pattern);

  if (pat === p) return true;

  // 无通配符的普通模式：继承到所有后代（如 /images 匹配 /images/a.jpg）
  if (!pat.includes('*') && !pat.includes(':')) {
    return isPathWithinBoundary(p, pat) && p !== pat ? true : false;
  }

  if (pat.endsWith('/*')) {
    const prefix = pat.slice(0, -2);
    if (p === prefix) return true;
    if (!isPathWithinBoundary(p, prefix)) return false;
    return !p.slice(prefix.length + 1).includes('/');
  }

  if (pat.endsWith('/**')) {
    const prefix = pat.slice(0, -3);
    return p === prefix || isPathWithinBoundary(p, prefix);
  }

  return false;
}

/**
 * 匹配优先级：精确 > 变量 > 单层通配 > 递归通配
 */
export function matchPriority(pattern: string): number {
  const pat = normalizePath(pattern);
  if (!pat.includes('*') && !pat.includes(':')) return 1000;
  if (pat.includes(':')) return 500;
  if (pat.endsWith('/*')) return 100;
  if (pat.includes('**')) return 10;
  return 0;
}

/**
 * 根据虚拟路径生成对象存储键（挂载前缀 + 规范化路径）
 */
export function objectKeyFromPath(mountPath: string, pathPrefix: string, virtualPath: string): string {
  const vp = normalizePath(virtualPath);
  const mount = normalizePath(mountPath);
  let rel = vp;
  if (mount !== '/') {
    if (rel === mount) rel = '/';
    else if (rel.startsWith(mount + '/')) rel = rel.slice(mount.length);
  }
  const prefix = normalizePath(pathPrefix);
  const combined = (prefix === '/' ? '' : prefix) + rel;
  return combined === '/' || combined === '' ? '' : combined.replace(/^\/+/, '');
}

/** 上传路径模板变量替换：{year} {month} {day} {uuid} {hash} {ext} {mime} {username} */
export function renderPathTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(value);
  }
  return out;
}

export function buildTemplateVars(opts: {
  now?: Date;
  uuid: string;
  hash?: string;
  ext?: string;
  mime?: string;
  username?: string;
}): Record<string, string> {
  const d = opts.now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    year: String(d.getFullYear()),
    month: pad(d.getMonth() + 1),
    day: pad(d.getDate()),
    hour: pad(d.getHours()),
    minute: pad(d.getMinutes()),
    uuid: opts.uuid,
    hash: opts.hash ?? '',
    ext: opts.ext ?? '',
    mime: opts.mime ?? '',
    username: opts.username ?? '',
  };
}

/** 文件名安全校验（防注入） */
export function isValidFileName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('..')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\x00-\x1F]/.test(name)) return false;
  return true;
}

/** 危险文件扩展名 */
export const DANGEROUS_EXTENSIONS = [
  '.exe', '.bat', '.cmd', '.sh', '.php', '.asp', '.jsp', '.aspx',
  '.dll', '.so', '.dylib', '.msi', '.scr', '.ps1', '.vbs', '.jar',
];

export const DANGEROUS_MIME_TYPES = [
  'application/x-msdownload',
  'application/x-executable',
  'application/x-sharedlib',
  'application/x-msdos-program',
  'application/x-httpd-php',
  'text/html',
  'application/xhtml+xml',
  'application/x-java-archive',
];

/** 文件类型安全校验（防上传恶意可执行文件） */
export function validateFileType(fileName: string, mimeType?: string): void {
  const ext = fileName.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  if (DANGEROUS_EXTENSIONS.includes(ext)) {
    throw new PathError('DANGEROUS_FILE_TYPE', `禁止上传 ${ext} 文件`);
  }
  if (mimeType && DANGEROUS_MIME_TYPES.includes(mimeType.toLowerCase())) {
    throw new PathError('DANGEROUS_MIME_TYPE', `禁止上传 ${mimeType} 类型文件`);
  }
}

/**
 * 拆分嵌套文件名（P1-3.6）：PicList `{localFolder:N}` 重命名可让 multipart 文件名 / X-File-Name
 * 携带 `/`，将其前段并入 customPath、尾段作为受校验的 basename。
 */
export function splitNestedFileName(rawName: string, customPath?: string): { fileName: string; customPath?: string } {
  const idx = rawName.lastIndexOf('/');
  if (idx < 0) return { fileName: rawName, customPath };
  const dir = rawName.slice(0, idx);
  const base = rawName.slice(idx + 1);
  if (!dir || !base) return { fileName: base || rawName, customPath };
  return { fileName: base, customPath: customPath ? `${customPath}/${dir}` : dir };
}
