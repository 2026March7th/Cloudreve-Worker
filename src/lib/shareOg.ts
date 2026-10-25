/**
 * 分享链接的 OG 预览页渲染。纯函数，不碰数据库 —— 拆出来是为了能单测
 * （见 `scripts/test-share-og.mjs`）。中间件在 `middleware/sharePreview.ts`。
 *
 * 对应上游 `middleware/share_preview.go` 的 ogData / ogHTMLTemplate /
 * isSocialMediaBot / extractShareParams / formatFileSize。
 */

/** 上游 `socialMediaBots` 列表，逐字一致。 */
export const SOCIAL_BOTS = [
  'facebookexternalhit',
  'facebookcatalog',
  'facebot',
  'twitterbot',
  'linkedinbot',
  'discordbot',
  'telegrambot',
  'slackbot',
  'whatsapp',
];

export function isSocialBot(ua: string | undefined): boolean {
  if (!ua) return false;
  const lower = ua.toLowerCase();
  return SOCIAL_BOTS.some((bot) => lower.includes(bot));
}

/** 从请求路径/query 里取出分享 id 与密码；不是分享路径返回 null。 */
export function extractShare(path: string, query: (name: string) => string | undefined): {
  id: string;
  password: string;
} | null {
  if (path.startsWith('/s/')) {
    const parts = path.slice(3).split('/').filter(Boolean);
    if (parts.length === 0 || !parts[0]) return null;
    return { id: parts[0]!, password: parts[1] ?? '' };
  }
  if (path === '/home' || path === '/home/') {
    const raw = query('path') ?? '';
    // cloudreve://<hashid>[:<password>]@share[/sub]
    // id 组排除冒号：否则 `m5fM:pwd@share` 会把 `m5fM:pwd` 整段当 id
    const m = /^cloudreve:\/\/([^@/:]+)(?::([^@/]*))?@share/i.exec(raw);
    if (!m) return null;
    return { id: m[1]!, password: m[2] ?? '' };
  }
  return null;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatSize(size: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  const TB = GB * 1024;
  if (size >= TB) return `${(size / TB).toFixed(2)} TB`;
  if (size >= GB) return `${(size / GB).toFixed(2)} GB`;
  if (size >= MB) return `${(size / MB).toFixed(2)} MB`;
  if (size >= KB) return `${(size / KB).toFixed(2)} KB`;
  return `${size} B`;
}

/** 拼绝对地址：OG 的 meta 不接受相对路径。 */
export function absoluteUrl(siteUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${siteUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export interface OgPageData {
  siteName: string;
  title: string;
  description: string;
  image: string;
  shareUrl: string;
  redirectUrl: string;
}

/** 渲染 OG 页面。字段与上游 ogHTMLTemplate 一致。 */
export function renderOgPage(data: OgPageData): string {
  const title = escapeHtml(data.title);
  const siteName = escapeHtml(data.siteName);
  const description = escapeHtml(data.description);
  const image = escapeHtml(data.image);
  const shareUrl = escapeHtml(data.shareUrl);
  const redirect = JSON.stringify(data.redirectUrl);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${image}">
<meta property="og:url" content="${shareUrl}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${siteName}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${image}">
<title>${title} - ${siteName}</title>
</head>
<body>
<script>window.location.href = ${redirect};</script>
<noscript><a href="${escapeHtml(data.redirectUrl)}">${title}</a></noscript>
</body>
</html>`;
}
