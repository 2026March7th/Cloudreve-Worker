/**
 * WebDAV 账号密码的存储形态。
 *
 * ## 为什么要能「还原」密码
 *
 * 上游 Cloudreve 的 `dav_accounts.password` 存的是**明文**：列表接口直接把
 * `password` 返回给前端，设置页的「连接信息」弹窗就原样显示，用户照着抄进
 * MT管理器 / RaiDrive。所以密码必须是**可展示**的，只存哈希会让弹窗显示一串
 * sha256，用户抄过去必然 401 —— 这是本仓库 2026-10-26 排查到的真实故障之一。
 *
 * ## 为什么不直接照抄明文
 *
 * 明文入库意味着「拖一次库 = 拿到所有人的 WebDAV 凭据」。这里用
 * AES-GCM 加密后以 `enc:v1:<base64(iv|密文)>` 存放，密钥由站点的
 * `secret_key` 派生（Worker 机密，不跟数据库放在一起）。库单独泄露时这些
 * 密文解不开；接口返回时再解密给属主看。
 *
 * ## 兼容三种历史形态
 *
 * 认证侧接受三种 `password` 列值，谁的库都能直接用：
 *   1. `enc:v1:…` —— 本文件加密的（当前格式）
 *   2. 64 位纯 hex —— 早期自建版存的 sha256（只读展示会返回空，见下）
 *   3. 其它 —— 上游导入的明文
 */
import { sha256Hex, timingSafeEqual } from './crypto';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** 由站点密钥派生 AES-GCM key（每个 isolate 只派生一次）。 */
function keyOf(secretKey: string): Promise<CryptoKey> {
  const cached = keyCache.get(secretKey);
  if (cached) return cached;
  const p = (async () => {
    const material = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`cloudreve:dav-password:v1:${secretKey}`),
    );
    return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  })();
  keyCache.set(secretKey, p);
  return p;
}

/** 加密。密钥缺失（站点还没播种）时退化为明文 —— 功能优先，与上游一致。 */
export async function sealDavPassword(secretKey: string, plain: string): Promise<string> {
  if (!secretKey) return plain;
  try {
    const key = await keyOf(secretKey);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plain),
    );
    const packed = new Uint8Array(iv.length + ct.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(ct), iv.length);
    return PREFIX + toB64(packed);
  } catch {
    return plain;
  }
}

/**
 * 解密用于**展示**。解不开（密钥换了 / 早期哈希行 / 明文行）时返回 null，
 * 调用方展示空字符串 —— 不要把哈希或密文吐给用户。
 */
export async function revealDavPassword(secretKey: string, stored: string): Promise<string | null> {
  if (!stored) return null;
  if (!stored.startsWith(PREFIX)) {
    // 上游导入的明文：本来就该展示
    return /^[0-9a-f]{64}$/i.test(stored) ? null : stored;
  }
  try {
    const packed = fromB64(stored.slice(PREFIX.length));
    const iv = packed.slice(0, IV_BYTES);
    const ct = packed.slice(IV_BYTES);
    const key = await keyOf(secretKey);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** 恒时比较式的密码校验，兼容上述三种存储形态。 */
export async function verifyDavPassword(
  secretKey: string,
  stored: string,
  provided: string,
): Promise<boolean> {
  if (!stored) return false;
  if (stored.startsWith(PREFIX)) {
    const plain = await revealDavPassword(secretKey, stored);
    return plain !== null && timingSafeEqual(plain, provided);
  }
  if (/^[0-9a-f]{64}$/i.test(stored)) {
    return timingSafeEqual(stored.toLowerCase(), await sha256Hex(provided));
  }
  return timingSafeEqual(stored, provided);
}
