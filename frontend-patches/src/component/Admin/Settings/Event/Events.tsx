/**
 * 管理设置「事件」页（边缘版补丁，替换官方 Pro 壳）。
 *
 * 官方开源前端的 Events.tsx 是个 Pro 壳：所有复选框 `checked={false}`、
 * 点击弹 ProDialog。边缘版把审计日志做成了真功能（后端 services/audit.ts
 * + POST /api/v4/admin/audit/log），本组件保持官方版式，但把开关接通：
 *   - 事件开关持久化在设置键 `audit_log_events`（JSON map 事件名 → bool，
 *     缺省视为开启）；「全部勾选/取消」写整个 map；
 *   - 下方附一个审计日志查看器（官方 Pro 的查看器在别处，开源前端没有）。
 *
 * 事件枚举与官方 `api/explorer.ts` 的 AuditLogType 完全一致（0-61），
 * 后端 services/audit.ts 是它的镜像，两边名字/数值不能各自改动。
 */
import {
  Box,
  Checkbox,
  Chip,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  Grid,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useSnackbar } from "notistack";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AuditLogType } from "../../../../api/explorer.ts";
import {
  NoWrapCell,
  SecondaryButton,
  StyledTableContainerPaper,
} from "../../../Common/StyledComponents.tsx";
import TablePagination from "../../../Admin/Common/TablePagination.tsx";
import { NoMarginHelperText, SettingSection, SettingSectionContent } from "../Settings.tsx";
import { SettingContext } from "../SettingWrapper.tsx";

// ---------------------------------------------------------------------------
// 事件分类（照抄官方 Events.tsx 的 eventCategories）
// ---------------------------------------------------------------------------

export const eventCategories = {
  system: {
    title: "settings.systemEvents",
    description: "settings.systemEventsDes",
    events: [AuditLogType.server_start],
  },
  user: {
    title: "settings.userEvents",
    description: "settings.userEventsDes",
    events: [
      AuditLogType.user_signup,
      AuditLogType.user_activated,
      AuditLogType.user_login,
      AuditLogType.user_login_failed,
      AuditLogType.user_token_refresh,
      AuditLogType.user_changed,
      AuditLogType.user_exceed_quota_notified,
      AuditLogType.change_nick,
      AuditLogType.change_avatar,
      AuditLogType.change_password,
      AuditLogType.enable_2fa,
      AuditLogType.disable_2fa,
      AuditLogType.add_passkey,
      AuditLogType.remove_passkey,
      AuditLogType.link_account,
      AuditLogType.unlink_account,
      AuditLogType.report_abuse,
      AuditLogType.oauth_grant_create,
      AuditLogType.oauth_token_exchange,
      AuditLogType.oauth_grant_revoke,
    ],
  },
  file: {
    title: "settings.fileEvents",
    description: "settings.fileEventsDes",
    events: [
      AuditLogType.file_create,
      AuditLogType.file_imported,
      AuditLogType.file_rename,
      AuditLogType.set_file_permission,
      AuditLogType.entity_uploaded,
      AuditLogType.entity_downloaded,
      AuditLogType.copy_from,
      AuditLogType.copy_to,
      AuditLogType.move_to,
      AuditLogType.delete_file,
      AuditLogType.move_to_trash,
      AuditLogType.update_metadata,
      AuditLogType.get_direct_link,
      AuditLogType.delete_direct_link,
      AuditLogType.update_view,
    ],
  },
  share: {
    title: "settings.shareEvents",
    description: "settings.shareEventsDes",
    events: [AuditLogType.share, AuditLogType.share_link_viewed, AuditLogType.edit_share, AuditLogType.delete_share],
  },
  version: {
    title: "settings.versionEvents",
    description: "settings.versionEventsDes",
    events: [AuditLogType.set_current_version, AuditLogType.delete_version],
  },
  media: {
    title: "settings.mediaEvents",
    description: "settings.mediaEventsDes",
    events: [AuditLogType.thumb_generated, AuditLogType.live_photo_uploaded],
  },
  filesystem: {
    title: "settings.filesystemEvents",
    description: "settings.filesystemEventsDes",
    events: [AuditLogType.mount, AuditLogType.relocate, AuditLogType.create_archive, AuditLogType.extract_archive],
  },
  webdav: {
    title: "settings.webdavEvents",
    description: "settings.webdavEventsDes",
    events: [
      AuditLogType.webdav_login_failed,
      AuditLogType.webdav_account_create,
      AuditLogType.webdav_account_update,
      AuditLogType.webdav_account_delete,
    ],
  },
  payment: {
    title: "settings.paymentEvents",
    description: "settings.paymentEventsDes",
    events: [
      AuditLogType.payment_created,
      AuditLogType.points_change,
      AuditLogType.payment_paid,
      AuditLogType.payment_fulfilled,
      AuditLogType.payment_fulfill_failed,
      AuditLogType.storage_added,
      AuditLogType.group_changed,
      AuditLogType.membership_unsubscribe,
      AuditLogType.redeem_gift_code,
    ],
  },
  email: {
    title: "settings.emailEvents",
    description: "settings.emailEventsDes",
    events: [AuditLogType.email_sent],
  },
};

