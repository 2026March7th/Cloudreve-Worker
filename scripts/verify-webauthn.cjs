/**
 * WebAuthn 集成测试（Node 环境）。
 *
 * 不 mock 加密：用 Node WebCrypto 生成真实 ES256 / RS256 / Ed25519 密钥对，
 * 构造真实 CBOR attestation/assertion 报文，走 PasskeyService 完整流程，
 * 覆盖成功路径与全部拒绝路径。AppContext / KV / 仓储用内存桩。
 *
 * 前置：先编译 src → _verify（见 package.json 脚本或手工 tsc 命令），
 * 且 _verify/package.json 里写 {"type":"commonjs"}。
 */
const assert = require('node:assert');
const {
  b64urlEncode,
  b64urlDecode,
  cborDecode,
  parseAuthData,
  parseAttestationObject,
  coseVerify,
  challengeMatches,
} = require('./lib/webauthn.js');
const { PasskeyService } = require('./services/passkey.js');
const { HashIDCodec } = require('./lib/hashid.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 最小 CBOR 编码器（测试专用）
// ---------------------------------------------------------------------------
function headByte(mt, arg) {
  if (arg < 24) return Uint8Array.of((mt << 5) | arg);
  if (arg < 256) return Uint8Array.of((mt << 5) | 24, arg);
  if (arg < 65536) return Uint8Array.of((mt << 5) | 25, arg >> 8, arg & 0xff);
  return Uint8Array.of((mt << 5) | 26, arg >>> 24, (arg >> 16) & 0xff, (arg >> 8) & 0xff, arg & 0xff);
}
function cborEnc(v) {
  if (typeof v === 'number') return v >= 0 ? headByte(0, v) : headByte(1, -v - 1);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([headByte(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([headByte(2, v.length), v]);
  if (v === true) return Uint8Array.of(0xf5);
  if (v === null) return Uint8Array.of(0xf6);
  if (v instanceof Map) {
    const parts = [headByte(5, v.size)];
    for (const [k, val] of v) parts.push(cborEnc(k), cborEnc(val));
    return Buffer.concat(parts);
  }
  if (Array.isArray(v)) return Buffer.concat([headByte(4, v.length), ...v.map(cborEnc)]);
  throw new Error('cborEnc: unsupported ' + typeof v);
}

// ---------------------------------------------------------------------------
// 桩：KV / 仓储 / 用户 / codec
// ---------------------------------------------------------------------------
function makeKV() {
  const m = new Map();
  return {
    async put(k, v) { m.set(k, v); },
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async delete(k) { m.delete(k); },
    _m: m,
  };
}

function makeEnv() {
  return { KV: makeKV() };
}

/** 内存 passkey 仓储，行为对齐 PasskeyRepo。 */
function makePasskeyStore() {
  let nextId = 1;
  const rows = [];
  return {
    async create(args) {
      const row = {
        id: nextId++,
        created_at: new Date(),
        updated_at: new Date(),
        deleted_at: null,
        user_id: args.userId,
        credential_id: args.credentialId,
        name: args.name,
        credential: { ...args.credential },
        used_at: null,
      };
      rows.push(row);
      return row;
    },
    async listByUser(userId) { return rows.filter((r) => r.user_id === userId && !r.deleted_at); },
    async byCredentialId(userId, cid) {
      return rows.find((r) => r.user_id === userId && r.credential_id === cid && !r.deleted_at) ?? null;
    },
    async markUsed(userId, cid) {
      const r = rows.find((r) => r.user_id === userId && r.credential_id === cid);
      if (r) r.used_at = new Date();
    },
    async updateCounter(userId, cid, signCount) {
      const r = rows.find((r) => r.user_id === userId && r.credential_id === cid);
      if (r) r.credential.signCount = signCount;
    },
    async remove(userId, cid) {
      const r = rows.find((r) => r.user_id === userId && r.credential_id === cid);
      if (r) r.deleted_at = new Date();
    },
  };
}

const USER = {
  id: 7,
  status: 'active',
  email: 'test@example.com',
  nick: 'Tester',
  group: { id: 2, permissions: new Uint8Array(8) },
};

function makeCtx(overrides = {}) {
  const passkeys = makePasskeyStore();
  return {
    settings: {
      siteUrl: 'https://cloud.example.com',
      siteName: 'Test Cloud',
      authnEnabled: true,
    },
    users: { byIdWithGroup: async (id) => (id === USER.id ? { ...USER } : null) },
    passkeys,
    _passkeys: passkeys,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 报文构造
// ---------------------------------------------------------------------------

async function coseKeyFor(alg) {
  if (alg === 'ES256') {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    // raw = 0x04 || x(32) || y(32)
    const x = raw.slice(1, 33);
    const y = raw.slice(33, 65);
    const cose = cborEnc(new Map([
      [1, 2], [3, -7], [-1, 1], [-2, x], [-3, y],
    ]));
    return { kp, cose, private: kp.privateKey, algName: { name: 'ECDSA', hash: 'SHA-256' } };
  }
  if (alg === 'RS256') {
    const kp = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const cose = cborEnc(new Map([
      [1, 3], [3, -257],
      [-1, b64urlDecode(jwk.n)], [-2, b64urlDecode(jwk.e)],
    ]));
    return { kp, cose, private: kp.privateKey, algName: { name: 'RSASSA-PKCS1-v1_5' } };
  }
  if (alg === 'Ed25519') {
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const cose = cborEnc(new Map([[1, 1], [3, -8], [-1, 6], [-2, raw]]));
    return { kp, cose, private: kp.privateKey, algName: { name: 'Ed25519' } };
  }
  throw new Error('unknown alg ' + alg);
}

const RP_ID = 'cloud.example.com';
const ORIGIN = 'https://cloud.example.com';

async function buildAuthData({ cose, credId, signCount, flagsExtra = 0 }) {
  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', Buffer.from(RP_ID)));
  const flags = 0x01 | flagsExtra; // UP
  const aaguid = new Uint8Array(16);
  const head = Buffer.concat([
    rpIdHash,
    Uint8Array.of(flags),
    Buffer.from([0, 0, 0, 0].map((_, i) => (signCount >> (8 * (3 - i))) & 0xff)),
    aaguid,
    Uint8Array.of(credId.length >> 8, credId.length & 0xff),
    credId,
  ]);
  return Buffer.concat([head, cose]);
}

function clientData(type, challengeB64url) {
  return Buffer.from(JSON.stringify({ type, challenge: challengeB64url, origin: ORIGIN, crossOrigin: false }));
}

function b64(std) { return Buffer.from(std, 'base64'); }
function toStd(bytes) { return Buffer.from(bytes).toString('base64'); }

// ---------------------------------------------------------------------------
// 1. 纯函数
// ---------------------------------------------------------------------------
async function testLib() {
  console.log('--- 1. b64url / CBOR / authData ---');

  const bytes = Uint8Array.of(0, 1, 250, 251, 255);
  check('b64url 往返', Buffer.from(b64urlDecode(b64urlEncode(bytes))).equals(Buffer.from(bytes)));
  check('b64url 兼容填充', Buffer.from(b64urlDecode(b64urlEncode(bytes) + '=='.slice(0, (4 - (b64urlEncode(bytes).length % 4)) % 4))).equals(Buffer.from(bytes)));
  check('challenge 字节比较', challengeMatches(b64urlEncode(bytes), b64urlEncode(Uint8Array.of(0, 1, 250, 251, 255))));

  const dec = (buf) => cborDecode(buf).value;
  check('CBOR int', dec(cborEnc(42)) === 42);
  check('CBOR 负数', dec(cborEnc(-7)) === -7);
  check('CBOR 大整数', dec(cborEnc(70000)) === 70000);
  check('CBOR bytes', Buffer.from(dec(cborEnc(Uint8Array.of(1, 2, 3)))).equals(Buffer.of(1, 2, 3)));
  check('CBOR text(中文)', dec(cborEnc('你好')) === '你好');
  const m = new Map([[1, 'a'], [-2, Uint8Array.of(9)], ['k', true]]);
  const back = dec(cborEnc(m));
  check('CBOR map', back.get(1) === 'a' && Buffer.from(back.get(-2)).equals(Buffer.of(9)) && back.get('k') === true);

  // parseAuthData：注册形态
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const { cose } = await coseKeyFor('ES256');
  const ad = await buildAuthData({ cose, credId, signCount: 7, flagsExtra: 0x40 });
  const parsed = parseAuthData(new Uint8Array(ad));
  check('authData rpIdHash', Buffer.from(parsed.rpIdHash).equals(Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(RP_ID)))));
  check('authData UP|AT', (parsed.flags & 0x41) === 0x41);
  check('authData signCount', parsed.signCount === 7);
  check('authData credId', Buffer.from(parsed.credentialId).equals(Buffer.from(credId)));
  check('authData COSE 原样', Buffer.from(parsed.cosePublicKey).equals(Buffer.from(cose)));

  // attestationObject
  const ao = cborEnc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
  const aoParsed = parseAttestationObject(new Uint8Array(ao));
  check('attestationObject fmt', aoParsed.fmt === 'none');
  check('attestationObject authData', Buffer.from(aoParsed.authData).equals(ad));
}

// ---------------------------------------------------------------------------
// 2. 注册全流程
// ---------------------------------------------------------------------------
async function testRegister() {
  console.log('--- 2. 注册（finishRegister） ---');
  const env = makeEnv();
  const ctx = makeCtx();
  const codec = new HashIDCodec('test-salt');
  const svc = new PasskeyService(ctx, env, codec);

  const options = await svc.prepareRegister(USER);
  const pk = options.publicKey;
  check('选项含 rp.name/id', pk.rp.name === 'Test Cloud' && pk.rp.id === RP_ID);
  check('user.id = hashid 的 b64url', new TextDecoder().decode(b64urlDecode(pk.user.id)) === codec.encodeUserID(USER.id));
  check('residentKey required', pk.authenticatorSelection.residentKey === 'required');
  check('挑战可解且 32 字节', b64urlDecode(pk.challenge).length === 32);

  // 成功注册
  const { cose, kp, algName } = await coseKeyFor('ES256');
  const credId = crypto.getRandomValues(new Uint8Array(20));
  const ad = await buildAuthData({ cose, credId, signCount: 5, flagsExtra: 0x40 });
  const cd = clientData('webauthn.create', pk.challenge);
  const res = await svc.finishRegister(USER, {
    response: JSON.stringify({
      rawId: b64urlEncode(credId),
      response: {
        attestationObject: b64urlEncode(cborEnc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]))),
        clientDataJSON: b64urlEncode(cd),
      },
    }),
    name: 'My Key',
  });
  check('注册返回 credential_id', res.id === toStd(credId), res.id);
  check('注册返回名称', res.name === 'My Key');
  const stored = await ctx.passkeys.byCredentialId(USER.id, toStd(credId));
  check('凭据落库', Boolean(stored));
  check('落库含 COSE 公钥', stored && b64(stored.credential.publicKey).equals(Buffer.from(cose)));
  check('落库 signCount', stored && stored.credential.signCount === 5);

  // ES256 真实验签（独立于 service，直接验证 coseVerify 链路）
  const signed = Buffer.concat([ad, new Uint8Array(await crypto.subtle.digest('SHA-256', cd))]);
  const sig = new Uint8Array(await crypto.subtle.sign(algName, kp.privateKey, signed));
  check('coseVerify ES256', await coseVerify(new Uint8Array(cose), signed, sig));
  const badSig = sig.slice();
  badSig[10] ^= 0xff;
  check('coseVerify 拒绝坏签名', !(await coseVerify(new Uint8Array(cose), signed, badSig)));

  // 拒绝路径
  const mkReg = async (patch = {}) => {
    const challenge = patch.challenge ?? pk.challenge;
    const origin = patch.origin ?? ORIGIN;
    const rawId = patch.rawId ?? credId;
    const at = patch.attested ?? credId;
    const a = await buildAuthData({ cose, credId: at, signCount: 5, flagsExtra: 0x40 });
    const c = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
    return svc.finishRegister(USER, {
      response: JSON.stringify({
        rawId: b64urlEncode(rawId),
        response: {
          attestationObject: b64urlEncode(cborEnc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', a]]))),
          clientDataJSON: b64urlEncode(c),
        },
      }),
      name: 'x',
    });
  };
  await assert.rejects(() => mkReg({ challenge: b64urlEncode(crypto.getRandomValues(new Uint8Array(32))) }), 'challenge 不匹配');
  await assert.rejects(() => mkReg({ origin: 'https://evil.example' }), 'origin 不允许');
  await assert.rejects(() => mkReg({ rawId: crypto.getRandomValues(new Uint8Array(20)) }), 'rawId 不一致');
  await assert.rejects(() => mkReg({ attested: crypto.getRandomValues(new Uint8Array(20)) }), 'attested 不一致');

  // 会话一次性：再用同一挑战应失败
  await assert.rejects(() => mkReg(), '注册会话未销毁');

  // 会话过期（KV 里没有）
  await assert.rejects(
    () => svc.finishRegister(USER, { response: '{"rawId":"AA"}', name: 'x' }),
    '无会话应 404',
  );
}

// ---------------------------------------------------------------------------
// 3. 登录全流程（ES256 / RS256 / Ed25519 + 拒绝路径）
// ---------------------------------------------------------------------------
async function testLogin() {
  console.log('--- 3. 登录（finishLogin） ---');
  const env = makeEnv();
  const ctx = makeCtx();
  const codec = new HashIDCodec('test-salt');
  const svc = new PasskeyService(ctx, env, codec);

  for (const alg of ['ES256', 'RS256', 'Ed25519']) {
    // 注册一个凭据
    const regOpts = await svc.prepareRegister(USER);
    const { cose, kp, algName } = await coseKeyFor(alg);
    const credId = crypto.getRandomValues(new Uint8Array(20));
    const ad = await buildAuthData({ cose, credId, signCount: 10, flagsExtra: 0x40 });
    await svc.finishRegister(USER, {
      response: JSON.stringify({
        rawId: b64urlEncode(credId),
        response: {
          attestationObject: b64urlEncode(cborEnc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]))),
          clientDataJSON: b64urlEncode(clientData('webauthn.create', regOpts.publicKey.challenge)),
        },
      }),
      name: alg,
    });

    // 登录
    const loginOpts = await svc.prepareLogin();
    const challenge = loginOpts.options.publicKey.challenge;
    check(`[${alg}] 登录选项 rpId`, loginOpts.options.publicKey.rpId === RP_ID);
    const cd = clientData('webauthn.get', challenge);
    const authBytes = await buildAuthData({ cose, credId, signCount: 11, flagsExtra: 0 });
    const signed = Buffer.concat([authBytes, new Uint8Array(await crypto.subtle.digest('SHA-256', cd))]);
    const sig = new Uint8Array(await crypto.subtle.sign(algName, kp.privateKey, signed));
    const user = await svc.finishLogin({
      sessionID: loginOpts.session_id,
      response: JSON.stringify({
        rawId: b64urlEncode(credId),
        response: {
          authenticatorData: b64urlEncode(authBytes),
          clientDataJSON: b64urlEncode(cd),
          signature: b64urlEncode(sig),
          userHandle: b64urlEncode(new TextEncoder().encode(codec.encodeUserID(USER.id))),
        },
      }),
    });
    check(`[${alg}] 登录返回用户`, user.id === USER.id);
    const stored = await ctx.passkeys.byCredentialId(USER.id, toStd(credId));
    check(`[${alg}] 计数器推进`, stored.credential.signCount === 11);
    check(`[${alg}] used_at 更新`, Boolean(stored.used_at));

    // 签名错误
    const opts2 = await svc.prepareLogin();
    const cd2 = clientData('webauthn.get', opts2.options.publicKey.challenge);
    const auth2 = await buildAuthData({ cose, credId, signCount: 12, flagsExtra: 0 });
    const sig2 = new Uint8Array(await crypto.subtle.sign(algName, kp.privateKey,
      Buffer.concat([auth2, new Uint8Array(await crypto.subtle.digest('SHA-256', cd2))])));
    sig2[5] ^= 0xff;
    await assert.rejects(() => svc.finishLogin({
      sessionID: opts2.session_id,
      response: JSON.stringify({
        rawId: b64urlEncode(credId),
        response: {
          authenticatorData: b64urlEncode(auth2),
          clientDataJSON: b64urlEncode(cd2),
          signature: b64urlEncode(sig2),
          userHandle: b64urlEncode(new TextEncoder().encode(codec.encodeUserID(USER.id))),
        },
      }),
    }), `[${alg}] 坏签名应拒绝`);

    // 计数器回退（克隆检测）：重放 signCount=11
    const opts3 = await svc.prepareLogin();
    const cd3 = clientData('webauthn.get', opts3.options.publicKey.challenge);
    const auth3 = await buildAuthData({ cose, credId, signCount: 11, flagsExtra: 0 });
    const sig3 = new Uint8Array(await crypto.subtle.sign(algName, kp.privateKey,
      Buffer.concat([auth3, new Uint8Array(await crypto.subtle.digest('SHA-256', cd3))])));
    await assert.rejects(() => svc.finishLogin({
      sessionID: opts3.session_id,
      response: JSON.stringify({
        rawId: b64urlEncode(credId),
        response: {
          authenticatorData: b64urlEncode(auth3),
          clientDataJSON: b64urlEncode(cd3),
          signature: b64urlEncode(sig3),
          userHandle: b64urlEncode(new TextEncoder().encode(codec.encodeUserID(USER.id))),
        },
      }),
    }), `[${alg}] 计数器未递增应拒绝`);

    // userHandle 错误
    const opts4 = await svc.prepareLogin();
    const cd4 = clientData('webauthn.get', opts4.options.publicKey.challenge);
    const auth4 = await buildAuthData({ cose, credId, signCount: 13, flagsExtra: 0 });
    const sig4 = new Uint8Array(await crypto.subtle.sign(algName, kp.privateKey,
      Buffer.concat([auth4, new Uint8Array(await crypto.subtle.digest('SHA-256', cd4))])));
    await assert.rejects(() => svc.finishLogin({
      sessionID: opts4.session_id,
      response: JSON.stringify({
        rawId: b64urlEncode(credId),
        response: {
          authenticatorData: b64urlEncode(auth4),
          clientDataJSON: b64urlEncode(cd4),
          signature: b64urlEncode(sig4),
          userHandle: b64urlEncode(new TextEncoder().encode(codec.encodeUserID(999))),
        },
      }),
    }), `[${alg}] 未知 userHandle 应拒绝`);

    // 会话一次性
    await assert.rejects(() => svc.finishLogin({
      sessionID: opts4.session_id,
      response: '{"rawId":"AA"}',
    }), `[${alg}] 登录会话应销毁`);
  }

  // authn_enabled = false 时全链路拒绝
  const ctx2 = makeCtx();
  ctx2.settings.authnEnabled = false;
  const svc2 = new PasskeyService(ctx2, makeEnv(), new HashIDCodec('test-salt'));
  await assert.rejects(() => svc2.prepareLogin(), '开关关闭应拒绝 prepareLogin');
  await assert.rejects(() => svc2.prepareRegister(USER), '开关关闭应拒绝 prepareRegister');
}

