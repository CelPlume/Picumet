// S3 兼容存储预设（对照报告 §5.2 单表单平铺 + 用户要求：R2/AWS/Oracle 给预设，MinIO/自定义自行填 URL）
// 预设只做"预填"，不是模式切换：所有字段始终平铺可见，选择后可自由修改。
export interface StoragePreset {
  id: string;
  label: string;
  /** 具体预设直接预填 endpoint；占位式预设留空由用户填写 */
  endpoint: string;
  region: string;
  /** endpoint 输入框 placeholder（占位式预设的填写引导） */
  endpointHint: string;
  /** R2 S3 API 需要 Account ID 快捷拼接 */
  needsAccountId?: boolean;
}

export const STORAGE_PRESETS: StoragePreset[] = [
  {
    id: 'r2',
    label: 'Cloudflare R2',
    endpoint: '',
    region: 'auto',
    // 后台表单：留空 = Worker R2 绑定（无需凭据）；也可填 S3 API 端点
    endpointHint: '留空 = 使用 R2 绑定；或填 S3 API：https://<account_id>.r2.cloudflarestorage.com',
    needsAccountId: true,
  },
  {
    id: 'aws',
    label: 'AWS S3',
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    region: 'us-east-1',
    endpointHint: 'https://s3.<region>.amazonaws.com',
  },
  {
    id: 'oracle',
    label: 'Oracle Cloud',
    endpoint: '',
    region: '',
    endpointHint: 'https://<namespace>.compat.objectstorage.<region>.oraclecloud.com',
  },
  {
    id: 'minio',
    label: 'MinIO',
    endpoint: '',
    region: '',
    endpointHint: '自行填写，如 http://minio.example.com:9000',
  },
  {
    id: 'custom',
    label: '自定义',
    endpoint: '',
    region: '',
    endpointHint: '自行填写 S3 兼容端点 URL',
  },
];

/** R2 S3 API 端点拼接（Account ID 快捷） */
export function r2S3Endpoint(accountId: string): string {
  return `https://${accountId.trim()}.r2.cloudflarestorage.com`;
}
