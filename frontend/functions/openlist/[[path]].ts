// Pages Functions 反代：/openlist（AList/OpenList 兼容 shim）经 Service Binding 直连 Worker。
// fs/list、直链 /openlist/d/* 等请求原样透传。
interface Env {
  API: { fetch(request: Request): Promise<Response> };
}

export async function onRequest(context: { request: Request; env: Env }): Promise<Response> {
  return context.env.API.fetch(context.request);
}
