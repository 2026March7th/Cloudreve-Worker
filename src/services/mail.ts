/**
 * 邮件服务。对应上游 `pkg/email`（`Driver` 接口 + 两个模板渲染器）。
 *
 * 配置来源：**数据库设置表**，也就是管理后台「邮件」设置页填的那几项。
 * 不走环境变量 —— 官方前端的面板里就是那几个 SMTP 字段，配置放进环境变量
 * 等于把面板变成摆设。协议本身由 `src/services/smtp.ts` 实现。
 *
 * 上游在没有可用驱动时返回 `email.ErrNoActiveDriver`，这里对应
 * `CodeFailedSendEmail` + "No available email provider"。
 */
import type { UserRow } from '../db/types';
import { AppContext } from './context';
import { logAudit } from './audit';
import {
  AppError,
  CodeFailedSendEmail,
  CodeInternalSetting,
  CodeParamErr,
} from '../lib/errors';
import { sendSmtpMail, SmtpError } from './smtp';

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

interface MailTemplateEntry {
  language: string;
  title: string;
  body: string;
}

/**
 * 全部邮件模板设置键。上游开源版只有激活 / 重置两个；「支付收据」与
 * 「存储配额超出」在原版是 Pro 闭源功能 —— 边缘版已实现对应业务
 * （支付体系 / 容量校验），所以这四个模板全部真实生效。
 */
export type MailTemplateKey =
  | 'mail_activation_template'
  | 'mail_reset_template'
  | 'mail_receipt_template'
  | 'mail_exceed_quota_template';

/**
 * 渲染模板里的 `{{ .A.B.C }}` 占位符。
 *
 * 只支持路径取值，**不支持** Go 模板的 `if` / `range` / 函数调用 —— 上游出厂模板
 * 里也没有用到。取不到的值渲染成空串（Go 会渲染成 `<no value>`，这里选择更干净
 * 的表现；两种都不会抛错，所以管理员把上游模板贴回来不会炸）。
 */
export function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*\.([A-Za-z0-9_.]+)\s*\}\}/g, (_match, path: string) => {
    let current: unknown = data;
    for (const segment of path.split('.')) {
      if (current === null || typeof current !== 'object') return '';
      current = (current as Record<string, unknown>)[segment];
    }
    if (current === undefined || current === null) return '';
    if (current instanceof Date) return current.toISOString();
    return String(current);
  });
}

/**
 * 选模板。对齐上游 `template.selectTemplate`：按用户语言大小写不敏感匹配，
 * 匹配不到就用第一项（所以第一项应当是英文）。
 */
function selectTemplate(templates: MailTemplateEntry[], language?: string | null): MailTemplateEntry | null {
  if (templates.length === 0) return null;
  if (language) {
    const matched = templates.find(
      (t) => t.language.toLowerCase() === language.toLowerCase(),
    );
    if (matched) return matched;
  }
  return templates[0]!;
}

function parseTemplates(raw: string): MailTemplateEntry[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is MailTemplateEntry =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as MailTemplateEntry).title === 'string' &&
        typeof (t as MailTemplateEntry).body === 'string',
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 发一封邮件所需的全部配置。字段名与官方前端面板的键名一致。 */
export interface MailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  forceEncryption: boolean;
  fromName: string;
  fromAddress: string;
  replyTo: string;
}

