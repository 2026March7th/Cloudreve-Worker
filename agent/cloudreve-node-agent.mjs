#!/usr/bin/env node
/**
 * Cloudreve 从节点 Agent（参考实现，零依赖）。
 *
 * 作用：让 Cloudreve-Worker 的「节点存储策略」把文件写到这台机器的磁盘上。
 * 协议与官方 Cloudreve 从机（`/api/v4/slave/*`）一致，所以官方从机也能用；
 * 这个脚本只是为了「懒得装第二个 Cloudreve」的场景 —— 单文件，直接 node 跑。
 *
 * 用法：
 *   NODE_NODE_SECRET=xxx node agent/cloudreve-node-agent.mjs --root /data/cloudreve
 *
 * 参数（也可用同名大写环境变量）：
 *   --root     文件根目录，默认 ./data
 *   --port     监听端口，默认 8666
 *   --secret   主→从 HMAC 密钥，**必填**，要与管理后台「节点密钥」一致
 *   --allow-private-fetch  允许远程下载抓内网/回环地址（默认禁止，做内网源时用）
 *   --host     监听地址，默认 0.0.0.0
 *   --node-id  本节点 id（只用于日志，校验时不比对）
 *
 * 反向代理记得：① 走 HTTPS；② 放开 PUT/POST/DELETE；
 * ③ 关闭请求体大小限制（默认 nginx 1MB 会让大文件分片失败）；
 * ④ 不要改写路径（签名是对路径算的）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { Readable } from 'node:stream';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const env = process.env;

/**
 * 允许抓取内网 / 回环地址。
 *
 * 默认禁止：远程下载是「服务端替用户去抓 URL」，不拦就能打内网服务。但如果
 * 这台节点的用途就是拉内网 NAS / 局域网源，可以显式打开（`--allow-private-fetch`
 * 或 `NODE_ALLOW_PRIVATE_FETCH=1`），风险自负。端到端测试也用它来连本地假服务器。
 */
const ALLOW_PRIVATE_FETCH =
  args['allow-private-fetch'] === 'true' || env.NODE_ALLOW_PRIVATE_FETCH === '1';

const ROOT = path.resolve(args.root ?? env.NODE_ROOT ?? './data');
const PORT = Number(args.port ?? env.NODE_PORT ?? 8666);
const HOST = args.host ?? env.NODE_HOST ?? '0.0.0.0';
const SECRET = args.secret ?? env.NODE_SECRET ?? env.NODE_NODE_SECRET ?? '';
const NODE_ID = args['node-id'] ?? env.NODE_ID ?? '0';

if (!SECRET) {
  console.error('[node-agent] 缺少 --secret（或环境变量 NODE_SECRET）');
  process.exit(1);
}

fs.mkdirSync(ROOT, { recursive: true });

// ---------------------------------------------------------------------------
// 签名（与 Go pkg/auth 逐字一致）
// ---------------------------------------------------------------------------

/** Go 的 json.Marshal 默认开启 HTML 转义：< > & 要转成 \u003c \u003e \u0026 */
function goJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (ch) => {
    return '\\u' + ch.codePointAt(0).toString(16).padStart(4, '0');
  });
}

/** base64url，**保留** = 填充（Go 用 base64.URLEncoding） */
function base64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function signContent(content, expires) {
  const mac = crypto.createHmac('sha256', SECRET).update(Buffer.from(`${content}:${expires}`, 'utf8')).digest();
  return `${base64Url(mac)}:${expires}`;
}

/** Go 的 textproto.CanonicalMIMEHeaderKey：每段首字母大写、其余小写 */
function canonicalHeader(name) {
  return name
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part))
    .join('-');
}

