/**
 * WebDAV 协议测试用的假上下文（`AppContext` / `ctxOf` / `permissionsOf`）。
 *
 * 只实现 `routes/dav.ts` 真正用到的几个成员：账号查表、用户+组、实体/策略、
 * 存储驱动。组权限给成「全开」，账号选项给成全 0（非只读）。
 */
import { BooleanSet } from '../../src/lib/boolset';
import { contentByEntityId } from './dav-store';

export const DAV_ACCOUNT = {
  name: 'davuser',
  password: 'davpass',
  uri: 'cloudreve://my',
  owner_id: 1,
  /** 全 0 = 未设任何选项位（非只读） */
  options: new Uint8Array(8),
};

/**
 * 中文账号名 + 非 ASCII 密码。
 *
 * 钉住 Basic 凭据的 UTF-8 解码：`atob` 出来的字符串是 latin1，不转码就查不到
 * 这个账号 —— 线上表现正是「MT管理器 / ES 文件浏览器一直 401，
 * 换个纯英文账号就正常」。
 */
export const DAV_ACCOUNT_I18N = {
  ...DAV_ACCOUNT,
  name: '测试账号',
  password: 'pässwörd-密码',
};

/** 未启用 WebDAV 权限的组，用来测 403 分支。 */export function groupWithoutDav() {
  return { id: 2, name: 'no-dav', permissions: new Uint8Array(8) };
}

const FULL_PERMISSIONS = new Uint8Array(8).fill(0xff);

export function permissionsOf(group: { permissions?: Uint8Array }): BooleanSet {
  return new BooleanSet(group?.permissions ?? new Uint8Array(8));
}

export function ctxOf(c: { get: (k: string) => unknown }): AppContext {
  return c.get('ctx') as AppContext;
}

interface Options {
  /** 账号在库里是否存在（测 401） */
  accountValid?: boolean;
  /** 组的 WebDAV 权限是否开启（测 403） */
  davPermission?: boolean;
}

export class AppContext {
  user: unknown;

  readonly davAccounts = {
    byNameAndPassword: async (name: string, password: string) => {
      if (this.opts.accountValid === false) return null;
      if (name === DAV_ACCOUNT_I18N.name && password === DAV_ACCOUNT_I18N.password) {
        return { account: DAV_ACCOUNT_I18N };
      }
      if (name !== DAV_ACCOUNT.name || password !== DAV_ACCOUNT.password) return null;
      return { account: DAV_ACCOUNT };
    },
  };

  readonly users = {
    byIdWithGroup: async () => ({
      id: 1,
      email: 'dav@example.com',
      nick: 'DAV User',
      group_users: 1,
      settings: {},
      group: {
        id: 1,
        name: 'admin',
        permissions: this.opts.davPermission === false ? new Uint8Array(8) : FULL_PERMISSIONS,
      },
    }),
  };

  readonly entities = {
    byId: async (id: number) => ({
      id,
      source: String(id),
      storage_policy_entities: 1,
    }),
  };

  readonly policies = {
    byId: async () => ({ id: 1, type: 's3', name: 'fake', settings: {} }),
  };

  constructor(
    public readonly env: unknown,
    public readonly settings: unknown,
    public readonly codec: unknown,
    public readonly jwt: unknown,
    user: unknown,
    private readonly opts: Options = {},
  ) {
    this.user = user;
  }

  driverFor(): {
    get: (
      source: string,
      range: string | null,
    ) => Promise<{ body: ReadableStream; size: number; contentType?: string; contentRange?: string } | null>;
  } {
    return {
      get: async (source, range) => {
        const bytes = contentByEntityId(Number(source));
        if (!bytes) return null;
        const total = bytes.length;
        const m = /bytes=(\d*)-(\d*)/.exec(range ?? '');
        if (!m) {
          return {
            body: new Response(bytes).body as ReadableStream,
            size: total,
            contentType: 'application/octet-stream',
          };
        }
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        const slice = bytes.slice(start, end + 1);
        return {
          body: new Response(slice).body as ReadableStream,
          size: total,
          contentType: 'application/octet-stream',
          contentRange: `bytes ${start}-${end}/${total}`,
        };
      },
    };
  }
}
