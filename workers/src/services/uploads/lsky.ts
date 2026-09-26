// Lsky Pro V2 兼容壳：POST /api/v1/upload
// PicList lsky.ts 契约：multipart 字段 file；Authorization 用户自填（可含 Bearer 前缀）；
// 成败判据 body.status === true；URL = body.data.links.url；body.data.key 作为删除定位 hash。
// 复用 uploadBytes（路径模板 / 上传根边界 / 配额 / 覆盖语义 / 目录行与 /api/upload 完全一致）。
import { Hono } from 'hono';
import type { AppBindings } from '../../shared/types';
import { getDb, assertApiKeyProtocol } from '../../middleware/auth';
import { ApiError } from '../../shared/errors';
import { splitNestedFileName } from '../../utils/path';
import { uploadBytes } from './upload-bytes';

export const lskyRoutes = new Hono<AppBindings>();

lskyRoutes.post('/upload', async (c) => {
  const db = getDb(c);
  const apiKey = c.get('apiKey');
  // Lsky 风格错误：HTTP 200 + {status:false,message}（PicList 直接展示 message）
  const lskyError = (message: string) => c.json({ status: false, message, data: null });

  if (!apiKey) return lskyError('需要 API 密钥认证');
  if (!apiKey.permissions.includes('write')) return lskyError('密钥无上传权限');
  try {
    assertApiKeyProtocol(apiKey, 'api');
  } catch {
    return lskyError('该密钥未授权 api 协议');
  }
  const userId = c.get('userId');

  try {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return lskyError('缺少 file 字段');
    // {localFolder:N} 等重命名可让 multipart 文件名携带嵌套路径段
    const customPath = (form.get('path') as string | null) ?? undefined;
    const split = splitNestedFileName(file.name, customPath);

    const res = await uploadBytes(
      c, db, userId, apiKey.uploadPath,
      split.fileName, file.type, file.size, file.stream(), split.customPath
    );
    // ok() 壳：{success:true,data:{url,fileId,path,size,filename}}
    const resBody = await res.json() as { data?: { url?: string; fileId?: string; path?: string; size?: number; filename?: string } };
    const data = resBody.data ?? {};
    return c.json({
      status: true,
      message: 'success',
      data: {
        key: data.fileId ?? '',
        name: data.filename ?? split.fileName,
        path: data.path ?? '',
        size: data.size ?? 0,
        links: { url: data.url ?? '' },
      },
    });
  } catch (err) {
    const message = err instanceof ApiError || err instanceof Error ? err.message : '上传失败';
    return lskyError(message);
  }
});
