// Pages Functions 反代：/webdav 经 Service Binding 直连 Worker。
// WebDAV 客户端的 PROPFIND/GET/PUT/DELETE 等方法原样透传。
interface Env {
  API: { fetch(request: Request): Promise<Response> };
}

export async function onRequest(context: { request: Request; env: Env }): Promise<Response> {
  return context.env.API.fetch(context.request);
}