export const getEventName = (eventType: number): string =>
  Object.entries(AuditLogType).find(([_, value]) => value === eventType)?.[0] || `event_${eventType}`;

// ---------------------------------------------------------------------------
// API（与 VAS 补丁同款：原生 fetch + redux 会话 token）
// ---------------------------------------------------------------------------

interface AuditLogItem {
  id: number;
  created_at: string;
  user_id: number | null;
  type: number;
  meta: Record<string, unknown>;
}

interface AuditLogPage {
  audit_logs: AuditLogItem[];
  pagination: { page: number; page_size: number; total_items: number };
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const session = JSON.parse(localStorage.getItem("cloudreve_session") || "{}");
  const first = Object.values(session?.sessions ?? {})[0] as
    | { token?: { access_token?: string } }
    | undefined;
  const token = first?.token?.access_token ?? "";
  const res = await fetch("/api/v4" + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: "Bearer " + token,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (json.code !== undefined && json.code !== 0) throw new Error(json.msg || "request failed");
  return json.data as T;
}

const fmtTime = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

const Events = () => {
  const { t } = useTranslation("dashboard");
  const { enqueueSnackbar } = useSnackbar();
  const { formRef, values, setSettings } = useContext(SettingContext);

  // ---- 事件开关（audit_log_events：JSON map 事件名 → bool，缺省 = 开启）----
  const switches = useMemo(() => {
    try {
      const v: unknown = JSON.parse(values.audit_log_events || "{}");
      return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  }, [values.audit_log_events]);

  const enabled = useCallback(
    (eventType: number) => switches[getEventName(eventType)] !== false,
    [switches],
  );

  const writeSwitches = (next: Record<string, boolean>) => {
    setSettings({ audit_log_events: JSON.stringify(next) });
  };

  const toggleEvent = (eventType: number, on: boolean) => {
    writeSwitches({ ...switches, [getEventName(eventType)]: on });
  };

  const toggleCategory = (events: number[], on: boolean) => {
    const next = { ...switches };
    for (const e of events) next[getEventName(e)] = on;
    writeSwitches(next);
  };

  const allEvents = useMemo(() => Object.values(eventCategories).flatMap((c) => c.events), []);

  // ---- 审计日志查看器 ----
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0); // API 分页为 0 基
  const [pageSize] = useState(20);
  const [typeFilter, setTypeFilter] = useState<number | "">("");
  const [loading, setLoading] = useState(false);

  const loadLogs = useCallback(
    async (p: number, type: number | "") => {
      setLoading(true);
      try {
        const body: Record<string, unknown> = { page: p + 1, page_size: pageSize };
        if (type !== "") body.types = [type];
        const res = await api<AuditLogPage>("POST", "/admin/audit/log", body);
        setLogs(res.audit_logs ?? []);
        setTotal(res.pagination?.total_items ?? 0);
      } catch (e) {
        enqueueSnackbar(String((e as Error).message ?? e), { variant: "error" });
      } finally {
        setLoading(false);
      }
    },
    [enqueueSnackbar, pageSize],
  );

  useEffect(() => {
    loadLogs(page, typeFilter);
  }, [page, typeFilter, loadLogs]);

  return (
    <Box component={"form"} ref={formRef} onSubmit={(e) => e.preventDefault()}>
      <Stack spacing={5}>
        <SettingSection>
          <Typography variant="h6" sx={{ display: "flex", alignItems: "center" }}>
            {t("settings.auditLog")}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t("settings.auditLogDes")}
          </Typography>

          {Object.entries(eventCategories).map(([categoryKey, category]) => {
            const allOn = category.events.every((e) => enabled(e));
            return (
              <SettingSection key={categoryKey}>
                <Box>
                  <Typography variant="subtitle1">{t(category.title)}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t(category.description)}
                  </Typography>
                </Box>

                <SettingSectionContent>
                  <FormControl component="fieldset">
                    <FormGroup>
                      <FormControlLabel
                        slotProps={{ typography: { variant: "body2" } }}
                        control={
                          <Checkbox
                            size={"small"}
                            checked={allOn}
                            indeterminate={!allOn && category.events.some((e) => enabled(e))}
                            onChange={(e) => toggleCategory(category.events, e.target.checked)}
                          />
                        }
                        label={t("settings.toggleAll")}
                      />
                      <NoMarginHelperText>{t("settings.toggleAllDes")}</NoMarginHelperText>
                    </FormGroup>
                  </FormControl>
                  <Grid container spacing={1}>
                    {category.events.map((eventType) => (
                      <Grid item xs={12} sm={6} md={4} lg={3} key={eventType}>
                        <FormControlLabel
                          slotProps={{ typography: { variant: "body2" } }}
                          control={
                            <Checkbox
                              size={"small"}
                              checked={enabled(eventType)}
                              onChange={(e) => toggleEvent(eventType, e.target.checked)}
                            />
                          }
                          label={t(`settings.event.${getEventName(eventType)}`, getEventName(eventType))}
                        />
                      </Grid>
                    ))}
                  </Grid>
                </SettingSectionContent>
                <Divider sx={{ mt: 1 }} />
              </SettingSection>
            );
          })}
        </SettingSection>

