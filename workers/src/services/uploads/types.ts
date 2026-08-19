// 上传服务类型（docs/ARCHITECTURE_CN.md §上传服务）
import type { UploadSession, UploadSessionStatus } from '@shared/types';
import type { InitUploadRequest } from './schemas';

export type UploadStatus = UploadSessionStatus;

export interface PartInfo {
  partNumber: number;
  etag: string;
  size: number;
}

export type {
  InitUploadRequest,
  UploadSession,
  UploadSessionStatus,
};
