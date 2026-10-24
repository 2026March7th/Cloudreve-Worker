#!/usr/bin/env node
/**
 * 节点存储驱动的端到端测试。
 *
 * 起一个真实的 HTTP 从机（`agent/cloudreve-node-agent.mjs`），把
 * `src/storage/nodeRelay.ts` 用 esbuild 打成 ESM，然后用它完整走一遍：
 *   建会话 → 分片上传 → 落盘校验 → 元信息 → Range 读取 → 签名直链 → 删除
 * 外加一条反向用例：密钥不对必须被从机拒绝（证明签名真的在起作用）。
 *
 * 跑法：node scripts/test-node-relay.mjs
 */
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 18666;
const SECRET = 'test-secret-please-change';
const BASE = `http://127.0.0.1:${PORT}`;

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

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

async function waitForServer(timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/v4/slave/ping`, { method: 'POST' });
      if (res.status < 500) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('node agent did not start in time');
}

async function main() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cr-node-'));
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cr-bundle-'));

  console.log(`从机数据目录：${dataDir}`);

  // 1) 打包驱动（仓库里全是无扩展名的 import，Node 直接跑不了 TS）
  const bundlePath = path.join(outDir, 'nodeRelay.mjs');
  const rpcPath = path.join(outDir, 'nodeRpc.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/storage/nodeRelay.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/nodeRpc.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: rpcPath,
    logLevel: 'silent',
  });

  // 2) 起从机
  const agent = spawn(
    process.execPath,
    [path.join(ROOT, 'agent/cloudreve-node-agent.mjs'), '--root', dataDir, '--port', String(PORT), '--secret', SECRET, '--host', '127.0.0.1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const agentLog = [];
  agent.stdout.on('data', (d) => agentLog.push(String(d)));
  agent.stderr.on('data', (d) => agentLog.push(String(d)));

  try {
    await waitForServer();

    const { NodeRelayDriver } = await import(`file://${bundlePath}`);
    const { goJsonStringify, hmacSign } = await import(`file://${rpcPath}`);

    // ---------------------------------------------------------------- 签名单元
    console.log('\n[签名]');
    // Go 的 json.Marshal 会把 & < > 转义；头串里必然有 &，这一条错了全都通不过
    eq(
      'goJsonStringify 做 HTML 转义',
      goJsonStringify({ Path: '/a', Header: 'X-Cr-A=1&X-Cr-B=2', Body: '' }),
      '{"Path":"/a","Header":"X-Cr-A=1\\u0026X-Cr-B=2","Body":""}',
    );
    const sig = await hmacSign('k', 'abc', 1700000000);
    eq('hmacSign 带填充且格式为 "<b64>:<exp>"', /^[A-Za-z0-9_-]+={0,2}:1700000000$/.test(sig), true);

    // ---------------------------------------------------------------- 驱动
    const policy = {
      id: 7,
      name: 'node-disk',
      type: 'remote',
      server: null,
      bucket_name: null,
      is_private: false,
      access_key: null,
      secret_key: null,
      max_size: 0,
      dir_name_rule: 'uploads/{uid}/{path}',
      file_name_rule: '{uid}_{randomkey8}_{originname}',
      settings: { chunk_size: 50 },
      node_id: 3,
    };
    const node = {
      id: 3,
      name: 'vps-1',
      type: 'slave',
      server: BASE,
      slave_key: SECRET,
      status: 'active',
      weight: 1,
      capabilities: null,
      settings: null,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    };
    const meta = { siteId: 'site-id-123', siteUrl: 'https://pan.example.com', version: '4.19.1' };
    const driver = new NodeRelayDriver(policy, async () => ({ node, meta }));

    eq('chunkSize 取策略设置', driver.chunkSize, 50);
    eq('下载直连节点（不中转）', driver.capabilities().proxyRequired, false);

    // ---------------------------------------------------------------- 分片上传
    console.log('\n[分片上传]');
    const payload = Buffer.from('0123456789'.repeat(10), 'utf8'); // 100 字节
    const session = {
      id: '11111111-2222-3333-4444-555555555555',
      policy,
      uid: 1,
      fileId: 10,
      entityId: 20,
      savePath: 'uploads/1/demo/file.txt',
      size: payload.length,
      chunkSize: 50,
      parts: [],
      chunksReceived: [],
      callbackSecret: 's',
      expireAt: Date.now() + 3600_000,
      newFileCreated: true,
      mimeType: 'text/plain',
    };
    const cred = await driver.token(session, {
      savePath: session.savePath,
      fileName: 'file.txt',
      size: payload.length,
      mimeType: 'text/plain',
      overwrite: false,
    });
    eq('token 返回的分片大小', cred.chunk_size, 50);
    eq('token 走中转（无直传地址）', cred.upload_urls, undefined);

    await driver.writeChunk(session, 0, new Blob([payload.subarray(0, 50)]).stream(), 50);
    await driver.writeChunk(session, 1, new Blob([payload.subarray(50)]).stream(), 50);

    const onDisk = await fsp.readFile(path.join(dataDir, session.savePath));
    check('两个分片按偏移拼成完整文件', onDisk.equals(payload), `落盘 ${onDisk.length} B`);
    await driver.completeUpload(session);

    // ---------------------------------------------------------------- 元信息
    console.log('\n[元信息 / 读取]');
    const m = await driver.meta(session.savePath);
    eq('meta 返回文件大小', m?.size, payload.length);

    const full = await driver.get(session.savePath);
    const fullBytes = Buffer.from(await new Response(full.body).arrayBuffer());
    check('get 读出全部内容', fullBytes.equals(payload));

    const ranged = await driver.get(session.savePath, 'bytes=10-19');
    const rangedBytes = Buffer.from(await new Response(ranged.body).arrayBuffer());
    eq('Range 读取', [rangedBytes.toString(), ranged.contentRange], ['0123456789', 'bytes 10-19/100']);

    const missing = await driver.get('uploads/1/nope.bin');
    eq('不存在的对象返回 null', missing, null);

    // ---------------------------------------------------------------- 签名直链
    console.log('\n[签名直链]');
    const url = await driver.source(session.savePath, {
      isDownload: true,
      displayName: '报告 v2.txt',
      speed: 0,
    });
    check('直链指向节点', url.startsWith(`${BASE}/api/v4/slave/file/content/3/`), url);
    check('直链带 sign', url.includes('sign='));
    const dl = await fetch(url);
    eq('直链下载状态', dl.status, 200);
    const dlBytes = Buffer.from(await dl.arrayBuffer());
    check('直链内容一致', dlBytes.equals(payload));
    check(
      '直链带下载文件名',
      (dl.headers.get('content-disposition') ?? '').includes(encodeURIComponent('报告 v2.txt')),
      dl.headers.get('content-disposition') ?? '',
    );

    const headRes = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=0-9' } });
    eq('Head + Range 返回 206', headRes.status, 206);

    // 篡改签名必须被拒
    const tampered = url.replace(/sign=[^&]+/, 'sign=AAAA');
    const bad = await fetch(tampered);
    const badJson = await bad.json().catch(() => ({}));
    eq('签名被篡改时拒绝', badJson.code, 40001);

    // ---------------------------------------------------------------- 覆写上传
    console.log('\n[整文件覆写]');
    const overwritePath = 'uploads/1/demo/saved.md';
    const text = Buffer.from('# hello\n世界\n', 'utf8');
    await driver.put(
      { savePath: overwritePath, fileName: 'saved.md', size: text.length, mimeType: 'text/markdown', overwrite: false },
      new Blob([text]).stream(),
      text.length,
    );
    const saved = await fsp.readFile(path.join(dataDir, overwritePath));
    check('put 写入的内容正确', saved.equals(text));

    // ---------------------------------------------------------------- 删除
    console.log('\n[删除]');
    const failed = await driver.delete([session.savePath, overwritePath]);
    eq('删除无失败项', failed, []);
    const gone = await fsp.stat(path.join(dataDir, session.savePath)).then(() => false).catch(() => true);
    check('文件已从磁盘移除', gone);

    // ---------------------------------------------------------------- 错误密钥
    console.log('\n[安全]');
    const badDriver = new NodeRelayDriver(policy, async () => ({
      node: { ...node, slave_key: 'wrong-secret' },
      meta,
    }));
    let rejected = false;
    try {
      await badDriver.token(session, {
        savePath: 'uploads/1/x/y.txt',
        fileName: 'y.txt',
        size: 1,
        mimeType: 'text/plain',
        overwrite: true,
      });
    } catch (e) {
      rejected = /invalid sign|40001/.test(String(e.message));
    }
    check('密钥不对时从机拒绝建会话', rejected);
  } finally {
    agent.kill();
    if (failures.length > 0) {
      console.log('\n从机日志：');
      console.log(agentLog.join('').split('\n').slice(-20).join('\n'));
    }
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }

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
