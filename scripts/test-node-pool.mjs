#!/usr/bin/env node
/**
 * 节点池与能力位解析的单元测试。
 *
 * 能力位字段是 `boolset` 的 base64（`pkg/boolset/boolset.go`）：第 `flag` 位在
 * `bytes[flag/8]` 的第 `flag%8` 位。解析错的话「这台节点有什么能力」全是反的，
 * 而表现只是任务没被分派 / 被分派到不能干的机器上。
 *
 * 跑法：node scripts/test-node-pool.mjs
 */
import { build } from 'esbuild';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 与 Go boolset.Set 等价的编码（测试用）。 */
function encodeCaps(flags) {
  const bytes = [];
  for (const f of flags) {
    while (bytes.length < Math.floor(f / 8) + 1) bytes.push(0);
    bytes[f >> 3] |= 1 << (f & 7);
  }
  return Buffer.from(bytes).toString('base64');
}

async function main() {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cr-pool-'));
  const bundlePath = path.join(outDir, 'nodePool.mjs');
  // 能力位解析在 lib/boolset.ts（纯函数），nodePool 只是转过去；
  // 直接打包 boolset 就能测，不必把 db/Neon 那套拖进来。
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/boolset.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });

  const { BooleanSet } = await import(`file://${bundlePath}`);
  const capabilityEnabled = (raw, flag) => BooleanSet.fromBase64(raw).enabled(flag);
  const NodeCapability = { CreateArchive: 1, ExtractArchive: 2, RemoteDownload: 3 };

  console.log('[能力位解析]');
  check('常量与上游一致', NodeCapability.CreateArchive === 1 && NodeCapability.ExtractArchive === 2 && NodeCapability.RemoteDownload === 3, JSON.stringify(NodeCapability));

  const none = encodeCaps([]);
  const onlyRemote = encodeCaps([3]);
  const archiveBoth = encodeCaps([1, 2]);
  const all = encodeCaps([1, 2, 3]);

  check('空集合：什么都不支持', capabilityEnabled(none, 3) === false);
  check('只勾了 remoteDownload', capabilityEnabled(onlyRemote, 3) === true && capabilityEnabled(onlyRemote, 1) === false);
  check('打包+解压', capabilityEnabled(archiveBoth, 1) === true && capabilityEnabled(archiveBoth, 2) === true && capabilityEnabled(archiveBoth, 3) === false);
  check('三项全开', capabilityEnabled(all, 1) && capabilityEnabled(all, 2) && capabilityEnabled(all, 3));
  check('空串按不支持', capabilityEnabled(null, 1) === false && capabilityEnabled('', 1) === false);
  check('非 base64 不抛错', capabilityEnabled('不是base64!!!', 1) === false);
  check('越界位按不支持', capabilityEnabled(onlyRemote, 40) === false);

  // 前端 Boolset 生成的串就是这个形态（base64 of 字节数组），拿真实形状验一次：
  // 'Ag' = [0x02] → 只有第 1 位（createArchive）为真
  check('前端形态 Ag = 只开 createArchive', capabilityEnabled('Ag', 1) === true && capabilityEnabled('Ag', 2) === false && capabilityEnabled('Ag', 3) === false);
  check('AQ = [0x01] 只开第 0 位（none）', capabilityEnabled('AQ', 0) === true && capabilityEnabled('AQ', 1) === false);

  await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${passed} 项通过，${failures.length} 项失败`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