function signedHeaderString(headers) {
  return Object.entries(headers)
    .map(([k, v]) => [canonicalHeader(k), Array.isArray(v) ? v[0] : v])
    .filter(([k]) => k.startsWith('X-Cr-') && k !== 'X-Cr-Filename')
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 校验签名。规则同上游 `middleware.SignRequired`：
 *   PUT/POST/PATCH → 签请求头（正文参与，分片上传正文不参与）
 *   GET/HEAD/DELETE → 签 URL 的 `?sign=`（只签路径）
 */
function verify(req, url, rawBody) {
  const method = req.method.toUpperCase();
  const signHeader = req.headers.authorization ?? '';
  const querySign = url.searchParams.get('sign') ?? '';

  let provided;
  let expected;

  if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
    if (!signHeader.startsWith('Bearer Cr ')) {
      return 'authorization header is missing';
    }
    provided = signHeader.slice('Bearer Cr '.length);
    // `POST /api/v4/slave/upload/:id` 不签正文（pkg/auth.isUploadDataRequest）
    const isUploadData = url.pathname.includes('/api/v4/slave/upload/') && method !== 'PUT';
    const body = isUploadData ? '' : rawBody.toString('utf8');
    const content = goJson({
      Path: decodePath(url.pathname),
      Header: signedHeaderString(req.headers),
      Body: body,
    });
    expected = content;
  } else {
    if (!querySign) return 'sign is missing in query';
    provided = querySign;
    expected = decodePath(url.pathname);
  }

  const idx = provided.lastIndexOf(':');
  if (idx < 0) return 'invalid sign format';
  const expires = Number(provided.slice(idx + 1));
  if (!Number.isFinite(expires) || expires === 0) return 'expire timestamp is missing';
  if (expires < Math.floor(Date.now() / 1000)) return 'signature expired';

  const want = signContent(expected, expires);
  if (!timingSafeEqual(want, provided)) return 'invalid sign';
  return null;
}

function decodePath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

// ---------------------------------------------------------------------------
// 文件工具
// ---------------------------------------------------------------------------

/** 相对路径 → 绝对路径，并做 containment 校验（不许 ../ 逃出 ROOT）。 */
function resolveInRoot(rel) {
  const clean = String(rel ?? '').replace(/^\/+/, '');
  const abs = path.resolve(ROOT, clean);
  const base = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (abs !== ROOT && !abs.startsWith(base)) {
    throw new Error('path escapes node root');
  }
  return abs;
}

function decodeSrc(src) {
  // base64url，可能带 = 填充
  const normalized = src.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

async function readBody(req, limit = Infinity) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sendEnvelope(res, code, msg = '', data = null) {
  send(res, 200, { code, msg, data });
}

// ---------------------------------------------------------------------------
// 上传会话
// ---------------------------------------------------------------------------

/** sessionId → { abs, size, chunkSize, received:Set<number>, overwrite } */
const sessions = new Map();
const SESSION_TTL = 24 * 3600 * 1000;

function gcSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL) sessions.delete(id);
  }
}

// ---------------------------------------------------------------------------
// 任务（主站分派过来，在后台跑）
// ---------------------------------------------------------------------------

/** nodeTaskId → { type, state, status, error, createdAt } */
const tasks = new Map();
let taskSeq = 1;
const TASK_TTL = 24 * 3600 * 1000;

function gcTasks() {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (now - t.createdAt > TASK_TTL) tasks.delete(id);
  }
}

/**
 * 反向调用主站的 `/api/v4/slave/*`。
 *
 * 签名与主站打过来时同款（同一个 secret），只是方向相反：节点当客户端。
 * 主站靠 `X-Cr-Node-Id` + HMAC 认这台机器，所以这两个头必须带上。
 */
