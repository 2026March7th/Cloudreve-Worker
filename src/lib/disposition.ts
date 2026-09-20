/**
 * RFC 6266 规范的 Content-Disposition: attachment 值。
 * 对齐上游 entitysource.go:296-305：纯 ASCII 文件名用简单形式；
 * 含非 ASCII 时同时给 filename*（UTF-8 百分号编码）。
 */
export function attachmentDisposition(displayName: string): string {
  const asciiSafe = displayName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  if (asciiSafe === displayName) {
    return `attachment; filename="${asciiSafe}"`;
  }
  return `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encodeURIComponent(displayName)}`;
}
