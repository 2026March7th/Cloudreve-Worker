/**
 * SMTP 客户端。对应上游的 `pkg/email/smtp.go`（基于 go-mail 的连接池）。
 *
 * 为什么自己实现协议：官方前端的管理面板里，邮件设置页只有 SMTP 那组字段
 * （`smtpHost/smtpPort/smtpUser/smtpPass/smtpEncryption`，见
 * `frontend/src/component/Admin/Settings/Email/Email.tsx`）。要走 HTTP 发信 API
 * 就得加自定义字段，管理面板不认 —— 那就等于「用不了」。所以这里老老实实实现
 * SMTP，管理员在面板里填什么就用什么，不额外要求任何环境变量。
 *
 * Workers 侧的三条硬约束（已核对官方文档
 * https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ ）：
 *   1. **25 端口被禁**（`Connections to port 25 are prohibited`）。465 / 587 可用。
 *      上游默认端口是 25，所以这条必须给出人话提示，否则管理员会以为是自己填错了。
 *   2. 隐式 TLS（465）用 `secureTransport: "on"`；STARTTLS（587 等）用
 *      `secureTransport: "starttls"` + `socket.startTls()`。
 *   3. 不能连 Cloudflare 自家 IP 段、localhost、私网地址。
 *
 * 只实现发信必需的那部分协议：EHLO / STARTTLS / AUTH / MAIL / RCPT / DATA / QUIT。
 * 不做连接池 —— Workers 里 isolate 随时回收，上游那套 keepalive 在这里没有意义。
 */
import { connect } from 'cloudflare:sockets';

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  /** 上游的 `smtpEncryption`：为真时要求 TLS 必须成功（否则报错） */
  forceEncryption?: boolean;
  timeoutMs?: number;
}

export interface SmtpMessage {
  from: string;
  fromName?: string;
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
}

/** 单步等待上限。整个会话另有总超时兜底。 */
const DEFAULT_STEP_TIMEOUT = 10_000;
const DEFAULT_TOTAL_TIMEOUT = 25_000;

class SmtpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly response?: string,
  ) {
    super(message);
    this.name = 'SmtpError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SmtpError(`SMTP 超时：等待 ${what} 超过 ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 一个 SMTP 连接。负责按行读写与响应码解析。 */
class SmtpConnection {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = new Uint8Array(0);
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(
    // `Socket` / `SocketOptions` 是 workers-types 的全局类型，
    // `cloudflare:sockets` 模块只导出 `connect`，别写成 import。
    private socket: Socket,
    private readonly timeoutMs: number,
  ) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  /** 升级到 TLS。文档明确：升级后必须重新取 reader / writer。 */
  upgrade(): void {
    this.socket = this.socket.startTls();
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.buffer = new Uint8Array(0);
  }

  private findCrlf(): number {
    const buf = this.buffer;
    for (let i = 0; i + 1 < buf.length; i++) {
      if (buf[i] === 13 && buf[i + 1] === 10) return i;
    }
    return -1;
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const idx = this.findCrlf();
      if (idx >= 0) {
        const line = this.decoder.decode(this.buffer.subarray(0, idx));
        this.buffer = this.buffer.subarray(idx + 2);
        return line;
      }
      const chunk = await withTimeout(this.reader.read(), this.timeoutMs, '服务器响应');
      if (chunk.done) {
        throw new SmtpError('SMTP 连接被服务器意外关闭');
      }
      const merged = new Uint8Array(this.buffer.length + chunk.value.length);
      merged.set(this.buffer, 0);
      merged.set(chunk.value, this.buffer.length);
      this.buffer = merged;
    }
  }

  /**
   * 读一个完整响应。多行响应的续行是 `250-xxx`，末行是 `250 xxx`
   * （RFC 5321 §4.2.1），所以看到第 4 个字符不是 `-` 就收尾。
   */
  async readResponse(): Promise<{ code: number; lines: string[]; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      if (line.length >= 4 && line[3] === '-') continue;
      const code = Number.parseInt(line.slice(0, 3), 10);
      return { code: Number.isFinite(code) ? code : -1, lines, text: lines.join('\n') };
    }
  }

  async writeRaw(text: string): Promise<void> {
    await withTimeout(this.writer.write(this.encoder.encode(text)), this.timeoutMs, '发送数据');
  }

