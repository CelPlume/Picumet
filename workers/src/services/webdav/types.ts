// WebDAV 服务类型（spec_refactored.md §WebDAV服务）

/** WebDAV 资源（PROPFIND 响应项） */
export interface WebDAVResource {
  href: string;
  displayName: string;
  contentLength?: number;
  contentType?: string;
  lastModified: Date;
  resourceType: 'collection' | 'file';
  etag?: string;
}

/** PROPFIND 请求解析结果 */
export interface PropfindRequest {
  depth: 0 | 1 | 'infinity';
  properties: string[];
}
