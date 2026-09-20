/**
 * 纯 JS 的 MD5（hex 输出）。
 *
 * 为什么自己实现：易支付（Epay）协议的签名是 MD5，而 Workers 的
 * WebCrypto（crypto.subtle）出于安全考虑不提供 MD5。实现为标准
 * RFC 1321 算法，输入按 UTF-8 编码——与 PHP 的 md5() 对 UTF-8
 * 字符串的行为一致（易支付服务端是 PHP）。
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
}

function toUtf8Bytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

/** 32 位循环左移。必须 >>>0 无符号化，否则 | 返回负 int32 污染后续加法。 */
function rotl(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

/** 计算字符串的 MD5，返回 32 位小写 hex。 */
export function md5(message: string): string {
  const bytes = toUtf8Bytes(message);
  const origLen = bytes.length;

  // 填充：追加 0x80，再补 0 到 len ≡ 56 (mod 64)，末尾 8 字节小端比特长度
  const paddedLen = (((origLen + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[origLen] = 0x80;
  // 注意：JS 移位位数按 mod 32 取模，24 >>> 32 === 24 >>> 0 === 24，
  // 所以 64 位长度的高 4 字节不能用 bitLen >>> (8*i) 写——用除法逐字节取。
  let bitLen = origLen * 8;
  for (let i = 0; i < 8; i++) {
    padded[paddedLen - 8 + i] = bitLen & 0xff;
    bitLen = Math.floor(bitLen / 256);
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const view = new DataView(padded.buffer);
  for (let chunk = 0; chunk < paddedLen; chunk += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      M[i] = view.getUint32(chunk + i * 4, true); // 小端
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, S[i]!)) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  // 输出小端 hex
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, a0, true);
  dv.setUint32(4, b0, true);
  dv.setUint32(8, c0, true);
  dv.setUint32(12, d0, true);
  return [...out].map((b) => b.toString(16).padStart(2, '0')).join('');
}
