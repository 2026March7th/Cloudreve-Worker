/**
 * 分享链接的社交媒体 OG 预览。移植自上游 PR #3234（middleware/share_preview.go）：
 * 爬虫（Telegram/Discord/TwitterBot 等）请求 `/s/:id[/:password]` 时，不再 302，
 * 而是直接渲染一张带 og:* meta 的 HTML —— 社交平台卡片能显示分享名、大小、
 * 属主和站点图标。真人照常走原重定向逻辑。
 *
 * 与上游的差异：
 *   - 上游还覆盖 `/home?path=cloudreve://...`（SPA 路径，由后端渲染 index.html）；
     边缘版 /home 由静态资源直接服务，Worker 不经手，故只覆盖 /s/*；
 *   - 缩略图不做（上游在解锁时尝试分享缩略图，失败回落站点图标）；边缘版
 *     直接用 PWA 大图标，省一次匿名缩略图解析。
 */
import type { AppContext } from './context';
import { ShareService } from './share';
import { FileSystemService } from './fs';
import type { AppBindings } from '../middleware/app';
import type { Context } from 'hono';

/** 与上游 socialMediaBots 一致。 */
const SOCIAL_MEDIA_BOTS = [
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

export function isSocialMediaBot(ua: string | undefined): boolean {
  if (!ua) return false;
  const lower = ua.toLowerCase();
  return SOCIAL_MEDIA_BOTS.some((b) => lower.includes(b));
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 上游 formatFileSize。 */
function formatFileSize(size: number): string {
  const KB = 1024;
  const MB = 1024 * KB;
  const GB = 1024 * MB;
  const TB = 1024 * GB;
  if (size >= TB) return (size / TB).toFixed(2) + ' TB';
  if (size >= GB) return (size / GB).toFixed(2) + ' GB';
  if (size >= MB) return (size / MB).toFixed(2) + ' MB';
  if (size >= KB) return (size / KB).toFixed(2) + ' KB';
  return String(size) + ' B';
}

interface OgData {
  siteName: string;
  title: string;
  description: string;
  imageUrl: string;
  shareUrl: string;
  redirectUrl: string;
}

function renderOgHtml(d: OgData): string {
  const e = escapeHtml;
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta property="og:title" content="${e(d.title)}">
    <meta property="og:description" content="${e(d.description)}">
    <meta property="og:image" content="${e(d.imageUrl)}">
    <meta property="og:url" content="${e(d.shareUrl)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="${e(d.siteName)}">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="${e(d.title)}">
    <meta name="twitter:description" content="${e(d.description)}">
    <meta name="twitter:image" content="${e(d.imageUrl)}">
    <title>${e(d.title)} - ${e(d.siteName)}</title>
</head>
<body>
    <script>window.location.href = "${e(d.redirectUrl)}";</script>
    <noscript><a href="${e(d.redirectUrl)}">${e(d.title)}</a></noscript>
</body>
</html>`;
}

/** 为爬虫渲染分享 OG 页。调用方已确认 UA 是社交媒体爬虫。 */
export async function renderSharePreview(
  c: Context<AppBindings>,
  ctx: AppContext,
  shareHashId: string,
  password: string | undefined,
  redirectUrl: string,
): Promise<Response> {
  const settings = ctx.settings;
  const data: OgData = {
    siteName: settings.siteName,
    title: settings.siteName,
    description: settings.get('siteDescription', '') || settings.siteTitle,
    shareUrl: settings.siteUrl.replace(/\/+$/, '') + c.req.path,
    imageUrl: '',
    redirectUrl,
  };

  const icon = settings.get('pwa_large_icon', '/static/img/logo512.png');
  data.imageUrl = /^https?:\/\//.test(icon)
    ? icon
    : settings.siteUrl.replace(/\/+$/, '') + icon;

  const share = new ShareService(ctx, new FileSystemService(ctx));
  try {
    const info = await share.info(shareHashId, { password, countViews: false });
    data.title = info.name ?? data.title;
    if (info.source_type === 1) {
      data.description = 'Folder';
    } else if (info.unlocked) {
      data.description = formatFileSize(Number(info.size ?? 0));
    }
    if (!info.owner.anonymous) {
      data.description += ' · ' + info.owner.nickname;
    }
  } catch (e) {
    // 与上游一致：把失败原因（如 "Share link expired"）作为描述，标题回落站点名
    data.description = e instanceof Error ? e.message : 'Invalid Link';
  }

  return c.html(renderOgHtml(data));
}