/** 发一条命令并读响应，不校验返回码。 */
  async commandRaw(line: string): Promise<{ code: number; lines: string[]; text: string }> {
    await this.writeRaw(line + '\r\n');
    return this.readResponse();
  }

  /** 发一条命令并读响应，返回码不在 `expect` 里就抛错。 */
  async command(line: string, expect: number[]): Promise<{ code: number; lines: string[]; text: string }> {
    const resp = await this.commandRaw(line);
    if (!expect.includes(resp.code)) {
      throw new SmtpError(`SMTP 命令被拒绝：${line.split(' ')[0]} → ${resp.code}`, resp.code, resp.text);
    }
    return resp;
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      /* 连接可能已断，忽略 */
    }
    try {
      await this.writer.close();
    } catch {
      /* 同上 */
    }
    try {
      await this.socket.close();
    } catch {
      /* 同上 */
    }
  }
}

// ---------------------------------------------------------------------------
// MIME 编码
// ---------------------------------------------------------------------------

function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  const CHUNK = 0x8000; // 分块，避免 apply 参数过多导致栈溢出
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 按 RFC 2045 每 76 字符折行。 */
function wrapBase64(b64: string): string {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join('\r\n');
}

/**
 * 非 ASCII 头编码（RFC 2047）。长内容按每段 30 字节切分 —— base64 后 40 字符，
 * 加上 `=?UTF-8?B?` 与 `?=` 仍在 75 字符的安全线内，且按 UTF-8 字符边界切，
 * 不会截断多字节字符。
 */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let seg = '';
  let segBytes = 0;
  // 按码点迭代，天然不会把一个多字节字符切两半
  for (const ch of value) {
    const n = encoder.encode(ch).length;
    if (segBytes + n > 30 && seg.length > 0) {
      parts.push(`=?UTF-8?B?${utf8ToBase64(seg)}?=`);
      seg = '';
      segBytes = 0;
    }
    seg += ch;
    segBytes += n;
  }
  if (seg) parts.push(`=?UTF-8?B?${utf8ToBase64(seg)}?=`);
  return parts.join('\r\n ');
}

/** 显示名 + 地址。显示名含非 ASCII 时同样要做 RFC 2047 编码。 */
function formatAddress(name: string | undefined, address: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return `<${address}>`;
  const encoded = /^[\x20-\x7e]*$/.test(trimmed)
    ? `"${trimmed.replace(/([\\"])/g, '\\$1')}"`
    : encodeHeader(trimmed);
  return `${encoded} <${address}>`;
}

