#!/usr/bin/env node
/**
 * 从节点任务分派的端到端测试。
 *
 * 起三个本地服务，把整条链路跑通：
 *   1. 远端文件源（普通 HTTP，提供 Content-Length）
 *   2. 假主站 —— 用**真实的** `verifyNodeSignature`（从 src/lib/nodeRpc.ts 打包）
 *      校验签名，并实现 statelessUpload 的 prepare/complete/failed 三个回调
 *   3. 真从机（agent/cloudreve-node-agent.mjs）
 *
 * 然后以主站的身份（同样用 nodeRpc 的签名）往从机派一个 remote_download 任务，
 * 断言：文件落到从机磁盘、假主站收到了 prepare→complete、任务状态变 completed。
 * 外加一条反向用例：密钥不对时从机必须拒绝。
 *
 * 跑法：node scripts/test-node-tasks.mjs
 */
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SECRET = 'task-test-secret';
const NODE_ID = 3;

const ORIGIN_PORT = 18711;
const MASTER_PORT = 18712;
const AGENT_PORT = 18713;

const PAYLOAD = Buffer.from('remote-download-payload-'.repeat(64), 'utf8'); // ~2.2KB

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

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function main() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cr-task-node-'));
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cr-task-bundle-'));

  const rpcPath = path.join(outDir, 'nodeRpc.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/nodeRpc.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: rpcPath,
    logLevel: 'silent',
  });
  const { verifyNodeSignature, signNodeRequest, signNodeUrl } = await import(`file://${rpcPath}`);

  // --- 1. 远端文件源 -------------------------------------------------------
  const origin = http.createServer(async (req, res) => {
    if (req.method === 'HEAD' || (req.method === 'GET' && !req.headers.range)) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': PAYLOAD.length,
      });
      res.end(req.method === 'HEAD' ? undefined : PAYLOAD);
      return;
    }
    // Range 探测
    res.writeHead(206, {
      'Content-Range': `bytes 0-0/${PAYLOAD.length}`,
      'Content-Length': 1,
    });
    res.end(PAYLOAD.subarray(0, 1));
  });
  await new Promise((r) => origin.listen(ORIGIN_PORT, '127.0.0.1', r));

  // --- 2. 假主站 -----------------------------------------------------------
  const masterLog = { prepare: [], complete: [], failed: [] };
  const master = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${MASTER_PORT}`);
    const raw = await readBody(req);
    const check = await verifyNodeSignature({
      slaveKey: SECRET,
      method: req.method,
      url: `http://127.0.0.1:${MASTER_PORT}${url.pathname}${url.search}`,
      headers: new Headers(req.headers),
      body: raw,
    });
    if (!check.ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 40001, msg: check.reason, data: null }));
      return;
    }

    const send = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, msg: '', data }));
    };

    if (url.pathname === '/api/v4/slave/statelessUpload/prepare' && req.method === 'PUT') {
      const body = JSON.parse(raw.toString('utf8') || '{}');
      masterLog.prepare.push(body);
      const savePath = `uploads/${body.user_id}/remote/dl-${Date.now()}.bin`;
      masterLog.savePath = savePath;
      send({
        UID: body.user_id,
        Props: {
          UploadSessionID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          SavePath: savePath,
          Size: body.upload_request.props.size,
          MimeType: 'application/octet-stream',
        },
      });
      return;
    }
    if (url.pathname === '/api/v4/slave/statelessUpload/complete' && req.method === 'POST') {
      masterLog.complete.push(JSON.parse(raw.toString('utf8') || '{}'));
      send({ id: 1 });
      return;
    }
    if (url.pathname === '/api/v4/slave/statelessUpload/failed' && req.method === 'POST') {
      masterLog.failed.push(JSON.parse(raw.toString('utf8') || '{}'));
      send(null);
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => master.listen(MASTER_PORT, '127.0.0.1', r));

  // --- 3. 从机 -------------------------------------------------------------
  const agent = spawn(
    process.execPath,
    [
      path.join(ROOT, 'agent/cloudreve-node-agent.mjs'),
      '--root', dataDir,
      '--port', String(AGENT_PORT),
      '--secret', SECRET,
      '--host', '127.0.0.1',
      '--node-id', String(NODE_ID),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const agentLog = [];
  agent.stdout.on('data', (d) => agentLog.push(String(d)));
  agent.stderr.on('data', (d) => agentLog.push(String(d)));

  try {
    // 等从机起来
    for (let i = 0; i < 50; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/api/v4/slave/ping`, { method: 'POST' });
        if (res.status < 500) break;
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const node = {
      id: NODE_ID,
      name: 'vps-task',
      type: 'slave',
      server: `http://127.0.0.1:${AGENT_PORT}`,
      slave_key: SECRET,
      status: 'active',
      weight: 1,
      capabilities: null,
      settings: null,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    };
    const meta = { siteId: 'site-id', siteUrl: `http://127.0.0.1:${MASTER_PORT}`, version: '4.19.1' };

    // --- 派任务 -----------------------------------------------------------
    const state = JSON.stringify({
      node_id: NODE_ID,
      user_id: 42,
      url: `http://127.0.0.1:${ORIGIN_PORT}/big.bin`,
      dst: 'cloudreve://my/下载/big.bin',
      master_site_url: `http://127.0.0.1:${MASTER_PORT}`,
      master_site_id: 'site-id',
      master_site_version: '4.19.1',
    });
    const body = JSON.stringify({ type: 'remote_download', state });
    const headers = await signNodeRequest(node, meta, {
      path: '/api/v4/slave/task',
      bodyText: body,
    });

    console.log('\n[派发 remote_download]');
    const dispatch = await fetch(`http://127.0.0.1:${AGENT_PORT}/api/v4/slave/task`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body,
    });
    const dispatchJson = await dispatch.json();
    check('派发返回 code 0', dispatchJson.code === 0, JSON.stringify(dispatchJson));
    const nodeTaskId = dispatchJson?.data?.id;
    check('拿到从节点任务 id', Number.isInteger(nodeTaskId), String(nodeTaskId));

    // --- 轮询到结束 -------------------------------------------------------
    let status = '';
    let lastError = '';
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      // GET 走 URI 签名（与从机的 SignRequired 规则一致），不带 Authorization 头
      const signed = await signNodeUrl(
        node,
        `http://127.0.0.1:${AGENT_PORT}/api/v4/slave/task/${nodeTaskId}`,
        300,
      );
      const res = await fetch(signed);
      const json = await res.json();
      status = json?.data?.status ?? '';
      lastError = json?.data?.error ?? '';
      if (status === 'completed' || status === 'error') break;
    }

    console.log('\n[任务结果]');
    check('任务跑完', status === 'completed', `status=${status} error=${lastError}`);

    console.log('\n[主站回调]');
    check('主站收到 prepare', masterLog.prepare.length === 1, `${masterLog.prepare.length} 次`);
    check('prepare 带上 uri 与 size', (() => {
      const p = masterLog.prepare[0];
      return p?.upload_request?.props?.uri === 'cloudreve://my/下载/big.bin'
        && p?.upload_request?.props?.size === PAYLOAD.length;
    })(), JSON.stringify(masterLog.prepare[0]?.upload_request?.props));
    check('主站收到 complete', masterLog.complete.length === 1, `${masterLog.complete.length} 次`);
    check('complete 的会话 id 与 prepare 一致', (() => {
      const prepareId = masterLog.prepare[0]?.upload_request?.props?.uri;
      const completeId = masterLog.complete[0]?.upload_session?.Props?.UploadSessionID;
      return typeof prepareId === 'string' && completeId === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    })());
    check('没有误调 failed', masterLog.failed.length === 0, `${masterLog.failed.length} 次`);

    console.log('\n[落盘内容]');
    const diskPath = masterLog.savePath ? path.join(dataDir, masterLog.savePath) : '';
    const onDisk = diskPath ? await fsp.readFile(diskPath).catch(() => null) : null;
    check('从机磁盘上有产物', onDisk !== null, diskPath || 'no savePath');
    check('内容与远端一致', onDisk?.equals(PAYLOAD) === true, onDisk ? `${onDisk.length} B` : 'none');

    console.log('\n[安全]');
    // 用错密钥派发必须被拒
    const badHeaders = await signNodeRequest({ ...node, slave_key: 'wrong' }, meta, {
      path: '/api/v4/slave/task',
      bodyText: JSON.stringify({ type: 'remote_download', state: '{}' }),
    });
    const badRes = await fetch(`http://127.0.0.1:${AGENT_PORT}/api/v4/slave/task`, {
      method: 'PUT',
      headers: { ...badHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'remote_download', state: '{}' }),
    });
    const badJson = await badRes.json();
    check('密钥不对时从机拒绝派发', badJson.code === 40001, JSON.stringify(badJson));

    // 主站侧验签也要能挡住乱签的请求
    const forged = await verifyNodeSignature({
      slaveKey: SECRET,
      method: 'POST',
      url: `http://127.0.0.1:${MASTER_PORT}/api/v4/slave/statelessUpload/complete`,
      headers: new Headers({
        authorization: 'Bearer Cr AAAA:9999999999',
        'x-cr-node-id': String(NODE_ID),
      }),
      body: '{}',
    });
    check('主站侧验签拒绝伪造签名', forged.ok === false, forged.ok ? '' : forged.reason);
  } finally {
    agent.kill();
    origin.close();
    master.close();
    if (failures.length > 0) {
      console.log('\n从机日志：');
      console.log(agentLog.join('').split('\n').slice(-25).join('\n'));
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
