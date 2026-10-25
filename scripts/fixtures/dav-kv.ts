/**
 * WebDAV 协议测试用的内存 KV（对齐 Workers KVNamespace 的用法子集）：
 * `get` / `put({expirationTtl, metadata})` / `delete` / `list({prefix, cursor})`。
 *
 * 只给 `lib/kvRouter` 的 `kvFor()` 用，测 LOCK / UNLOCK / 423。
 */
interface Entry {
  value: string;
  metadata?: unknown;
  expiresAt: number | null;
}

const store = new Map<string, Entry>();

export function resetKv(): void {
  store.clear();
}

export function kvSizes(): number {
  return store.size;
}

function live(key: string): Entry | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expiresAt !== null && hit.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return hit;
}

export const memoryKv = {
  async get(key: string): Promise<string | null> {
    return live(key)?.value ?? null;
  },
  async put(
    key: string,
    value: string,
    options: { expirationTtl?: number; metadata?: unknown } = {},
  ): Promise<void> {
    store.set(key, {
      value,
      metadata: options.metadata,
      expiresAt: options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null,
    });
  },
  async delete(key: string): Promise<void> {
    store.delete(key);
  },
  async list(options: { prefix?: string; cursor?: string } = {}): Promise<{
    keys: Array<{ name: string; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options.prefix ?? '';
    const keys = [...store.keys()]
      .filter((k) => k.startsWith(prefix) && live(k) !== null)
      .sort()
      .map((name) => ({ name, metadata: store.get(name)?.metadata }));
    return { keys, list_complete: true };
  },
};

/** 所有角色都指向同一个内存 KV —— 测试里只需要一个。 */
export function kvFor(): typeof memoryKv {
  return memoryKv;
}