function buildMime(msg: SmtpMessage, ehloName: string): string {
  const domain = ehloName || 'localhost';
  const headers = [
    `From: ${formatAddress(msg.fromName, msg.from)}`,
    `To: <${msg.to}>`,
    ...(msg.replyTo ? [`Reply-To: <${msg.replyTo}>`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = wrapBase64(utf8ToBase64(msg.html));
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

// ---------------------------------------------------------------------------
// 发信
// ---------------------------------------------------------------------------

/**
 * 走 SMTP 发一封 HTML 邮件。失败一律抛 `SmtpError`，由调用方翻译成业务错误码。
 */
export async function sendSmtpMail(config: SmtpConfig, msg: SmtpMessage): Promise<void> {
  const stepTimeout = config.timeoutMs ?? DEFAULT_STEP_TIMEOUT;

  if (!config.host) throw new SmtpError('SMTP 服务器地址为空');
  if (config.port === 25) {
    // 这条要说清楚是谁的问题，否则管理员只会反复检查自己的配置
    throw new SmtpError(
      'Cloudflare Workers 禁止连接 25 端口（反滥用策略）。请把 SMTP 端口改成 465（SSL）或 587（STARTTLS）。',
    );
  }
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new SmtpError(`SMTP 端口不合法：${config.port}`);
  }

  // 465 是隐式 TLS（连上就是 TLS）；其余端口按 STARTTLS 机会性升级
  const implicitTls = config.port === 465;
  const secureTransport = implicitTls ? 'on' : 'starttls';

  const hostDomain = msg.from.split('@')[1]?.trim() || 'localhost';
  const ehloName = hostDomain.replace(/[^A-Za-z0-9.\-]/g, '') || 'localhost';

  const socket = connect(
    { hostname: config.host, port: config.port },
    // allowHalfOpen 在 SocketOptions 里是必填项（workers-types），不能省
    { secureTransport, allowHalfOpen: false },
  );
  const conn = new SmtpConnection(socket, stepTimeout);

  const run = async (): Promise<void> => {
    // 连接阶段单独等一次，端口被封 / 域名解析失败会在这里暴露
    try {
      await withTimeout(socket.opened, stepTimeout, '建立 TCP 连接');
    } catch (e) {
      throw new SmtpError(
        `无法连接 ${config.host}:${config.port} —— ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const greeting = await conn.readResponse();
    if (greeting.code !== 220) {
      throw new SmtpError(`服务器未就绪：${greeting.text}`, greeting.code, greeting.text);
    }

    let ehlo = await conn.command(`EHLO ${ehloName}`, [250]);

    if (!implicitTls) {
      // 非 465 端口走 STARTTLS。上游用 `smtpEncryption` 区分两种语义：
      //   1 → 必须加密（TLSMandatory），升级不了就报错
      //   0 → 机会性加密（TLSOpportunistic），服务器不支持就继续明文
      const startTls = await conn.commandRaw('STARTTLS');
      if (startTls.code === 220) {
        try {
          conn.upgrade();
        } catch (e) {
          throw new SmtpError(`TLS 升级失败：${e instanceof Error ? e.message : String(e)}`);
        }
        // 升级后必须重新 EHLO —— 此时拿到的才是加密通道上的能力列表
        ehlo = await conn.command(`EHLO ${ehloName}`, [250]);
      } else if (config.forceEncryption) {
        throw new SmtpError(
          `服务器不支持 STARTTLS（返回 ${startTls.code}），而设置里要求强制加密`,
          startTls.code,
          startTls.text,
        );
      }
    }

    // 认证
    if (config.user) {
      const authLine = ehlo.lines.find((l) => /AUTH\s/i.test(l)) ?? '';
      const mechs = authLine.toUpperCase();
      const user = config.user;
      const pass = config.pass ?? '';

      if (mechs.includes('PLAIN')) {
        // RFC 4616：base64(\0user\0pass)
        await conn.command(`AUTH PLAIN ${utf8ToBase64(`\u0000${user}\u0000${pass}`)}`, [235]);
      } else if (mechs.includes('LOGIN') || mechs === '') {
        const r1 = await conn.command('AUTH LOGIN', [334]);
        void r1;
        await conn.command(utf8ToBase64(user), [334]);
        await conn.command(utf8ToBase64(pass), [235]);
      } else {
        throw new SmtpError(`服务器不支持可用的认证方式（${authLine.trim() || '未公告 AUTH'}）`);
      }
    }

    // 信封
    await conn.command(`MAIL FROM:<${msg.from}>`, [250]);
    await conn.command(`RCPT TO:<${msg.to}>`, [250, 251]);
    await conn.command('DATA', [354]);

    // 正文。base64 字符集里不含行首的点，但仍按 RFC 5321 §4.5.2 做点填充，
    // 免得将来改成 8bit/7bit 编码时踩坑。
    const mime = buildMime(msg, ehloName).replace(/^\./gm, '..');
    await conn.writeRaw(mime + '\r\n.\r\n');

    const accepted = await conn.readResponse();
    if (accepted.code !== 250) {
      throw new SmtpError(`服务器拒收：${accepted.text}`, accepted.code, accepted.text);
    }

    // 优雅收尾；失败不影响「已投递」这个事实
    try {
      await conn.command('QUIT', [221]);
    } catch {
      /* ignore */
    }
  };

  try {
    await withTimeout(run(), DEFAULT_TOTAL_TIMEOUT, '完成整封邮件投递');
  } finally {
    await conn.close();
  }
}

/** 便于上层区分「配置错」和「网络错」时的措辞。 */
export { SmtpError };
