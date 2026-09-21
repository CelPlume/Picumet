// §26 违规封禁：内容出口统一门禁
import type { Db } from '../../db';
import { ApiError } from '../../shared/errors';

/**
 * 封禁门禁：任一 fileIds 命中 file_metadata.banned = 1 即抛 429 FILE_BANNED。
 * 调用时机：解析出具体文件之后、返回内容之前；空数组直接放行。
 * 删除流程不得调用 —— 封禁文件必须仍可删除。
 */
export async function assertNotBanned(db: Db, fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  const rows = await db.all(
    `SELECT id FROM file_metadata WHERE banned = 1 AND id IN (${fileIds.map(() => '?').join(',')})`,
    fileIds
  );
  if (rows.length > 0) throw new ApiError(429, 'FILE_BANNED', '文件违规');
}
