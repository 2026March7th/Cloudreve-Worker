/**
 * 文件系统变更事件总线（进程内）。
 *
 * 对应上游 `pkg/filemanager/eventhub`。上游有常驻进程 + 跨节点广播；
 * Workers 没有，只能做**同一 isolate 内**的发布订阅。对单实例边缘部署
 * 这已够用：同一时刻请求几乎总落在同一个 isolate 上，isolate 休眠后
 * 前端会重新订阅（SSE 断开重连本身是前端的标准行为）。
 *
 * 事件形状对齐上游 `eventhub.Event`：
 *   { type: 'create' | 'modify' | 'rename' | 'delete', file_id, from, to }
 * file_id 是 hashid 字符串（由发布方编码好）。
 */

export interface FsEvent {
  type: 'create' | 'modify' | 'rename' | 'delete';
  file_id: string;
  from: string;
  to: string;
}

type Listener = (event: FsEvent) => void;

/** 单个订阅者允许挂起的回调集合上限，防泄漏。 */
const MAX_CLIENTS_PER_TOPIC = 32;

const topics = new Map<number, Map<string, Set<Listener>>>();

export function subscribe(folderId: number, clientId: string, listener: Listener): () => void {
  let clients = topics.get(folderId);
  if (!clients) {
    clients = new Map();
    topics.set(folderId, clients);
  }
  let listeners = clients.get(clientId);
  if (!listeners) {
    if (clients.size >= MAX_CLIENTS_PER_TOPIC) {
      throw new Error('too many event subscribers on this folder');
    }
    listeners = new Set();
    clients.set(clientId, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) clients?.delete(clientId);
    if (clients && clients.size === 0) topics.delete(folderId);
  };
}

export function publish(folderId: number, event: FsEvent): void {
  const clients = topics.get(folderId);
  if (!clients) return;
  for (const listeners of clients.values()) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不影响其他订阅者
      }
    }
  }
}
