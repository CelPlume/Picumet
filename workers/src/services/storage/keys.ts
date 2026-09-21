// 物理对象键方案（§F 内容哈希寻址）
//
// 命名空间约束：内容寻址对象与上传暂存对象的键都带 'picumet:' 前缀段。虚拟路径键由
// objectKeyFromPath 生成，而文件名/目录名校验禁止 ':'（utils/path.ts isValidFileName），
// 因此这两类键永远不可能与用户虚拟路径键冲突。
import { objectKeyFromPath, normalizePath } from '../../utils/path';

/** 内容寻址对象命名空间：`<pathPrefix>/picumet:blob/<hash 前两位>/<hash>` */
const BLOB_NAMESPACE = 'picumet:blob';
/** 写入暂存命名空间：`<pathPrefix>/picumet:staging/<uuid>`，仅在写入期间存在 */
const STAGING_NAMESPACE = 'picumet:staging';

/** 内容哈希对应的物理对象键（provider 路径前缀沿用原有前缀语义） */
export function blobObjectKey(pathPrefix: string | null | undefined, hash: string): string {
  return objectKeyFromPath('/', pathPrefix ?? '', `/${BLOB_NAMESPACE}/${hash.slice(0, 2)}/${hash}`);
}

/** 上传暂存对象键：写入完成后复制到内容键（或去重命中时直接删除） */
export function stagingObjectKey(pathPrefix: string | null | undefined, id: string): string {
  return objectKeyFromPath('/', pathPrefix ?? '', `/${STAGING_NAMESPACE}/${id}`);
}

/** 文件行对应的物理对象键：内容寻址文件取 physical_key，存量/未去重行回退 object_key */
export function physicalObjectKey(file: { physicalKey?: string | null; objectKey: string }): string {
  return file.physicalKey ?? file.objectKey;
}

/** 判断键是否为内容寻址对象键（对账/清理用） */
export function isBlobObjectKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return normalizePath(`/${key}`).includes(`/${BLOB_NAMESPACE}/`);
}
