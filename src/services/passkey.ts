/**
 * Passkey（WebAuthn）服务：注册与发现式登录。
 *
 * 对应上游 `service/user/passkey.go`（go-webauthn）。加密协议在
 * `src/lib/webauthn.ts` 自实现；本文件只做会话编排：
 *
 *   注册  PUT  /api/v4/user/authn    生成创建选项，挑战暂存 KV `authn_session_{uid}`
 *         POST /api/v4/user/authn    验证 attestation，落库 passkeys
 *         DELETE /api/v4/user/authn?id=<credentialID>
 *   登录  PUT  /api/v4/session/authn 生成断言选项，挑战暂存 KV `authn_session_{uuid}`
 *         POST /api/v4/session/authn 验证断言，签发 token
 *
 * 会话 TTL 300 秒（上游同款）。
 *
 * 与上游的已知差异（都写在 README）：
 *   - attestation 语句不验签（见 webauthn.ts 头注释）；
 *   - 登录用「发现式凭据」（discoverable credential / resident key），
 *     注册时已强制 residentKey: required，与上游一致。
 */
import type { Env } from '../env';
import { kvFor } from '../lib/kvRouter';
import type { HashIDCodec } from '../lib/hashid';
import { AppError, CodeInternalSetting, CodeNotFound, CodeParamErr, CodeWebAuthnCredentialError } from '../lib/errors';
import {
  b64urlDecode,
  b64urlEncode,
  coseVerify,
  FLAG_UP,
  parseAttestationObject,
  parseAuthData,
  sha256,
  verifyClientData,
} from '../lib/webauthn';
import type { UserWithGroup } from '../db/types';
import type { PasskeyRow } from '../db/repo';
import { AppContext } from './context';

/** KV 会话内容。 */
interface AuthnSession {
  challenge: string;
  created: number;
}

const SESSION_TTL = 300; // 秒
const OPTIONS_TIMEOUT = 60000; // ms，go-webauthn 默认值

const LOGIN_SESSION_PREFIX = 'authn_session_';

function loginSessionKey(sessionID: string): string {
  return `${LOGIN_SESSION_PREFIX}${sessionID}`;
}

function registerSessionKey(uid: number): string {
  return `${LOGIN_SESSION_PREFIX}${uid}`;
}

export interface PasskeyResponse {
  id: string;
  name: string;
  created_at: string;
  used_at: string | null;
}

function buildPasskey(row: PasskeyRow): PasskeyResponse {
  return {
    id: row.credential_id,
    name: row.name,
    created_at: row.created_at.toISOString(),
    used_at: row.used_at ? row.used_at.toISOString() : null,
  };
}

/** 把凭据 ID（std base64）转成 b64url，供 publicKey 选项使用。 */
function credentialIdToUrlB64(stdB64: string): string {
  return b64urlEncode(Buffer.from(stdB64, 'base64'));
}

export class PasskeyService {
  constructor(
    private readonly ctx: AppContext,
    private readonly env: Env,
    private readonly codec: HashIDCodec,
  ) {}

  // -----------------------------------------------------------------------
  // 公共参数
  // -----------------------------------------------------------------------

  /** RPID = 站点 URL 的 host（上游 dependency.go:253）。 */
  private get rpID(): string {
    const url = this.ctx.settings.siteUrl;
    if (!url) {
      throw new AppError(CodeInternalSetting, 'Site URL is not configured, WebAuthn unavailable');
    }
    return new URL(url).hostname;
  }

  /** 允许的 origin 列表 = 站点 URL 去掉路径（上游 RPOrigins）。 */
  private get allowedOrigins(): string[] {
    const url = this.ctx.settings.siteUrl;
    if (!url) return [];
    const parsed = new URL(url);
    return [`${parsed.protocol}//${parsed.host}`];
  }

  private async putSession(key: string, session: AuthnSession): Promise<void> {
    await kvFor(this.env, 'session').put(key, JSON.stringify(session), { expirationTtl: SESSION_TTL });
  }

  private async takeSession(key: string): Promise<AuthnSession | null> {
    const raw = await kvFor(this.env, 'session').get(key);
    if (!raw) return null;
    await kvFor(this.env, 'session').delete(key);
    return JSON.parse(raw) as AuthnSession;
  }

  // -----------------------------------------------------------------------
  // 登录
  // -----------------------------------------------------------------------

  /** 生成登录断言选项（发现式登录，不指定用户）。 */
  async prepareLogin(): Promise<{ options: unknown; session_id: string }> {
    if (!this.ctx.settings.authnEnabled) {
      throw new AppError(CodeWebAuthnCredentialError, 'Passkey is not enabled');
    }
    const challenge = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const sessionID = crypto.randomUUID();
    await this.putSession(loginSessionKey(sessionID), { challenge, created: Date.now() });

    return {
      options: {
        publicKey: {
          challenge,
          timeout: OPTIONS_TIMEOUT,
          rpId: this.rpID,
          userVerification: 'preferred',
        },
      },
      session_id: sessionID,
    };
  }

