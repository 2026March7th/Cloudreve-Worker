/**
 * Worker 环境绑定与运行时上下文类型。
 */

export interface Env {
  // --- 机密（wrangler secret put） ---
  /** Neon 连接串，形如 postgresql://user:pass@ep-xxx.aws.neon.tech/cloudreve?sslmode=require */
  DATABASE_URL: string;
  /**
   * JWT 签名密钥。留空时回退到数据库 settings 表里的 `secret_key`。
   * 生产环境建议显式设置，避免依赖数据库可读性。
   */
  JWT_SECRET?: string;

  // 邮件（SMTP）配置**不在环境变量里**。它在数据库的 settings 表里，由管理后台的
  // 「邮件」设置页维护 —— 键名是 smtpHost / smtpPort / smtpUser / smtpPass /
  // smtpEncryption / fromName / fromAdress / replyTo（见
  // `src/settings/provider.ts` 的 `smtp` getter），协议实现在 `src/services/smtp.ts`。
  // 之所以这样安排：官方前端的面板只有这组 SMTP 字段，配置若放环境变量，
  // 管理员在面板里改了什么都不会生效，面板就成了摆设。

  // --- 变量（wrangler.toml [vars]） ---
  /** 本站对外地址，用于拼分享链接 / 下载直链 */
  SITE_URL: string;
  /**
   * 官方前端的地址。两种用法二选一：
   *   - 配了 `[assets]`（推荐）：官方前端构建产物随 Worker 一起发布，此变量留空；
   *   - 没配 `[assets]`：填写官方前端的独立部署地址（如 Cloudflare Pages），
   *     非 /api 的请求会原样反代过去。
   */
  FRONTEND_URL?: string;
  LOG_LEVEL?: string;
  ENVIRONMENT?: string;
  /**
   * 允许跨域访问 API 的源，逗号分隔（如 `https://a.com,https://b.com`）。
   * 留空 = 关闭跨域，与原版配置项 AllowOrigins 为 UNSET 时的行为一致。
   * 前端与 Worker 同源部署时不需要配置。
   */
  CORS_ALLOW_ORIGINS?: string;
  /** 可选的 R2 公共域名，配置后 R2 直链不带签名 */
  R2_PUBLIC_BASE?: string;

  // --- 绑定 ---
  /** KV：会话吊销名单、上传会话状态、验证码、实体 URL 缓存、OneDrive token 缓存 */
  KV: KVNamespace;
  /** R2：内置对象存储后端 */
  R2: R2Bucket;
  /**
   * 官方前端的静态资源绑定。仅当 wrangler.toml 里配置了 `[assets]` 时存在，
   * 此时静态文件与 SPA 回落由平台的资源层直接处理，Worker 只在兜底路径上用它。
   */
  ASSETS?: Fetcher;
}
