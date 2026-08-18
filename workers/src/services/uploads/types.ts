// 上传服务类型（spec_refactored.md §上传服务）
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