  /** 校验登录断言，返回用户。签名 / 计数器 / rpIdHash / origin 全部校验。 */
  async finishLogin(args: { response: string; sessionID: string }): Promise<UserWithGroup> {
    if (!this.ctx.settings.authnEnabled) {
      throw new AppError(CodeWebAuthnCredentialError, 'Passkey is not enabled');
    }

    const session = await this.takeSession(loginSessionKey(args.sessionID));
    if (!session) throw new AppError(CodeNotFound, 'Session not found');

    let parsed: {
      rawId?: string;
      response?: { authenticatorData?: string; clientDataJSON?: string; signature?: string; userHandle?: string };
    };
    try {
      parsed = JSON.parse(args.response);
    } catch {
      throw new AppError(CodeParamErr, 'Failed to parse request');
    }
    const resp = parsed.response;
    if (!parsed.rawId || !resp?.authenticatorData || !resp?.clientDataJSON || !resp?.signature) {
      throw new AppError(CodeParamErr, 'Incomplete credential response');
    }

    const clientDataJSON = b64urlDecode(resp.clientDataJSON);
    await verifyClientData(clientDataJSON, 'webauthn.get', session.challenge, this.allowedOrigins);

    const authData = parseAuthData(b64urlDecode(resp.authenticatorData));
    if ((authData.flags & FLAG_UP) === 0) {
      throw new AppError(CodeWebAuthnCredentialError, 'User presence flag not set');
    }

    // rpIdHash 必须等于 SHA256(rpID)
    const expectedHash = await sha256(new TextEncoder().encode(this.rpID));
    if (Buffer.compare(Buffer.from(authData.rpIdHash), Buffer.from(expectedHash)) !== 0) {
      throw new AppError(CodeWebAuthnCredentialError, 'rpIdHash mismatch');
    }

    // userHandle 是 hashid 用户 ID 的 UTF-8 字节（上游 authnUser.WebAuthnID）
    if (!resp.userHandle) throw new AppError(CodeParamErr, 'Missing user handle');
    const userHashid = new TextDecoder().decode(b64urlDecode(resp.userHandle));
    const uid = this.codec.decodeUserID(userHashid);
    if (uid === null) throw new AppError(CodeWebAuthnCredentialError, 'Invalid user handle');
    const user = await this.ctx.users.byIdWithGroup(uid);
    if (!user || user.status !== 'active') {
      throw new AppError(CodeWebAuthnCredentialError, 'Failed to validate login');
    }

    // 找到被使用的凭据
    const credIdStd = Buffer.from(b64urlDecode(parsed.rawId)).toString('base64');
    const passkey = await this.ctx.passkeys.byCredentialId(user.id, credIdStd);
    if (!passkey) throw new AppError(CodeWebAuthnCredentialError, 'Failed to validate login');

    // 验签：authenticatorData || SHA256(clientDataJSON)
    const clientHash = await sha256(clientDataJSON);
    const authBytes = b64urlDecode(resp.authenticatorData);
    const signedData = new Uint8Array(authBytes.length + clientHash.length);
    signedData.set(authBytes, 0);
    signedData.set(clientHash, authBytes.length);

    const cose = Buffer.from(String(passkey.credential.publicKey ?? ''), 'base64');
    if (cose.length === 0) {
      throw new AppError(CodeInternalSetting, 'Stored credential has no public key');
    }
    let valid = false;
    try {
      valid = await coseVerify(
        new Uint8Array(cose),
        signedData,
        b64urlDecode(resp.signature),
      );
    } catch (e) {
      throw new AppError(CodeWebAuthnCredentialError, `Failed to validate login: ${(e as Error).message}`);
    }
    if (!valid) throw new AppError(CodeWebAuthnCredentialError, 'Signature verification failed');

    // 计数器：双方都为 0 时（部分 authenticator 永不递增）跳过；否则必须严格递增
    const prevCount = Number(passkey.credential.signCount ?? 0);
    if (authData.signCount !== 0 || prevCount !== 0) {
      if (authData.signCount <= prevCount) {
        throw new AppError(CodeWebAuthnCredentialError, 'Authenticator may be cloned (counter did not increase)');
      }
      await this.ctx.passkeys.updateCounter(user.id, credIdStd, authData.signCount);
    }
    await this.ctx.passkeys.markUsed(user.id, credIdStd);

    return user;
  }

