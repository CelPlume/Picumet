// Pages Functions 反代：/api/* 经 Service Binding 直连 Worker（不出公网）。
// 浏览器只见 Pages 域名；Worker 的 workers.dev 已关闭，API 没有任何公网入口。
// 请求原样透传（路径/查询/头/流式 body），响应（含 Set-Cookie）原样返回。
interface Env {
  API: { fetch(request: Request): Promise<Response> };
}

export async function onRequest(context: { request: Request; env: Env }): Promise<Response> {
  return context.env.API.fetch(context.request);
}
