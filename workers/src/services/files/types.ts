// 文件服务类型（spec_refactored.md §文件管理服务）
import type { FileMetadata, FileListItem } from '@shared/types';
import type {
  UpdateFileRequest,
  CreateFolderRequest,
  MoveFileRequest,
  BatchOpRequest,
  VerifyPasswordRequest,
} from './schemas';

export type {
  UpdateFileRequest,
  CreateFolderRequest,
  MoveFileRequest,
  BatchOpRequest,
  VerifyPasswordRequest,
  FileMetadata,
  FileListItem,
};
