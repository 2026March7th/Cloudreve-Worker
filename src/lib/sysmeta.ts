/**
 * 系统元数据键。命名与 `pkg/filemanager/fs/dbfs/file.go` 的常量逐字一致。
 *
 * 回收站的表示方式（回源码核对 `inventory/file.go` 的 `SoftDelete`）：
 *   - 软删除 = `files.name` 改成随机 UUID + `file_children` 置 NULL；
 *   - 原始路径写进元数据 `sys:restore_uri`，回收站列表里的**显示名**取自它的
 *     最后一段（`File.DisplayName()`），恢复时也靠它定位原目录；
 *   - `sys:expected_collect_time` 是到期自动清理的秒级时间戳。
 *
 * 注意 `UpsertMetadata` 的 privateMask 传 nil 时 `is_public = true`，
 * 所以这两个键都是**公开**元数据 —— 列表接口只加载公开元数据，靠这点才能读到。
 */

export const MetadataSysPrefix = 'sys:';
export const MetadataRestoreUri = `${MetadataSysPrefix}restore_uri`;
export const MetadataExpectedCollectTime = `${MetadataSysPrefix}expected_collect_time`;
export const MetadataSharedRedirect = `${MetadataSysPrefix}shared_redirect`;
export const MetadataSharedOwner = `${MetadataSysPrefix}shared_owner`;
export const MetadataUploadSessionPrefix = `${MetadataSysPrefix}upload_session`;
export const MetadataUploadSessionID = `${MetadataUploadSessionPrefix}_id`;
