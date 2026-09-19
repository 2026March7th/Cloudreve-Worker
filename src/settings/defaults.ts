/**
 * 站点设置默认值。
 *
 * 键名与默认值逐条取自 Cloudreve v4 的 `inventory/setting.go` →
 * `var DefaultSettings = map[string]string{...}`（不是 `pkg/setting/provider.go`，
 * 那里只是读取时的兜底值）。只保留边缘版实际会读取的项。
 *
 * 首次启动时 `ensureSettings()` 会把这些写入 settings 表；之后以数据库里的值为准。
 * 少数几项默认值与上游不同，都单独标注了原因。
 */

export const DEFAULT_SETTINGS: Record<string, string> = {
  // --- 站点基础 ---
  // 上游默认是 http://localhost:5212；边缘版留空，运行时回落到 Worker 变量 SITE_URL
  siteURL: '',
  siteName: 'Cloudreve',
  siteDes: 'Cloudreve',
  siteTitle: 'Cloud storage for everyone',
  siteScript: '',
  siteID: '', // 首次启动生成 UUID
  site_logo: '/static/img/logo.svg',
  site_logo_light: '/static/img/logo_light.svg',
  defaultTheme: '#1976d2',
  theme_options: JSON.stringify({
    '#1976d2': {
      light: {
        palette: {
          primary: { main: '#1976d2', light: '#42a5f5', dark: '#1565c0' },
          secondary: { main: '#9c27b0', light: '#ba68c8', dark: '#7b1fa2' },
        },
      },
      dark: {
        palette: {
          primary: { main: '#90caf9', light: '#e3f2fd', dark: '#42a5f5' },
          secondary: { main: '#ce93d8', light: '#f3e5f5', dark: '#ab47bc' },
        },
      },
    },
    '#3f51b5': {
      light: { palette: { primary: { main: '#3f51b5' }, secondary: { main: '#f50057' } } },
      dark: { palette: { primary: { main: '#9fa8da' }, secondary: { main: '#ff4081' } } },
    },
  }),
  maxEditSize: '52428800',
  custom_nav_items: '[]',
  // 自定义 HTML 注入点，对应 pkg/setting 的 CustomHTML
  headless_footer_html: '',
  headless_bottom_html: '',
  sidebar_bottom_html: '',
  // 法律文档链接，对应 LegalDocuments
  tos_url: '',
  privacy_policy_url: '',

  // --- 注册与登录 ---
  register_enabled: '1',
  email_active: '0',
  login_captcha: '0',
  reg_captcha: '0',
  forget_captcha: '0',
  // 上游默认是 1。边缘版没有 WebAuthn / Passkey 实现，开着会让前端显示无法使用的
  // 登录方式，因此默认关掉（管理员可在后台打开，但依然会返回「未启用」）。
  authn_enabled: '0',
  default_group: '2',
  captcha_type: '',
  captcha_ReCaptchaKey: '',
  captcha_cap_instance_url: '',
  captcha_cap_site_key: '',
  captcha_cap_asset_server: '',
  captcha_turnstile_site_key: '',

  // --- 密钥 ---
  secret_key: '', // 首次启动生成 256 位随机串
  hash_id_salt: '', // 首次启动生成 64 位随机串

  // --- 上传 ---
  upload_session_timeout: '86400',
  chunk_retries: '5',
  use_temp_chunk_buffer: '1',
  max_parallel_transfer: '4',

  // --- 分页与批量 ---
  max_page_size: '2000',
  max_batched_file: '3000',
  use_cursor_pagination: '1',
  max_recursive_searched_folder: '65535',

  // --- Token ---
  access_token_ttl: '3600',
  refresh_token_ttl: '1209600', // 2 weeks

  // --- 头像 ---
  avatar_size: '4194304',
  avatar_size_l: '200',
  gravatar_server: 'https://www.gravatar.com/',

  // --- 缩略图（边缘版不做服务端生成，这两项只影响 /site/config/explorer 上报的尺寸）---
  thumb_width: '400',
  thumb_height: '300',
  thumb_encode_method: 'png',
  thumb_encode_quality: '95',

  // --- 前端展示 ---
  explorer_icons: '[]',
  emojis: '{}',
  custom_props: '[]',
  file_viewers: '[]',
  viewer_default_apps: '{}',
  show_encryption_status: 'true',
  map_provider: 'openstreetmap',
  map_google_tile_type: 'roadmap',
  map_mapbox_ak: '',
  show_app_promotion: 'false',
  show_desktop_app_promotion: 'false',
  // 边缘版没有全文检索实现，固定关闭
  fts_enabled: 'false',

  // --- 其它 ---
  public_resource_maxage: '86400',
  entity_url_default_ttl: '3600',
  entity_url_cache_margin: '600',
  archive_timeout: '600',
};

/** 需要随机初始化、且一旦写库就不应再变的键。 */
export const GENERATED_SETTINGS = ['siteID', 'secret_key', 'hash_id_salt'] as const;
