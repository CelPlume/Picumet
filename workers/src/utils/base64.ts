// base64 编解码辅助
export function encodeBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function decodeBase64(input: string): string {
  return atob(input);
}