/** 上游把「真值」定义为一串特定字符串，这里保持同样宽松的判定。 */
export function isTrueValue(v: string | undefined | null): boolean {
  if (v === undefined || v === null) return false;
  const s = v.trim().toLowerCase();
  if (s === '') return false;
  return s !== '0' && s !== 'false' && s !== 'off' && s !== 'no';
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class MailService {
  constructor(private readonly ctx: AppContext) {}

  /** 当前站点是否配好了发件能力（只判断有没有填服务器地址）。 */
  get available(): boolean {
    return this.ctx.settings.smtp.host.trim() !== '';
  }

  /** 从设置表组装配置，`overrides` 用于后台「测试发信」——它要测的是**表单里当前的值**。 */
  private resolveConfig(overrides?: Partial<MailConfig>): MailConfig {
    const smtp = this.ctx.settings.smtp;
    const sender = this.ctx.settings.mailSender;
    return {
      host: smtp.host.trim(),
      port: smtp.port,
      user: smtp.user.trim(),
      pass: smtp.pass,
      forceEncryption: smtp.forceEncryption,
      fromName: sender.name.trim() || 'Cloudreve',
      fromAddress: sender.address.trim(),
      replyTo: sender.replyTo.trim(),
      ...overrides,
    };
  }

  /** 发一封 HTML 邮件。`overrides` 只给测试发信用。 */
  async send(
    to: string,
    title: string,
    body: string,
    overrides?: Partial<MailConfig>,
    /** 测试发信走 `CodeInternalSetting`（对齐上游 TestSMTPService），业务邮件走 40028 */
    errorCode: number = CodeFailedSendEmail,
  ): Promise<void> {
    const cfg = this.resolveConfig(overrides);

    if (!cfg.host) {
      // 对应上游 `email.ErrNoActiveDriver`
      throw new AppError(CodeFailedSendEmail, 'No available email provider');
    }
    if (!cfg.fromAddress) {
      throw new AppError(CodeInternalSetting, 'Sender address (fromAdress) is not configured');
    }

    try {
      await sendSmtpMail(
        {
          host: cfg.host,
          port: cfg.port,
          user: cfg.user || undefined,
          pass: cfg.pass,
          forceEncryption: cfg.forceEncryption,
        },
        {
          from: cfg.fromAddress,
          fromName: cfg.fromName,
          replyTo: cfg.replyTo || undefined,
          to,
          subject: title,
          html: body,
        },
      );
      logAudit(this.ctx, 'email_sent', this.ctx.user?.id ?? null, { to, title });
    } catch (e) {
      const detail = e instanceof SmtpError ? e.message : e instanceof Error ? e.message : String(e);
      throw new AppError(errorCode, detail, e instanceof Error ? e.name : undefined);
    }
  }

  /**
   * 模板里的公共变量。对应上游 `pkg/email/template.go` 的 `commonContext()`：
   * logo 若不是绝对地址，就用站点地址补全 —— 邮件客户端看不到相对路径。
   *
   * `User.Storage` 是用户已用容量（字节数），对应前端模板变量表里的
   * `{{ .User.Storage }}`。`extra` 用于业务专属变量（如 `Order.*`）。
   */
  private templateData(
    user: UserRow | null,
    url: string,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    const siteUrl = this.ctx.settings.siteUrl.replace(/\/+$/, '');
    const resolve = (path: string): string =>
      path && !/^https?:\/\//i.test(path) ? `${siteUrl}${path.startsWith('/') ? '' : '/'}${path}` : path;

    return {
      CommonContext: {
        SiteBasic: {
          Name: this.ctx.settings.siteName,
          Title: this.ctx.settings.siteTitle,
          ID: this.ctx.settings.siteId,
          Description: this.ctx.settings.get('siteDes', ''),
          Script: this.ctx.settings.siteScript,
        },
        Logo: {
          Normal: resolve(this.ctx.settings.get('site_logo', '')),
          Light: resolve(this.ctx.settings.get('site_logo_light', '')),
        },
        SiteUrl: siteUrl,
      },
      User: {
        ID: user?.id ?? 0,
        Email: user?.email ?? '',
        Nick: user?.nick ?? '',
        CreatedAt: user?.created_at ?? '',
        Storage: user?.storage ?? 0,
      },
      Url: url,
      ...extra,
    };
  }

  private render(
    settingKey: MailTemplateKey,
    user: UserRow,
    data: Record<string, unknown>,
    notConfigured: string,
  ): { title: string; body: string } {
    const templates = parseTemplates(this.ctx.settings.get(settingKey, ''));
    // 库里的列名是 `email_language`（JSON tag 与 Go 字段名 `Language` 不一致，
    // 见 `inventory/types/types.go:16`），别顺手写成 `language`。
    const selected = selectTemplate(templates, user.settings?.email_language);
    if (!selected) {
      throw new AppError(CodeInternalSetting, notConfigured);
    }

    return {
      title: renderTemplate(selected.title, data),
      body: renderTemplate(selected.body, data),
    };
  }

  /** 账号激活邮件。`url` 指向前端的 `/session/activate?id=&sign=`。 */
  async sendActivationEmail(user: UserRow, url: string): Promise<void> {
    const { title, body } = this.render(
      'mail_activation_template',
      user,
      this.templateData(user, url),
      'Activation email template not configured',
    );
    await this.send(user.email, title, body);
  }

  /** 密码重置邮件。`url` 指向前端的 `/session/reset?id=&secret=`。 */
  async sendResetEmail(user: UserRow, url: string): Promise<void> {
    const { title, body } = this.render(
      'mail_reset_template',
      user,
      this.templateData(user, url),
      'Reset email template not configured',
    );
    await this.send(user.email, title, body);
  }

  /**
   * 支付收据邮件（原版 Pro 的 `mail_receipt_template`，边缘版真实实现：
   * 订单履行成功后发送）。金额单位是分，模板里给的是保留两位小数的元。
   */
  async sendReceiptEmail(
    user: UserRow,
    order: {
      orderNo: string;
      productName: string;
      productType: string;
      amountFen: number;
      tradeNo: string | null;
      paidAt: Date | null;
    },
  ): Promise<void> {
    const data = this.templateData(user, '', {
      Order: {
        No: order.orderNo,
        ProductName: order.productName,
        ProductType: order.productType,
        Amount: (order.amountFen / 100).toFixed(2),
        TradeNo: order.tradeNo ?? '',
        PaidAt: order.paidAt ? order.paidAt.toISOString() : '',
      },
    });
    const { title, body } = this.render(
      'mail_receipt_template',
      user,
      data,
      'Receipt email template not configured',
    );
    await this.send(user.email, title, body);
  }

  /** 存储配额超出邮件（原版 Pro 的 `mail_exceed_quota_template`，边缘版真实实现：容量校验失败时发送，调用方负责限频）。 */
  async sendExceedQuotaEmail(user: UserRow): Promise<void> {
    const { title, body } = this.render(
      'mail_exceed_quota_template',
      user,
      this.templateData(user, ''),
      'Exceed quota email template not configured',
    );
    await this.send(user.email, title, body);
  }

  /**
   * 后台的「测试发信」。对应上游 `service/admin/tools.go:137 TestSMTPService.Test`：
   * 主题固定 `Cloudreve SMTP Test`，正文 `This is a test email from Cloudreve.`，
   * 失败用 `CodeInternalSetting`，端口非法用 `CodeParamErr`。
   *
   * `settings` 是后台表单里**尚未保存**的那份值（前端把整个表单一起提交，
   * 见 `Email.tsx` 的 `sendTestSMTP({ to, settings: values })`）。所以这里必须以
   * 传入值为准，否则测的是库里存的旧配置，等于没测 —— 上游也是这个语义。
   *
   * 不复用上面两个正文模板：目的是验证发信通道通不通，模板坏了不该让诊断也失败。
   */
  async sendTestEmail(to: string, settings: Record<string, string>): Promise<void> {
    const stored = this.resolveConfig();

    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new AppError(CodeParamErr, 'Invalid recipient address');
    }

    const rawPort = settings.smtpPort ?? String(stored.port);
    const port = Number.parseInt(rawPort, 10);
    if (!Number.isFinite(port)) {
      throw new AppError(CodeParamErr, 'Invalid SMTP port');
    }

    const cfg: Partial<MailConfig> = {
      host: (settings.smtpHost ?? stored.host).trim(),
      port,
      user: (settings.smtpUser ?? stored.user).trim(),
      pass: settings.smtpPass ?? stored.pass,
      forceEncryption: settings.smtpEncryption !== undefined
        ? isTrueValue(settings.smtpEncryption)
        : stored.forceEncryption,
      fromName: (settings.fromName ?? stored.fromName).trim() || 'Cloudreve',
      fromAddress: (settings.fromAdress ?? stored.fromAddress).trim(),
      replyTo: (settings.replyTo ?? stored.replyTo).trim(),
    };

    if (!cfg.host) {
      throw new AppError(CodeInternalSetting, 'SMTP host is not configured');
    }

    try {
      await this.send(
        to,
        'Cloudreve SMTP Test',
        'This is a test email from Cloudreve.',
        cfg,
        CodeInternalSetting,
      );
    } catch (e) {
      if (e instanceof AppError && e.code === CodeInternalSetting) {
        throw new AppError(CodeInternalSetting, `Failed to send test email: ${e.message}`);
      }
      throw e;
    }
  }
}
