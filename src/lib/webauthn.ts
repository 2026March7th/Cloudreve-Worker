/**
 * WebAuthn 服务端核心实现（零依赖，纯 WebCrypto）。
 *
 * 对齐上游 `github.com/go-webauthn/webauthn` 的行为面：
 *   - attestation：解析 CBOR attestationObject，校验 rpIdHash / UP 标志；
     attStmt 签名（证明真实器型号）**不验**——它证明的是 authenticator 的型号，
     不是用户身份，对私有云没有安全增益，格式各厂商五花八门不值得全部实现；
 *   - assertion：完整校验 rpIdHash / UP / 计数器 / ES256・RS256・Ed25519 签名；
 *   - clientData：校验 type / challenge / origin。
 *
 * 二进制编码：URL-safe base64 无填充（go-webauthn 的 RawURLEncoding，前端
 * `urlBase64BufferDecode` 也按这个解析）。
 */

export const FLAG_UP = 0x01; // user present
export const FLAG_UV = 0x04; // user verified
export const FLAG_AT = 0x40; // attested credential data present
export const FLAG_ED = 0x80; // extension data present

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

/** URL-safe base64 无填充编码。 */
export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** URL-safe base64 解码。兼容带填充 / 标准字母表，宽松处理。 */
export function b64urlDecode(input: string): Uint8Array {
  let s = input.replaceAll('-', '+').replaceAll('_', '/');
  const pad = s.length % 4;
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';
  else if (pad === 1) throw new Error('invalid base64url length');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// CBOR（RFC 8949）最小解码器
// ---------------------------------------------------------------------------

export interface CborItem {
  value: unknown;
  /** 该项占用的字节数（从 offset 起）。解析 authData 里的 COSE 公钥时靠它定位结尾。 */
  bytesRead: number;
}

function readHead(buf: Uint8Array, offset: number): { mt: number; arg: number; bytesRead: number } {
  const ib = buf[offset];
  if (ib === undefined) throw new Error('CBOR: unexpected end');
  const mt = ib >> 5;
  const short = ib & 0x1f;
  if (short < 24) return { mt, arg: short, bytesRead: 1 };
  const extraBytes = short === 24 ? 1 : short === 25 ? 2 : short === 26 ? 4 : short === 27 ? 8 : -1;
  if (extraBytes < 0) throw new Error(`CBOR: unsupported additional info ${short}`);
  if (offset + 1 + extraBytes > buf.length) throw new Error('CBOR: truncated head');
  let arg = 0;
  for (let i = 0; i < extraBytes; i += 1) arg = arg * 256 + buf[offset + 1 + i];
  // JS number 精度内足够（凭据长度 / 计数器远用不到 2^53）
  return { mt, arg, bytesRead: 1 + extraBytes };
}

/**
 * 解码单个 CBOR 项。支持：整数、字节串、文本串、数组、map、tag（解到内层）、
 * true/false/null。不支持浮点与无限长（WebAuthn 报文里不会出现）。
 */
export function cborDecode(buf: Uint8Array, offset = 0): CborItem {
  const head = readHead(buf, offset);
  const start = offset;

  switch (head.mt) {
    case 0: // unsigned int
      return { value: head.arg, bytesRead: head.bytesRead };
    case 1: // negative int
      return { value: -1 - head.arg, bytesRead: head.bytesRead };
    case 2: { // byte string
      const end = start + head.bytesRead + head.arg;
      if (end > buf.length) throw new Error('CBOR: truncated byte string');
      return { value: buf.slice(start + head.bytesRead, end), bytesRead: end - start };
    }
    case 3: { // text string
      const end = start + head.bytesRead + head.arg;
      if (end > buf.length) throw new Error('CBOR: truncated text string');
      return { value: new TextDecoder().decode(buf.slice(start + head.bytesRead, end)), bytesRead: end - start };
    }
    case 4: { // array
      const arr: unknown[] = [];
      let pos = start + head.bytesRead;
      for (let i = 0; i < head.arg; i += 1) {
        const item = cborDecode(buf, pos);
        arr.push(item.value);
        pos += item.bytesRead;
      }
      return { value: arr, bytesRead: pos - start };
    }
    case 5: { // map
      const map = new Map<unknown, unknown>();
      let pos = start + head.bytesRead;
      for (let i = 0; i < head.arg; i += 1) {
        const k = cborDecode(buf, pos);
        pos += k.bytesRead;
        const v = cborDecode(buf, pos);
        pos += v.bytesRead;
        map.set(k.value, v.value);
      }
      return { value: map, bytesRead: pos - start };
    }
    case 6: { // tag → 解到内层值
      const inner = cborDecode(buf, start + head.bytesRead);
      return { value: inner.value, bytesRead: head.bytesRead + inner.bytesRead };
    }
    case 7: { // simple values
      if (head.bytesRead === 1) {
        if (head.arg === 20) return { value: false, bytesRead: 1 };
        if (head.arg === 21) return { value: true, bytesRead: 1 };
        if (head.arg === 22 || head.arg === 23) return { value: null, bytesRead: 1 };
      }
      throw new Error(`CBOR: unsupported simple value ${head.arg}`);
    }
    default:
      throw new Error(`CBOR: unsupported major type ${head.mt}`);
  }
}

// ---------------------------------------------------------------------------
// authenticatorData / attestationObject / clientDataJSON
// ---------------------------------------------------------------------------

export interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  /** 仅注册（AT 置位）时存在。 */
  aaguid?: Uint8Array;
  credentialId?: Uint8Array;
  /** COSE 公钥原始字节（注册时存在）。 */
  cosePublicKey?: Uint8Array;
}

