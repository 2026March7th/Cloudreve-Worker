/**
 * 数据库行类型。列名与 `migrations/0001_init.sql` 一一对应。
 *
 * 数值列的声明与 `normalize*()` 的产物一致：Neon HTTP 驱动会把 BIGINT 以
 * **字符串**返回，`normalize*()` 里已统一过 `toNum()`，因此这里直接写 `number`。
 */

export type UserStatus = 'active' | 'inactive' | 'manual_banned' | 'sys_banned';
export type TaskStatus =
  | 'queued'
  | 'processing'
  | 'suspending'
  | 'error'
  | 'canceled'
  | 'completed';

export interface GroupRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  name: string;
  max_storage: number | null;
  speed_limit: number | null;
  permissions: Uint8Array;
  settings: GroupSetting | null;
  storage_policy_id: number | null;
}

export interface UserRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  email: string;
  nick: string;
  password: string | null;
  status: UserStatus;
  storage: number;
  two_factor_secret: string | null;
  avatar: string | null;
  settings: UserSetting | null;
  group_users: number;
}

export interface UserWithGroup extends UserRow {
  group: GroupRow;
}

export interface StoragePolicyRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  name: string;
  type: string;
  server: string | null;
  bucket_name: string | null;
  is_private: boolean | null;
  access_key: string | null;
  secret_key: string | null;
  max_size: number | null;
  dir_name_rule: string | null;
  file_name_rule: string | null;
  settings: PolicySetting | null;
  node_id: number | null;
}

export interface FileRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  type: number;
  name: string;
  owner_id: number;
  size: number;
  primary_entity: number | null;
  file_children: number | null;
  is_symbolic: boolean;
  props: FileProps | null;
  storage_policy_files: number | null;
}

export interface EntityRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  type: number;
  source: string;
  size: number;
  reference_count: number;
  storage_policy_entities: number;
  created_by: number | null;
  upload_session_id: string | null;
  recycle_options: EntityProps | null;
}

export interface ShareRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  password: string | null;
  views: number;
  downloads: number;
  expires: Date | null;
  remain_downloads: number | null;
  props: ShareProps | null;
  file_shares: number | null;
  user_shares: number | null;
}

export interface MetadataRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  name: string;
  value: string;
  file_id: number;
  is_public: boolean;
}

export interface DirectLinkRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  name: string;
  downloads: number;
  speed: number;
  file_id: number;
}

export interface SettingRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  name: string;
  value: string | null;
}

export interface TaskRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  type: string;
  status: TaskStatus;
  public_state: TaskPublicState;
  private_state: string | null;
  correlation_id: string | null;
  user_tasks: number | null;
}

// ---------------------------------------------------------------------------
// JSON 列的结构。字段名与 json tag 均取自 `inventory/types/types.go`。
// ---------------------------------------------------------------------------

export interface UserSetting {
  profile_off?: boolean;
  preferred_theme?: string;
  version_retention?: boolean;
  version_retention_ext?: string[];
  version_retention_max?: number;
  pined?: { uri: string; name?: string }[];
  email_language?: string;
  disable_view_sync?: boolean;
  fs_view_map?: Record<string, ExplorerView>;
  share_links_in_profile?: string;
}

export interface GroupSetting {
  compress_size?: number;
  decompress_size?: number;
  remote_download_options?: Record<string, unknown>;
  source_batch?: number;
  aria2_batch?: number;
  max_walked_files?: number;
  trash_retention?: number;
  redirected_source?: boolean;
}

export interface PolicySetting {
  token?: string;
  file_type?: string[];
  is_file_type_deny_list?: boolean;
  file_regexp?: string;
  is_name_regexp_deny_list?: boolean;
  od_redirect?: string;
  custom_proxy?: boolean;
  proxy_server?: string;
  internal_proxy?: boolean;
  /** OneDrive 的 drive 资源段，如 `me/drive` 或 `sites/<id>/drive` */
  od_driver?: string;
  region?: string;
  server_side_endpoint?: string;
  chunk_size?: number;
  tps_limit?: number;
  tps_limit_burst?: number;
  s3_path_style?: boolean;
  thumb_exts?: string[];
  thumb_support_all_exts?: boolean;
  thumb_max_size?: number;
  relay?: boolean;
  pre_allocate?: boolean;
  media_meta_exts?: string[];
  media_meta_generator_proxy?: boolean;
  thumb_generator_proxy?: boolean;
  native_media_processing?: boolean;
  s3_delete_batch_size?: number;
  stream_saver?: boolean;
  use_cname?: boolean;
  source_auth?: boolean;
  qiniu_upload_cdn?: boolean;
  chunk_concurrency?: number;
  encryption?: boolean;
}

export interface ExplorerView {
  page_size: number;
  order?: string;
  order_direction?: string;
  view?: string;
  thumbnail?: boolean;
  gallery_width?: number;
  columns?: { type: number; width?: number; props?: Record<string, unknown> }[];
}

export interface FileProps {
  view?: ExplorerView;
}

export interface ShareProps {
  share_view?: boolean;
  show_read_me?: boolean;
}

export interface EntityProps {
  unlink_only?: boolean;
  encrypt_metadata?: {
    algorithm: string;
    key: number[] | string;
    key_plain_text?: number[] | string;
    iv: number[] | string;
  };
}

export interface TaskPublicState {
  error?: string;
  error_history?: string[];
  executed_duration?: number;
  retry_count?: number;
  resume_time?: number;
  /**
   * 任务摘要。对应上游 `types.TaskPublicState.Summary`
   * （`inventory/types/types.go`），前端 `TaskSummary` 读的就是这个字段。
   */
  summary?: {
    phase?: string;
    props?: {
      src?: string;
      src_str?: string;
      dst?: string;
      src_multiple?: string[];
      dst_policy_id?: string;
      failed?: number;
      total?: number;
      /** 重建索引任务的进度游标 */
      indexed?: number;
      download?: unknown;
    };
  };
}