        {/* ---------------- 审计日志查看器 ---------------- */}
        <SettingSection>
          <Typography variant="h6">{t("settings.auditLog")}</Typography>

          <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
            <FormControl size="small" sx={{ minWidth: 240 }}>
              <InputLabel>{t("settings.event") ?? "Event"}</InputLabel>
              <Select
                label={t("settings.event") ?? "Event"}
                value={typeFilter}
                onChange={(e) => {
                  setPage(0);
                  setTypeFilter(e.target.value === "" ? "" : Number(e.target.value));
                }}
              >
                <MenuItem value="">{t("settings.toggleAll")}</MenuItem>
                {Object.entries(eventCategories).flatMap(([ck, c]) =>
                  c.events.map((e) => (
                    <MenuItem key={`${ck}-${e}`} value={e}>
                      {t(`settings.event.${getEventName(e)}`, getEventName(e))}
                    </MenuItem>
                  )),
                )}
              </Select>
            </FormControl>
            <SecondaryButton variant="contained" onClick={() => loadLogs(page, typeFilter)} disabled={loading}>
              刷新
            </SecondaryButton>
          </Box>

          <TableContainer component={StyledTableContainerPaper}>
            <Table sx={{ width: "100%" }} size="small">
              <TableHead>
                <TableRow>
                  <NoWrapCell>时间</NoWrapCell>
                  <NoWrapCell>事件</NoWrapCell>
                  <NoWrapCell>用户 ID</NoWrapCell>
                  <NoWrapCell>详情</NoWrapCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {logs.length === 0 && (
                  <TableRow>
                    <NoWrapCell colSpan={4} align="center">
                      <Typography variant="caption" color="text.secondary">
                        {loading ? "..." : "暂无记录"}
                      </Typography>
                    </NoWrapCell>
                  </TableRow>
                )}
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <NoWrapCell>{fmtTime(log.created_at)}</NoWrapCell>
                    <NoWrapCell>
                      <Chip
                        size="small"
                        label={t(`settings.event.${getEventName(log.type)}`, getEventName(log.type))}
                        variant="outlined"
                      />
                    </NoWrapCell>
                    <NoWrapCell>{log.user_id ?? "-"}</NoWrapCell>
                    <TableCell>
                      <Typography variant="caption" sx={{ wordBreak: "break-all" }}>
                        {Object.keys(log.meta ?? {}).length ? JSON.stringify(log.meta) : "-"}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            page={page + 1}
            rowsPerPage={pageSize}
            totalItems={total}
            onChange={(_e, v) => setPage(Math.max(0, v - 1))}
          />
        </SettingSection>
      </Stack>
    </Box>
  );
};

export default Events;
