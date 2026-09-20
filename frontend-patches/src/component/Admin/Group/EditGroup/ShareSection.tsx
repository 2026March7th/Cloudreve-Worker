// [edge patch] 分享权限区块。
// 改动：移除官方 Pro 假开关（shareFree「无需购买分享链接」、esclateAnonymity
// 「提升匿名用户权限」——上游写死 checked={false} 且无 onChange，纯 Pro 展示位，
// 社区/边缘版无对应能力，显示出来只会让管理员误以为功能损坏）。
import { FormControl, FormControlLabel, Switch, Typography } from "@mui/material";
import { useCallback, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { GroupEnt } from "../../../../api/dashboard";
import { GroupPermission } from "../../../../api/user";
import Boolset from "../../../../util/boolset";
import SettingForm from "../../../Pages/Setting/SettingForm";
import { NoMarginHelperText, SettingSection, SettingSectionContent } from "../../Settings/Settings";
import { GroupSettingContext } from "./GroupSettingWrapper";

const ShareSection = () => {
  const { t } = useTranslation("dashboard");
  const { values, setGroup } = useContext(GroupSettingContext);

  const permission = useMemo(() => {
    return new Boolset(values.permissions ?? "");
  }, [values.permissions]);

  const onAllowCreateShareLinkChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setGroup((p: GroupEnt) => ({
        ...p,
        permissions: new Boolset(p.permissions).set(GroupPermission.share, e.target.checked).toString(),
      }));
    },
    [setGroup],
  );

  const onShareDownloadChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setGroup((p: GroupEnt) => ({
        ...p,
        permissions: new Boolset(p.permissions).set(GroupPermission.share_download, e.target.checked).toString(),
      }));
    },
    [setGroup],
  );

  return (
    <SettingSection>
      <Typography variant="h6" gutterBottom>
        {t("group.share")}
      </Typography>
      <SettingSectionContent>
        {values?.id != 0 && (
          <SettingForm lgWidth={5}>
            <FormControl fullWidth>
              <FormControlLabel
                control={
                  <Switch checked={permission.enabled(GroupPermission.share)} onChange={onAllowCreateShareLinkChange} />
                }
                label={t("group.allowCreateShareLink")}
              />
              <NoMarginHelperText>{t("group.allowCreateShareLinkDes")}</NoMarginHelperText>
            </FormControl>
          </SettingForm>
        )}
        <SettingForm lgWidth={5}>
          <FormControl fullWidth>
            <FormControlLabel
              control={
                <Switch
                  checked={permission.enabled(GroupPermission.share_download)}
                  onChange={onShareDownloadChange}
                />
              }
              label={t("group.allowDownloadShare")}
            />
            <NoMarginHelperText>{t("group.allowDownloadShareDes")}</NoMarginHelperText>
          </FormControl>
        </SettingForm>
      </SettingSectionContent>
    </SettingSection>
  );
};

export default ShareSection;