  // -----------------------------------------------------------------------
  // 注册
  // -----------------------------------------------------------------------

  /** 生成注册创建选项（强制 resident key，排除已有凭据）。 */
  async prepareRegister(user: UserWithGroup): Promise<unknown> {
    if (!this.ctx.settings.authnEnabled) {
      throw new AppError(CodeWebAuthnCredentialError, 'Passkey is not enabled');
    }
    const existing = await this.ctx.passkeys.listByUser(user.id);
    const challenge = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    await this.putSession(registerSessionKey(user.id), { challenge, created: Date.now() });

    // WebAuthnID = hashid 用户 ID 字符串的 UTF-8 字节（上游 authnUser.WebAuthnID）
    const webAuthnID = b64urlEncode(new TextEncoder().encode(this.codec.encodeUserID(user.id)));

    return {
      publicKey: {
        rp: { name: this.ctx.settings.siteName, id: this.rpID },
        user: {
          id: webAuthnID,
          name: user.email,
          displayName: user.nick || user.email,
        },
        challenge,
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 }, // ES256
          { type: 'public-key', alg: -257 }, // RS256（Windows Hello）
          { type: 'public-key', alg: -8 }, // Ed25519
        ],
        timeout: OPTIONS_TIMEOUT,
        excludeCredentials: existing.map((k) => ({
          type: 'public-key',
          id: credentialIdToUrlB64(k.credential_id),
        })),
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'preferred',
        },
        attestation: 'none',
      },
    };
  }

  /** 校验 attestation，落库凭据。 */
  async finishRegister(
    user: UserWithGroup,
    args: { response: string; name: string },
  ): Promise<PasskeyResponse> {
    if (!this.ctx.settings.authnEnabled) {
      throw new AppError(CodeWebAuthnCredentialError, 'Passkey is not enabled');
    }

    const session = await this.takeSession(registerSessionKey(user.id));
    if (!session) throw new AppError(CodeNotFound, 'Session not found');

    let parsed: {
      rawId?: string;
      response?: { attestationObject?: string; clientDataJSON?: string };
    };
    try {
      parsed = JSON.parse(args.response);
    } catch {
      throw new AppError(CodeParamErr, 'Failed to parse request');
    }
    const resp = parsed.response;
    if (!parsed.rawId || !resp?.attestationObject || !resp?.clientDataJSON) {
      throw new AppError(CodeParamErr, 'Incomplete credential response');
    }

    const clientDataJSON = b64urlDecode(resp.clientDataJSON);
    await verifyClientData(clientDataJSON, 'webauthn.create', session.challenge, this.allowedOrigins);

    const { authData: authBytes } = parseAttestationObject(b64urlDecode(resp.attestationObject));
    const authData = parseAuthData(authBytes);
    if ((authData.flags & FLAG_UP) === 0 || !authData.credentialId || !authData.cosePublicKey) {
      throw new AppError(CodeWebAuthnCredentialError, 'Attestation does not contain a credential');
    }
    const expectedHash = await sha256(new TextEncoder().encode(this.rpID));
    if (Buffer.compare(Buffer.from(authData.rpIdHash), Buffer.from(expectedHash)) !== 0) {
      throw new AppError(CodeWebAuthnCredentialError, 'rpIdHash mismatch');
    }

    // rawId 与 attestation 里的凭据 ID 必须一致
    const credIdStd = Buffer.from(b64urlDecode(parsed.rawId)).toString('base64');
    const attestedStd = Buffer.from(authData.credentialId).toString('base64');
    if (credIdStd !== attestedStd) {
      throw new AppError(CodeWebAuthnCredentialError, 'rawId does not match attested credential');
    }

    const row = await this.ctx.passkeys.create({
      userId: user.id,
      credentialId: credIdStd,
      name: args.name || 'Passkey',
      credential: {
        id: credIdStd,
        publicKey: Buffer.from(authData.cosePublicKey).toString('base64'),
        signCount: authData.signCount,
        aaguid: authData.aaguid ? Buffer.from(authData.aaguid).toString('base64') : null,
      },
    });
    return buildPasskey(row);
  }

  /** 删除凭据。id 是凭据 ID（对齐上游 DeletePasskeyService）。 */
  async remove(user: UserWithGroup, credentialId: string): Promise<void> {
    const existing = await this.ctx.passkeys.byCredentialId(user.id, credentialId);
    if (!existing) throw new AppError(CodeNotFound, 'Passkey not found');
    await this.ctx.passkeys.remove(user.id, credentialId);
  }

  list(user: UserWithGroup): Promise<PasskeyResponse[]> {
    return this.ctx.passkeys.listByUser(user.id).then((rows) => rows.map(buildPasskey));
  }
}
