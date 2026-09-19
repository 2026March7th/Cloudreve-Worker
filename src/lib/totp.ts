/**
 * TOTP（RFC 6238）—— 与上游用的 `github.com/pquerna/otp v1.2.0` 逐行对齐。
 *
 * 为什么不能「差不多就行」：TOTP 的校验窗口、位数、base32 处理只要有一处不同，
 * 就会出现「官方后端能登、边缘版登不了」的偏差，而且只在部分时间点复现。
 * 下面每个常量的出处都写在注释里。
 *
 * 上游调用点：
 *   - `service/user/setting.go:34 Init2FA` —— totp.Generate(Issuer="Cloudreve",
 *     AccountName=email) 生成密钥，存 KV `2fa_init_{uid}`，TTL 600
 *   - `service/user/setting.go:310/319` —— totp.Validate 校验启用 / 关闭时的验证码
 *   - `service/user/login.go:236` —— 登录 2FA 用 totp.Validate 校验
 *
 * `totp.Validate`（totp/totp.go:33-46）的参数是写死的：
 *   Period=30  Skew=1  Digits=Six  Algorithm=SHA1
 *
 * `ValidateCustom`（totp/totp.go:105-131）按以下顺序试算：
 *   counters = [floor(unix/30), +1, -1]
 * 也就是「当前 / 下一个 / 上一个」三个 30 秒窗口。±1 是给客户端时钟偏差留的余量。
 *
 * `hotp.GenerateCodeCustom`（hotp/hotp.go:71-90）对密钥的处理顺序很关键，照抄：
 *   1. TrimSpace
 *   2. 补 `=` 到 8 的整数倍（兼容不加填充的密钥，issue #10/#17）
 *   3. 转大写（Google Authenticator 会产出小写，issue #24）
 *   4. base32 StdEncoding 解码
 * 校验时 `hotp.ValidateCustom`（hotp/hotp.go:110-127）先 TrimSpace 验证码，
 * 再断言长度恰好等于 6，最后做**常数时间**比较。
 *
 * 密钥本身由 `totp.Generate` 生成：默认 20 字节随机数，用 base32
 * **无填充**编码（totp/totp.go:138 `b32NoPadding`），这就是 `Key.Secret()` 的返回值 ——
 * 也就是 `GET /user/setting/2fa` 回给前端、前端直接拼进 otpauth:// 的那串东西。
 */

/** RFC 4648 base32 字母表。 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 上游 `totp.Generate` 的默认密钥长度（字节）。 */
const DEFAULT_SECRET_SIZE = 20;

/** 上游 `totp.Validate` 写死的窗口大小（秒）。 */
const PERIOD_SECONDS = 30;

/** 上游 `totp.Validate` 写死的允许偏差片数。 */
const SKEW = 1;

/** 上游 `totp.Validate` 写死的位数。 */
const DIGITS = 6;

/**
 * base32 编码（无填充）。
 *
 * 对应 Go 的 `base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString`
 * （totp/totp.go:138）。
 */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * base32 解码。非字母表字符（含 `=` 填充）直接跳过，与 Go 的
 * `StdEncoding.DecodeString` 配合上面那步「补到 8 的倍数」等价。
 *
 * 解码失败返回 null —— 对应 Go 侧 `ErrValidateSecretInvalidBase32`。
 */
export function base32Decode(input: string): Uint8Array<ArrayBuffer> | null {
  const cleaned = input.trim().toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const ch of cleaned) {
    if (ch === '=') continue;
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index === -1) return null;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return new Uint8Array(bytes);
}

/**
 * 生成新的 TOTP 密钥（base32 无填充字符串）。
 *
 * 对应上游 `service/user/setting.go:38` 的 `totp.Generate(...)`，只需要
 * `Key.Secret()` —— 也就是 query 里的那个 secret 参数。
 */
export function generateTotpSecret(secretSize: number = DEFAULT_SECRET_SIZE): string {
  const bytes = new Uint8Array(secretSize);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

/**
 * 按给定时间点算出一个 6 位验证码。
 *
 * 对应 `hotp.GenerateCodeCustom` + `totp.GenerateCodeCustom` 的组合。
 * 单独导出是为了测试能在固定时间点上比对已知向量，而不是靠「等 30 秒再试」。
 */
export async function totpCodeAt(secret: string, unixSeconds: number): Promise<string | null> {
  const secretBytes = base32Decode(secret);
  if (!secretBytes) return null;
  return hotpCode(secretBytes, Math.floor(unixSeconds / PERIOD_SECONDS));
}

/** HOTP 主体：给定密钥字节与计数器，算出 6 位码。 */
async function hotpCode(secretBytes: Uint8Array<ArrayBuffer>, counter: number): Promise<string> {
  const buf = new Uint8Array(8);
  // counter 是 64 位无符号数；TOTP 场景下远小于 2^53，用 JS number 逐字节拆没问题
  let remaining = counter;
  for (let i = 7; i >= 0; i -= 1) {
    buf[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sum = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));

  // RFC 4226 的动态截断
  const offset = sum[sum.length - 1] & 0x0f;
  const value =
    ((sum[offset] & 0x7f) << 24) |
    ((sum[offset + 1] & 0xff) << 16) |
    ((sum[offset + 2] & 0xff) << 8) |
    (sum[offset + 3] & 0xff);

  return String(value % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * 校验 TOTP 验证码。等价于上游的 `totp.Validate(passcode, secret)`。
 *
 * 返回 false 的情况与 Go 侧一致：验证码长度不是 6 位、密钥无法解码、
 * 三个窗口都对不上。Go 侧把前两种当 err 抛出，调用方（`setting.go` /
 * `login.go`）不区分 err 与 false，一律回「验证码不正确」，所以这里压成布尔值。
 */
export async function validateTotp(
  passcode: string,
  secret: string,
  unixSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const trimmed = passcode.trim();
  // hotp.ValidateCustom 的第一道门：长度必须正好等于位数
  if (trimmed.length !== DIGITS) return false;
  if (!secret) return false;

  const counter = Math.floor(unixSeconds / PERIOD_SECONDS);
  const secretBytes = base32Decode(secret);
  if (!secretBytes) return false;

  // totp.ValidateCustom 的试探顺序：[当前, 当前+1, 当前-1]
  const candidates = [counter];
  for (let i = 1; i <= SKEW; i += 1) {
    candidates.push(counter + i, counter - i);
  }

  for (const c of candidates) {
    const expected = await hotpCode(secretBytes, c);
    if (constantTimeEquals(expected, trimmed)) return true;
  }
  return false;
}

/**
 * 常数时间字符串比较，对应 Go 的 `subtle.ConstantTimeCompare`。
 *
 * 时序攻击在这个场景里威胁有限（验证码 6 位、30 秒就换、还有尝试次数限制），
 * 但既然是对齐实现，就没必要顺手留一个明摆着的差异。
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
