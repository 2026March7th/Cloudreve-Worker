/**
 * WebDAV 协议层测试用的**内存假文件系统**。
 *
 * 只在 `scripts/test-dav-protocol.mjs` 里通过 esbuild 的模块替换挂上去，
 * 不参与生产构建（生产用的是 `src/services/fs.ts`）。
 *
 * 存在的理由：WebDAV 的坑几乎全在 HTTP 契约上（状态码、`<D:href>` 形状、
 * 缺 Content-Length、覆盖判定），这些不依赖真实数据库就能验；而真库在
 * 新加坡，跑一次端到端太慢也没凭据。
 */
import { AppError, CodeFileNotFound, CodeObjectExist, CodeParentNotExist } from '../../src/lib/errors';
import { FileType } from '../../src/lib/boolset';

export interface FakeNode {
  id: number;
  name: string;
  type: number;
  size: number;
  primary_entity: number | null;
  /** 父目录 id；根与回收站项为 null（与真实 schema 一致） */
  file_children: number | null;
  updated_at: Date;
  owner_id: number;
  content: Uint8Array | null;
}

const nodes = new Map<string, FakeNode>();
let nextId = 1;

const FIXED_DATE = new Date('2026-01-01T00:00:00Z');

export function resetStore(): void {
  nodes.clear();
  nextId = 1;
  nodes.set('/', {
    id: 0,
    name: '',
    type: FileType.Folder,
    size: 0,
    primary_entity: null,
    file_children: null,
    updated_at: FIXED_DATE,
    owner_id: 1,
    content: null,
  });
}

resetStore();

export function byPath(path: string): FakeNode | null {
  return nodes.get(path) ?? null;
}

export function contentOf(path: string): Uint8Array | null {
  return nodes.get(path)?.content ?? null;
}

/** 按 `primary_entity` 找内容 —— 假驱动用它把 entity.source 映射回字节。 */
export function contentByEntityId(entityId: number): Uint8Array | null {
  for (const n of nodes.values()) {
    if (n.primary_entity === entityId) return n.content;
  }
  return null;
}

export function allPaths(): string[] {
  return [...nodes.keys()].sort();
}

function parentOf(path: string): string {
  if (path === '/') return '/';
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function childrenOf(dir: string): Array<[string, FakeNode]> {
  const out: Array<[string, FakeNode]> = [];
  for (const [p, n] of nodes) {
    if (p === '/') continue;
    if (parentOf(p) === dir) out.push([p, n]);
  }
  return out.sort((a, b) => a[1].name.localeCompare(b[1].name));
}

function insert(path: string, kind: 'file' | 'folder', size = 0, content: Uint8Array | null = null): FakeNode {
  const parent = nodes.get(parentOf(path));
  const node: FakeNode = {
    id: nextId++,
    name: path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1),
    type: kind === 'folder' ? FileType.Folder : FileType.File,
    size,
    primary_entity: kind === 'folder' ? null : nextId + 1000,
    file_children: parent ? parent.id : null,
    updated_at: FIXED_DATE,
    owner_id: 1,
    content,
  };
  nodes.set(path, node);
  return node;
}

/** 测试里造数据用。 */
export function seedFile(path: string, content = ''): FakeNode {
  return insert(path, 'file', content.length, new Uint8Array([...Buffer.from(content)]));
}

export function seedFolder(path: string): FakeNode {
  return insert(path, 'folder');
}

function removeTree(path: string): void {
  for (const key of [...nodes.keys()]) {
    if (key === path || key.startsWith(`${path}/`)) nodes.delete(key);
  }
}

export class FileSystemService {
  constructor(public readonly ctx: unknown) {}

  isRootFolder(file: FakeNode): boolean {
    return file.file_children === null && file.name === '';
  }

  async resolve(uri: { path: string }): Promise<FakeNode | null> {
    return byPath(uri.path);
  }

  async mustResolve(uri: { path: string }): Promise<FakeNode> {
    const hit = byPath(uri.path);
    if (!hit) throw new AppError(CodeFileNotFound, 'File not found');
    return hit;
  }

  async list(uri: { path: string }): Promise<{ files: FakeNode[] }> {
    return { files: childrenOf(uri.path).map(([, n]) => n) };
  }

  async create(
    uri: { path: string },
    kind: 'file' | 'folder',
    opts: { errOnConflict?: boolean } = {},
  ): Promise<FakeNode> {
    if (byPath(uri.path)) {
      if (opts.errOnConflict) throw new AppError(CodeObjectExist, 'Object existed');
      return byPath(uri.path)!;
    }
    const parent = byPath(parentOf(uri.path));
    if (!parent || parent.type !== FileType.Folder) {
      throw new AppError(CodeParentNotExist, 'Parent folder not found');
    }
    return insert(uri.path, kind);
  }

  async delete(uris: Array<{ path: string }>): Promise<void> {
    for (const uri of uris) {
      if (!byPath(uri.path)) throw new AppError(CodeFileNotFound, 'File not found');
      removeTree(uri.path);
    }
  }

  async rename(uri: { path: string }, newName: string): Promise<void> {
    const node = byPath(uri.path);
    if (!node) throw new AppError(CodeFileNotFound, 'File not found');
    const dst = joinPath(parentOf(uri.path), newName);
    if (dst !== uri.path && byPath(dst)) throw new AppError(CodeObjectExist, 'Object existed');
    removeTree(uri.path);
    insert(dst, node.type === FileType.Folder ? 'folder' : 'file', node.size, node.content);
    nodes.get(dst)!.updated_at = node.updated_at;
  }

  async moveOrCopy(
    uris: Array<{ path: string }>,
    targetParent: { path: string },
    copy: boolean,
    destName?: string,
  ): Promise<void> {
    for (const uri of uris) {
      const node = byPath(uri.path);
      if (!node) throw new AppError(CodeFileNotFound, 'File not found');
      const dst = joinPath(targetParent.path, destName ?? node.name);
      if (byPath(dst)) throw new AppError(CodeObjectExist, 'Object existed');
      insert(dst, node.type === FileType.Folder ? 'folder' : 'file', node.size, node.content);
      if (!copy) removeTree(uri.path);
    }
  }
}

export class UploadService {
  constructor(
    public readonly ctx: unknown,
    public readonly fs: unknown,
  ) {}

  async overwriteContent(
    uri: { path: string },
    body: ReadableStream,
    length: number,
    _contentType: string,
  ): Promise<void> {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    if (bytes.length !== length) {
      throw new AppError(CodeFileNotFound, `stream length ${bytes.length} != declared ${length}`);
    }
    let node = byPath(uri.path);
    if (!node) {
      const parent = byPath(parentOf(uri.path));
      if (!parent) throw new AppError(CodeParentNotExist, 'Parent folder not found');
      node = insert(uri.path, 'file');
    }
    node.content = bytes;
    node.size = bytes.length;
    node.updated_at = new Date();
  }
}