/** 解析 authenticatorData（固定头 37 字节 + 可选 attested credential data + 扩展）。 */
export function parseAuthData(data: Uint8Array): AuthData {
  if (data.length < 37) throw new Error('authenticatorData too short');
  const rpIdHash = data.slice(0, 32);
  const flags = data[32];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const signCount = dv.getUint32(33);

  const out: AuthData = { rpIdHash, flags, signCount };
  let pos = 37;

  if ((flags & FLAG_AT) !== 0) {
    if (pos + 18 > data.length) throw new Error('authenticatorData: truncated credential data');
    out.aaguid = data.slice(pos, pos + 16);
    const credLen = dv.getUint16(pos + 16);
    pos += 18;
    if (pos + credLen > data.length) throw new Error('authenticatorData: truncated credential id');
    out.credentialId = data.slice(pos, pos + credLen);
    pos += credLen;
    const key = cborDecode(data, pos);
    out.cosePublicKey = data.slice(pos, pos + key.bytesRead);
    pos += key.bytesRead;
  }

  // ED 置位时跳过扩展（CBOR map），登录校验用不到
  if ((flags & FLAG_ED) !== 0 && pos < data.length) {
    const ext = cborDecode(data, pos);
    pos += ext.bytesRead;
  }

  return out;
}

/** 解析 attestationObject 顶层 CBOR map，取 fmt 与 authData。 */
export function parseAttestationObject(obj: Uint8Array): { fmt: string; authData: Uint8Array } {
  const decoded = cborDecode(obj);
  if (!(decoded.value instanceof Map)) throw new Error('attestationObject is not a CBOR map');
  const fmt = decoded.value.get('fmt');
  const authData = decoded.value.get('authData');
  if (typeof fmt !== 'string' || !(authData instanceof Uint8Array)) {
    throw new Error('attestationObject: missing fmt/authData');
  }
  return { fmt, authData };
}

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

export function parseClientData(json: Uint8Array): ClientData {
  const parsed = JSON.parse(new TextDecoder().decode(json)) as Partial<ClientData>;
  if (!parsed.type || !parsed.challenge || !parsed.origin) {
    throw new Error('clientDataJSON: missing type/challenge/origin');
  }
  return parsed as ClientData;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(digest);
}

/** challenge 比对：b64url 解码后按字节比较（避免编码差异误判）。 */
export function challengeMatches(expected: string, actual: string): boolean {
  const a = b64urlDecode(expected);
  const b = b64urlDecode(actual);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 从 COSE 公钥验证签名。支持 ES256（-7，绝大多数 authenticator）、
 * RS256（-257，Windows Hello）、Ed25519（-8）。
 * 返回 false 表示验签失败；抛错表示公钥格式不支持。
 */
export async function coseVerify(
  cose: Uint8Array,
  signedData: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const decoded = cborDecode(cose);
  if (!(decoded.value instanceof Map)) throw new Error('COSE key is not a map');
  const kty = decoded.value.get(1);
  const alg = decoded.value.get(3);
  const toB64url = (v: unknown): string => {
    if (!(v instanceof Uint8Array)) throw new Error('COSE key: missing coordinate');
    return b64urlEncode(v);
  };

  if (kty === 2 && alg === -7) {
    // EC2 / P-256
    const jwk: JsonWebKey = {
      kty: 'EC',
      crv: 'P-256',
      x: toB64url(decoded.value.get(-2)),
      y: toB64url(decoded.value.get(-3)),
    };
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify',
    ]);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature as BufferSource, signedData as BufferSource);
  }

  if (kty === 3 && alg === -257) {
    // RSA / RS256
    const jwk: JsonWebKey = { kty: 'RSA', n: toB64url(decoded.value.get(-1)), e: toB64url(decoded.value.get(-2)) };
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
      'verify',
    ]);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature as BufferSource, signedData as BufferSource);
  }

  if (kty === 1 && alg === -8) {
    // OKP / Ed25519（Workers WebCrypto 已支持）
    const jwk: JsonWebKey = { kty: 'OKP', crv: 'Ed25519', x: toB64url(decoded.value.get(-2)) };
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'Ed25519' }, key, signature as BufferSource, signedData as BufferSource);
  }

  throw new Error(`COSE key: unsupported kty=${kty} alg=${alg}`);
}

/** 注册/登录共用的 clientData 校验。origin 为完整站点 origin（含协议）。 */
export async function verifyClientData(
  clientDataJSON: Uint8Array,
  expectedType: 'webauthn.create' | 'webauthn.get',
  expectedChallenge: string,
  allowedOrigins: string[],
): Promise<ClientData> {
  const cd = parseClientData(clientDataJSON);
  if (cd.type !== expectedType) {
    throw new Error(`clientData: expected type ${expectedType}, got ${cd.type}`);
  }
  if (!challengeMatches(expectedChallenge, cd.challenge)) {
    throw new Error('clientData: challenge mismatch');
  }
  if (!allowedOrigins.includes(cd.origin)) {
    throw new Error(`clientData: origin not allowed: ${cd.origin}`);
  }
  return cd;
}

export { sha256 };
