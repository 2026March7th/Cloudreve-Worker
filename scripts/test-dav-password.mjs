/**
 * WebDAV 密码存储形态的单元测试（`src/lib/davPassword.ts`）。
 *
 * 跑法：`npm run test:dav-password`（也包含在 `npm run test:security` 里）
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'node_modules', '.cache', 'davpasswordtest');
mkdirSync(outDir, { recursive: true });

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`);
  }
}

const SECRET = 'site-secret-key-for-tests';

try {
  const bundlePath = path.join(outDir, 'davPassword.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/davPassword.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const { sealDavPassword, revealDavPassword, verifyDavPassword } = await import(
    `file://${bundlePath}`
  );

  console.log('\n[1] 加密后能还原（含非 ASCII）');
  for (const plain of ['aBcD1234', 'pässwörd-密码', 'x'.repeat(32)]) {
    const sealed = await sealDavPassword(SECRET, plain);
    check(`落库不是明文：${plain.slice(0, 6)}…`, !sealed.includes(plain) && sealed.startsWith('enc:v1:'));
    const back = await revealDavPassword(SECRET, sealed);
    check(`还原一致：${plain.slice(0, 6)}…`, back === plain, String(back));
  }

  const sealed = await sealDavPassword(SECRET, 'pässwörd-密码');
  console.log('\n[2] 换密钥就解不开');
  check('别的 secret 还原为 null', (await revealDavPassword('another-secret', sealed)) === null);

  console.log('\n[3] 校验兼容三种存储形态');
  check('加密行 + 正确密码', await verifyDavPassword(SECRET, sealed, 'pässwörd-密码'));
  check('加密行 + 错误密码', !(await verifyDavPassword(SECRET, sealed, 'nope')));
  // 早期自建版存的是 sha256(明文)；这类行必须还能登录
  const legacyHash = createHash('sha256').update('davpass', 'utf8').digest('hex');
  check('sha256 行 + 正确密码', await verifyDavPassword(SECRET, legacyHash, 'davpass'));
  check('sha256 行 + 错误密码', !(await verifyDavPassword(SECRET, legacyHash, 'davpas')));
  check('明文行（上游导入）可直接比对', await verifyDavPassword(SECRET, 'davpass', 'davpass'));
  check('明文行错误密码', !(await verifyDavPassword(SECRET, 'davpass', 'davpas')));

  console.log('\n[4] 展示层不泄漏哈希');
  check('sha256 行展示为空（不把哈希吐给用户）', (await revealDavPassword(SECRET, legacyHash)) === null);
  check('明文行照常展示（上游导入的账号要能看）', (await revealDavPassword(SECRET, 'davpass')) === 'davpass');
  check('空值展示为空', (await revealDavPassword(SECRET, '')) === null);

  console.log('\n[5] 篡改密文不会通过校验');
  const tampered = `${sealed.slice(0, -4)}AAAA`;
  check('改尾部', !(await verifyDavPassword(SECRET, tampered, 'pässwörd-密码')));
  check('截断', !(await verifyDavPassword(SECRET, 'enc:v1:AAAA', 'pässwörd-密码')));

  console.log(
    `\n${failed === 0 ? '全部通过' : `${failed} 项不通过`}（${passed} 项通过，${failed} 项失败）`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('测试异常：', err);
  process.exitCode = 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
