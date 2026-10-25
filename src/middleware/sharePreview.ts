/**
 * 分享链接的社交媒体预览（Open Graph）。对应上游
 * `middleware/share_preview.go`（PR #3234）。
 *
 * 做法：识别社交媒体爬虫的 User-Agent，对 `/s/:id` 和
 * `/home?path=cloudreve://…@share` 直接回一个带 OG meta 的 HTML 页面，
 * 真浏览器则用 `<script>` 跳转到原来的 SPA 地址。
 *
 * 为什么值得做：不这么做的话，把分享链接丢到微信 / Telegram / Discord 里，
 * 卡片上只有一句干巴巴的站点名 —— 对方不知道这是文件还是文件夹、多大、
 * 谁分享的。爬虫不执行 JS，所以 SPA 里的内容它一个都看不到。
 *
 * 注意点：
 *   - 预览要的是「真实内容」，所以这里**不增加浏览量**（countViews=false），
 *     也不写审计 —— 否则每被爬一次计数就虚涨一次。
 *   - 分享不存在 / 已过期时按上游的措辞给「Invalid Link」，不泄露具体原因。
 *   - `Cache-Control: public, no-cache`：允许 CDN 存，但每次都要回源校验，
 *     免得链接过期了卡片还挂着旧标题。
 */
import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from './app';
import { ctxOf } from './app';
import { ShareService } from '../services/share';
import { FileSystemService } from '../services/fs';
import { DownloadService } from '../services/download';
import { URI } from '../services/uri';
import { absoluteUrl, extractShare, formatSize, isSocialBot, renderOgPage } from '../lib/shareOg';

export function sharePreview(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (!isSocialBot(c.req.header('User-Agent'))) {
      await next();
      return;
    }
    const share = extractShare(c.req.path, (name) => c.req.query(name));
    if (!share) {
      await next();
      return;
    }

    const ctx = ctxOf(c);
    const settings = ctx.settings;
    const siteUrl = settings.siteUrl.replace(/\/+$/, '');
    const siteName = settings.siteName;
    const shareUri = `cloudreve://${share.id}${share.password ? `:${share.password}` : ''}@share`;

    // 默认用站点图标，拿到真实分享后再换成缩略图
    let image = absoluteUrl(
      siteUrl,
      settings.get('pwa_large_icon', '') ||
        settings.get('pwa_medium_icon', '/static/img/logo192.png'),
    );
    let title = siteName;
    let description = settings.get('siteDes', 'Cloudreve');

    try {
      const info = await new ShareService(ctx, new FileSystemService(ctx)).info(share.id, {
        password: share.password || undefined,
        countViews: false,
      });
      if (info.name) title = info.name;
      const owner = info.owner?.nickname ?? '';
      if (info.source_type === 1) {
        description = 'Folder';
      } else if (info.unlocked && !info.expired) {
        description = formatSize(Number(info.size ?? 0));
        // 图片才值得配图；视频/文档要么没有缩略图、要么要走驱动原生能力
        try {
          const thumb = await new DownloadService(ctx, new FileSystemService(ctx)).thumb(
            URI.parse(`${shareUri}/${info.name}`),
          );
          if (thumb.url) image = absoluteUrl(siteUrl, thumb.url);
        } catch {
          /* 拿不到缩略图就用站点图标 */
        }
      } else if (info.expired) {
        description = 'Invalid Link';
      }
      if (owner) description = `${description} · ${owner}`;
    } catch {
      // 分享不存在 / 密码错误 / 已过期：与上游同样不区分原因
      description = 'Invalid Link';
    }

    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('Cache-Control', 'public, no-cache');
    return c.body(
      renderOgPage({
        siteName,
        title,
        description,
        image,
        shareUrl: `${siteUrl}/s/${share.id}${share.password ? `/${share.password}` : ''}`,
        redirectUrl: `${siteUrl}/home?path=${encodeURIComponent(shareUri)}`,
      }),
      200,
    );
  };
}
