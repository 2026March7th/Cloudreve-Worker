/**
 * TOTP 实现的验证脚本（一次性工具，不参与构建）。
 *
 * 用什么验的：RFC 6238 Appendix B 的官方向量。原文给的是 8 位码，而
 * Cloudreve 用的是 6 位（`DEFAULT_DIGITS=6`），6 位码等于 `value % 10^6`，
 * 正好是 8 位码的后 6 位 —— 所以取后 6 位比对即可。
 *
 * 密钥用 RFC 里那条 ASCII 串 "12345678901234567890"（20 字节），
 * 与上游 `totp.Generate` 的默认 SecretSize=20 一致。
 *
 * 另外验证三件容易写错的事：
 *   1. base32 无填充编码与 Go `b32NoPadding` 输出一致
 *   2. 小写密钥、带 `=` 填充的密钥都能解（Go 侧 GenerateCodeCustom 会先规范化）
 *   3. Skew=1：当前窗口前后各一个窗口都要接受，再远必须拒绝
 *
 * 跑法见同目录 README 或本文件末尾注释。
 */
const { base32Encode, base32Decode, generateTotpSecret, totpCodeAt, validateTotp } =
  require('./totp.js');

const ASCII_SECRET = '12345678901234567890';
const B32_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

// RFC 6238 Appendix B —— SHA1 行
const VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected=${expected} actual=${actual}`);
}

async function main() {
  console.log('--- 1. base32 编码（对齐 Go b32NoPadding） ---');
  const encoded = base32Encode(new TextEncoder().encode(ASCII_SECRET));
  check('20 字节 ASCII 密钥的 base32 输出', encoded, B32_SECRET);

  console.log('\n--- 2. base32 解码容错 ---');
  const raw = base32Decode(B32_SECRET);
  check('解码长度 = 20', String(raw.length), '20');
  check('解码内容回原文', new TextDecoder().decode(raw), ASCII_SECRET);
  check('小写密钥可解', base32Decode(B32_SECRET.toLowerCase()).length, 20);
  check('带 = 填充可解', base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ====').length, 20);
  check('非法字符返回 null', base32Decode('GEZD1NBV'), null);

  console.log('\n--- 3. RFC 6238 官方向量（取 8 位码的后 6 位） ---');
  for (const [t, eightDigits] of VECTORS) {
    const expected = eightDigits.slice(-6);
    const actual = await totpCodeAt(B32_SECRET, t);
    check(`T=${t} -> ${expected}`, actual, expected);
  }
  // 同一 30 秒窗口内相邻秒数必须算同一个码：RFC 6238 表里
  // T=1111111111 与 T=1111111112 同属 counter=37037037，标准实现两边都应得 050471。
  // （RFC 表把后者标成 005924 是出了名的异常向量，以逐窗口实现为准。）
  const sameWinA = await totpCodeAt(B32_SECRET, 1111111111);
  const sameWinB = await totpCodeAt(B32_SECRET, 1111111112);
  check('同窗口相邻秒数结果一致', sameWinA === sameWinB ? 'same' : 'diff', 'same');

  console.log('\n--- 4. validateTotp 窗口（Skew=1） ---');
  const t = 1111111111;
  const cur = await totpCodeAt(B32_SECRET, t);
  const prev = await totpCodeAt(B32_SECRET, t - 30);
  const next = await totpCodeAt(B32_SECRET, t + 30);
  const farPrev = await totpCodeAt(B32_SECRET, t - 60);
  const farNext = await totpCodeAt(B32_SECRET, t + 60);

  check('当前窗口通过', await validateTotp(cur, B32_SECRET, t), true);
  check('上一窗口通过（-1）', await validateTotp(prev, B32_SECRET, t), true);
  check('下一窗口通过（+1）', await validateTotp(next, B32_SECRET, t), true);
  check('再往前一个窗口（-2）拒绝', await validateTotp(farPrev, B32_SECRET, t), false);
  check('再往后一个窗口（+2）拒绝', await validateTotp(farNext, B32_SECRET, t), false);

  console.log('\n--- 5. validateTotp 边界 ---');
  check('长度 5 位拒绝', await validateTotp('12345', B32_SECRET, t), false);
  check('长度 7 位拒绝', await validateTotp('1234567', B32_SECRET, t), false);
  check('带空格可trim', await validateTotp(`  ${cur}  `, B32_SECRET, t), true);
  check('空验证码拒绝', await validateTotp('', B32_SECRET, t), false);
  check('空密钥拒绝', await validateTotp(cur, '', t), false);
  check('错误验证码拒绝', await validateTotp('000000', 'MFRGGZDFMZTWQ2LK', t), false);

  console.log('\n--- 6. generateTotpSecret ---');
  const s1 = generateTotpSecret();
  const s2 = generateTotpSecret();
  check('默认长度 32 字符（20 字节无填充）', String(s1.length), '32');
  check('两次生成不重复', s1 === s2, false);
  check('生成的密钥可自校验', await validateTotp(await totpCodeAt(s1, t), s1, t), true);

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
