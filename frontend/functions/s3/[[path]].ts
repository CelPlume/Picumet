// Pages Functions 反代：/s3（S3 兼容网关）经 Service Binding 直连 Worker（不出公网独立入口）。
// minio 客户端 / PicGo 等外部工具的 SigV4 请求原样透传（含流式 body），响应（XML）原样返回。
interface Env {
  API: { fetch(request: Request): Promise<Response> };
}

export async function onRequest(context: { request: Request; env: Env }): Promise<Response> {
  return context.env.API.fetch(context.request);
}