async function masterRpc(masterSiteUrl, method, path, payload, nodeId) {
  const base = String(masterSiteUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('task state has no master_site_url');
  const target = new URL(`/api/v4/slave/${path.replace(/^\/+/, '')}`, base);
  const bodyText = payload === undefined ? '' : JSON.stringify(payload);
  const expires = Math.floor(Date.now() / 1000) + 300;
  const headers = {
    'X-Cr-Node-Id': String(nodeId ?? 0),
    'X-Cr-Site-Id': 'node-agent',
    'X-Cr-Site-Url': base,
    'X-Cr-Version': 'node-agent',
  };
  const content = goJson({ Path: target.pathname, Header: signedHeaderString(headers), Body: bodyText });
  const sign = signContent(content, expires);
  const res = await fetch(target.toString(), {
    method,
    headers: {
      ...headers,
      Authorization: `Bearer Cr ${sign}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    ...(payload === undefined ? {} : { body: bodyText }),
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`master returned HTTP ${res.status} (non-JSON)`);
  if ((json.code ?? 0) !== 0) throw new Error(`master returns code ${json.code}: ${json.msg ?? ''}`);
  return json.data;
}

/**
 * 从机侧的 SSRF 兜底检查。
 *
 * 权威校验在主站（`src/lib/ssrf.ts`，含 CVE-2026-79913 的 IPv4-in-IPv6 拆解），
 * 但节点跑在真实网络里、能直连内网，所以在真正发请求前再拦一道 ——
 * 只要主机名是 IP 字面量且落在私网/回环/链路本地，就直接拒绝。
 */
function assertSafeRemoteUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('invalid remote url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('only http(s) is allowed');
  }
  if (ALLOW_PRIVATE_FETCH) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const blocked =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;
    if (blocked) throw new Error('refusing to fetch a private/loopback address');
    return u;
  }
  if (host.includes(':')) {
    const lower = host.toLowerCase();
    if (lower === '::1' || lower === '::') throw new Error('refusing to fetch a loopback address');
    if (/^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower)) {
      throw new Error('refusing to fetch a private address');
    }
  }
  if (/^(localhost|\.localhost|.*\.local|\.internal)$/.test(host.toLowerCase())) {
    throw new Error('refusing to fetch a local hostname');
  }
  return u;
}

/** 远端文件大小：HEAD 拿不到就用 Range 探测（CDN 常见）。 */
async function remoteSize(url) {
  const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
  let size = Number(head?.headers.get('content-length') ?? 0);
  if (size > 0) return size;
  const probe = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } }).catch(() => null);
  const range = probe?.headers.get('content-range');
  const total = range ? Number(range.split('/')[1]) : 0;
  if (total > 0) return total;
  return Number(probe?.headers.get('content-length') ?? 0);
}

/** 后台跑一个任务，状态写进 tasks 表。 */
function startTask(type, stateRaw) {
  gcTasks();
  const id = taskSeq++;
  tasks.set(id, { type, state: stateRaw, status: 'processing', createdAt: Date.now() });
  console.log(`[node-agent] 接任务 #${id} ${type}`);

  (async () => {
    let sessionId = null;
    try {
      if (type === 'remote_download') {
        // 先取到会话 id，失败时才能通知主站放弃
        const st = JSON.parse(stateRaw);
        assertSafeRemoteUrl(st.url);
        const size = await remoteSize(st.url);
        if (!size) throw new Error('remote file size is unknown');
        const session = await masterRpc(st.master_site_url, 'PUT', 'statelessUpload/prepare', {
          upload_request: { props: { uri: st.dst, size } },
          user_id: st.user_id,
        }, st.node_id);
        sessionId = session?.Props?.UploadSessionID ?? null;
        const savePath = session?.Props?.SavePath;
        if (!savePath || !sessionId) throw new Error('master did not return a usable upload session');

        const abs = resolveInRoot(savePath);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        const res = await fetch(st.url);
        if (!res.ok || !res.body) throw new Error(`failed to fetch remote file: HTTP ${res.status}`);
        // fetch 的 body 是 web ReadableStream，没有 .pipe —— 要转成 Node 流
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(abs);
          Readable.fromWeb(res.body).pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
        });
        const written = (await fsp.stat(abs)).size;
        if (written !== size) throw new Error(`downloaded ${written} bytes but expected ${size}`);

        await masterRpc(
          st.master_site_url,
          'POST',
          'statelessUpload/complete',
          { upload_session: { Props: { UploadSessionID: sessionId } }, user_id: st.user_id },
          st.node_id,
        );
        console.log(`[node-agent] 远程下载完成 ${st.url} → ${savePath}（${size} B）`);
      } else {
        throw new Error(`unsupported task type: ${type}`);
      }
      const t = tasks.get(id);
      if (t) t.status = 'completed';
    } catch (err) {
      const t = tasks.get(id);
      if (t) {
        t.status = 'error';
        t.error = err.message;
      }
      console.error(`[node-agent] 任务 #${id} 失败：`, err.message);
      if (sessionId) {
        try {
          const st = JSON.parse(stateRaw);
          await masterRpc(
            st.master_site_url,
            'POST',
            'statelessUpload/failed',
            { upload_session: { Props: { UploadSessionID: sessionId } }, user_id: st.user_id },
            st.node_id,
          );
        } catch {
          /* 通知失败不影响任务状态 */
        }
      }
    }
  })();

  return id;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, 'http://node.local');
  const method = req.method.toUpperCase();
  const p = url.pathname;
  const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  const authError = verify(req, url, rawBody);
  if (authError) {
    console.warn(`[node-agent] ${method} ${p} 验签失败：${authError}`);
    sendEnvelope(res, 40001, authError);
    return;
  }

  // --- ping ---------------------------------------------------------------
  if (p === '/api/v4/slave/ping' && method === 'POST') {
    sendEnvelope(res, 0);
    return;
  }

  // --- 创建上传会话 -------------------------------------------------------
  if (p === '/api/v4/slave/upload' && method === 'PUT') {
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      sendEnvelope(res, 40001, 'invalid json body');
      return;
    }
    const session = body.session ?? {};
    const props = session.Props ?? {};
    const sessionId = String(props.UploadSessionID ?? '');
    const savePath = String(props.SavePath ?? '');
    const size = Number(props.Size ?? 0);
    const chunkSize = Number(session.ChunkSize ?? session.Policy?.Settings?.chunk_size ?? 0) || 25 * 1024 * 1024;

    if (!sessionId || !savePath) {
      sendEnvelope(res, 40001, 'session id / save path is required');
      return;
    }

    let abs;
    try {
      abs = resolveInRoot(savePath);
    } catch (e) {
      sendEnvelope(res, 40001, e.message);
      return;
    }

    const existed = fs.existsSync(abs);
    if (existed && body.overwrite !== true) {
      sendEnvelope(res, 40001, 'placeholder file already exist');
      return;
    }

    await fsp.mkdir(path.dirname(abs), { recursive: true });
    // 预分配：先把文件撑到目标大小，后续分片按偏移写入
    const fh = await fsp.open(abs, 'w');
    try {
      await fh.truncate(Math.max(size, 0));
    } finally {
      await fh.close();
    }

    gcSessions();
    sessions.set(sessionId, { abs, size, chunkSize, received: new Set(), createdAt: Date.now() });
    console.log(`[node-agent] 建会话 ${sessionId} → ${savePath} (${size} B)`);
    sendEnvelope(res, 0);
    return;
  }

  const uploadMatch = /^\/api\/v4\/slave\/upload\/([^/]+)$/.exec(p);
  if (uploadMatch && method === 'POST') {
    const sessionId = decodeURIComponent(uploadMatch[1]);
    const session = sessions.get(sessionId);
    if (!session) {
      sendEnvelope(res, 40001, 'upload session not found');
      return;
    }
    const index = Number(url.searchParams.get('chunk') ?? 0);
    if (!Number.isInteger(index) || index < 0) {
      sendEnvelope(res, 40001, 'invalid chunk index');
      return;
    }
    const offset = index * session.chunkSize;
    if (offset + rawBody.length > session.size + session.chunkSize) {
      sendEnvelope(res, 40001, 'chunk exceeds expected file size');
      return;
    }
    const fh = await fsp.open(session.abs, 'r+');
    try {
      await fh.write(rawBody, 0, rawBody.length, offset);
    } finally {
      await fh.close();
    }
    session.received.add(index);
    const total = Math.max(1, Math.ceil(session.size / session.chunkSize));
    if (session.received.size >= total) {
      sessions.delete(sessionId);
      console.log(`[node-agent] 上传完成 ${sessionId}（${session.received.size}/${total} 片）`);
    }
    sendEnvelope(res, 0);
    return;
  }

  if (uploadMatch && method === 'DELETE') {
    const sessionId = decodeURIComponent(uploadMatch[1]);
    const session = sessions.get(sessionId);
    sessions.delete(sessionId);
    if (session) {
      // 半截文件删掉，别留垃圾
      await fsp.rm(session.abs, { force: true }).catch(() => {});
    }
    sendEnvelope(res, 0);
    return;
  }

  // --- 文件内容 -----------------------------------------------------------
  const contentMatch = /^\/api\/v4\/slave\/file\/content\/(\d+)\/([^/]+)\/(\d+)\/([^/]+)$/.exec(p);
  if (contentMatch) {
    const [, , srcEncoded, , nameEncoded] = contentMatch;
    let abs;
    try {
      abs = resolveInRoot(decodeSrc(decodeURIComponent(srcEncoded)));
    } catch (e) {
      send(res, 400, e.message);
      return;
    }
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      send(res, 404, 'not found');
      return;
    }
    if (!stat.isFile()) {
      send(res, 404, 'not found');
      return;
    }

    const download = url.searchParams.get('download') !== null;
    const name = decodeURIComponent(nameEncoded);
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=2592000',
      'Accept-Ranges': 'bytes',
      'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
      ETag: `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    };
    if (download) {
      headers['Content-Disposition'] =
        `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    } else {
      headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(name)}`;
    }

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] === '' ? null : Number(m[1]);
        let end = m[2] === '' ? null : Number(m[2]);
        if (start === null && end !== null) {
          // 后缀区间：bytes=-1024
          start = Math.max(0, stat.size - end);
          end = stat.size - 1;
        } else {
          start = start ?? 0;
          end = end === null ? stat.size - 1 : Math.min(end, stat.size - 1);
        }
        if (start > end || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        headers['Content-Length'] = end - start + 1;
        res.writeHead(206, headers);
        if (method === 'HEAD') {
          res.end();
          return;
        }
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }
    }

    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(abs).pipe(res);
    return;
  }

  // --- 删除文件 -----------------------------------------------------------
  if (p === '/api/v4/slave/file' && method === 'DELETE') {
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      sendEnvelope(res, 40001, 'invalid json body');
      return;
    }
    const files = Array.isArray(body.files) ? body.files : [];
    const failed = [];
    for (const file of files) {
      try {
        await fsp.rm(resolveInRoot(file), { force: true });
      } catch {
        failed.push(file);
      }
    }
    if (failed.length > 0) {
      // CodeNotFullySuccess
      sendEnvelope(res, 40069, 'some files failed to delete', failed);
    } else {
      sendEnvelope(res, 0);
    }
    return;
  }

  // --- 列出 ---------------------------------------------------------------
  if (p === '/api/v4/slave/file/list' && method === 'GET') {
    const startRel = url.searchParams.get('path') ?? '';
    const recursive = url.searchParams.get('recursive') === 'true';
    let startAbs;
    try {
      startAbs = resolveInRoot(startRel);
    } catch (e) {
      send(res, 400, e.message);
      return;
    }
    // 官方从机这里返回 gob 编码，主站用 GobDecode 解；本 agent 直接回 JSON
    const items = [];
    async function walk(dir, relBase) {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        const stat = await fsp.stat(abs);
        items.push({
          Name: entry.name,
          RelativePath: rel,
          Source: rel,
          Size: stat.size,
          IsDir: entry.isDirectory(),
          LastModify: new Date(stat.mtimeMs).toISOString(),
        });
        if (entry.isDirectory() && recursive) await walk(abs, rel);
      }
    }
    try {
      await walk(startAbs, startRel.replace(/^\/+|\/+$/g, ''));
    } catch (e) {
      send(res, 404, e.message);
      return;
    }
    sendEnvelope(res, 0, '', items);
    return;
  }

  // --- 任务 -----------------------------------------------------------------
  if (p === '/api/v4/slave/task' && method === 'PUT') {
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      sendEnvelope(res, 40001, 'invalid json body');
      return;
    }
    const type = String(body.type ?? '');
    const state = String(body.state ?? '{}');
    if (!type) {
      sendEnvelope(res, 40001, 'task type is required');
      return;
    }
    const id = startTask(type, state);
    sendEnvelope(res, 0, '', { id });
    return;
  }

  const taskMatch = /^\/api\/v4\/slave\/task\/(\d+)$/.exec(p);
  if (taskMatch && method === 'GET') {
    const id = Number(taskMatch[1]);
    const t = tasks.get(id);
    if (!t) {
      sendEnvelope(res, 40001, 'task not found');
      return;
    }
    sendEnvelope(res, 0, '', {
      status: t.status,
      error: t.error ?? '',
      private_state: t.state,
    });
    return;
  }

  if (p === '/api/v4/slave/task/cleanup' && method === 'POST') {
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      sendEnvelope(res, 40001, 'invalid json body');
      return;
    }
    for (const dir of Array.isArray(body.path) ? body.path : []) {
      await fsp.rm(resolveInRoot(dir), { recursive: true, force: true }).catch(() => {});
    }
    sendEnvelope(res, 0);
    return;
  }

  // --- 缩略图（未实现，主站会回落到 CF 图片缩放）---------------------------
  if (/^\/api\/v4\/slave\/file\/thumb\//.test(p)) {
    send(res, 404, 'thumb not supported by this agent');
    return;
  }

  send(res, 404, 'not found');
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[node-agent] 处理失败：', err);
    if (!res.headersSent) sendEnvelope(res, 50001, err.message);
    else res.end();
  });
});

// 大文件分片不受 body 解析插件限制（这里是原生 http，无需额外配置）
server.listen(PORT, HOST, () => {
  console.log('[node-agent] 已启动');
  console.log(`  监听   http://${HOST}:${PORT}`);
  console.log(`  根目录 ${ROOT}`);
  console.log(`  节点   ${NODE_ID}`);
  console.log('  管理后台里「节点地址」填这个 http(s) 地址，「节点密钥」填 --secret 的值');
});
