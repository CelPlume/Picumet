// 分享服务类型（docs/ARCHITECTURE_CN.md §分享服务）
import type { Share, ShareStatus } from '@shared/types';
import type { CreateShareRequest } from './schemas';
import type { DownloadTokenPayload } from './tokens';

export type { CreateShareRequest, Share, ShareStatus, DownloadTokenPayload };

/** 分享短链代码（6-8 位） */
export type ShortCode = string;