// ---------------------------------------------------------------------------
// 4. 删除 / 列表
// ---------------------------------------------------------------------------
async function testManage() {
  console.log('--- 4. 列表与删除 ---');
  const env = makeEnv();
  const ctx = makeCtx();
  const codec = new HashIDCodec('test-salt');
  const svc = new PasskeyService(ctx, env, codec);

  const opts = await svc.prepareRegister(USER);
  const credId = crypto.getRandomValues(new Uint8Array(20));
  const { cose } = await coseKeyFor('ES256');
  const ad = await buildAuthData({ cose, credId, signCount: 0, flagsExtra: 0x40 });
  await svc.finishRegister(USER, {
    response: JSON.stringify({
      rawId: b64urlEncode(credId),
      response: {
        attestationObject: b64urlEncode(cborEnc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]))),
        clientDataJSON: b64urlEncode(clientData('webauthn.create', opts.publicKey.challenge)),
      },
    }),
    name: 'Key A',
  });

  const list = await svc.list(USER);
  check('列表 1 条', list.length === 1 && list[0].name === 'Key A' && list[0].id === toStd(credId));

  await svc.remove(USER, toStd(credId));
  check('删除后列表为空', (await svc.list(USER)).length === 0);
  await assert.rejects(() => svc.remove(USER, toStd(credId)), '删除不存在的凭据应 404');
}

(async () => {
  try {
    await testLib();
    await testRegister();
    await testLogin();
    await testManage();
  } catch (e) {
    fail += 1;
    console.error('UNEXPECTED:', e);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
