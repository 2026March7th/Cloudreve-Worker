import { Box, FormControl, FormControlLabel, Link, ListItemText, Stack, Switch, Typography } from "@mui/material";
import { useContext, useMemo } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { isTrueVal } from "../../../../session/utils.ts";
import SizeInput from "../../../Common/SizeInput.tsx";
import { DenseFilledTextField, DenseSelect } from "../../../Common/StyledComponents.tsx";
import { SquareMenuItem } from "../../../FileManager/ContextMenu/ContextMenu.tsx";
import SettingForm from "../../../Pages/Setting/SettingForm.tsx";
import { Code } from "../../../Common/Code.tsx";
import GroupSelectionInput from "../../Common/GroupSelectionInput.tsx";
import SharesInput from "../../Common/SharesInput.tsx";
import { NoMarginHelperText, SettingSection, SettingSectionContent } from "../Settings.tsx";
import { SettingContext } from "../SettingWrapper.tsx";
import SSOSettings from "./SSOSettings.tsx";

const UserSession = () => {
  const { t } = useTranslation("dashboard");
  const { formRef, setSettings, values } = useContext(SettingContext);

  const defaultSymbolics = useMemo(() => {
    let result: number[] = [];
    try {
      result = JSON.parse(values?.default_symbolics ?? "[]");
    } catch (e) {
      console.error(e);
    }
    return result;
  }, [values?.default_symbolics]);

  // 邮箱域过滤模式：0=不启用 1=白名单 2=黑名单
  const filterMode = useMemo(() => {
    const raw = parseInt(values?.filter_email_provider ?? "0", 10);
    return Number.isNaN(raw) ? 0 : raw;
  }, [values?.filter_email_provider]);

  return (
    <Box component={"form"} ref={formRef} onSubmit={(e) => e.preventDefault()}>
      <Stack spacing={5}>
        <SettingSection>
          <Typography variant="h6" gutterBottom>
            {t("settings.accountManagement")}
          </Typography>
          <SettingSectionContent>
            <SettingForm lgWidth={5}>
              <FormControl fullWidth>
                <FormControlLabel
                  control={
                    <Switch
                      checked={isTrueVal(values.register_enabled)}
                      onChange={(e) =>
                        setSettings({
                          register_enabled: e.target.checked ? "1" : "0",
                        })
                      }
                    />
                  }
                  label={t("settings.allowNewRegistrations")}
                />
                <NoMarginHelperText>{t("settings.allowNewRegistrationsDes")}</NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm lgWidth={5}>
              <FormControl fullWidth>
                <FormControlLabel
                  control={
                    <Switch
                      checked={isTrueVal(values.email_active)}
                      onChange={(e) =>
                        setSettings({
                          email_active: e.target.checked ? "1" : "0",
                        })
                      }
                    />
                  }
                  label={t("settings.emailActivation")}
                />
                <NoMarginHelperText>
                  <Trans
                    i18nKey="settings.emailActivationDes"
                    ns={"dashboard"}
                    components={[<Link href={"/admin/settings?tab=email"} />]}
                  />
                </NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm lgWidth={5}>
              <FormControl fullWidth>
                <FormControlLabel
                  control={
                    <Switch
                      checked={isTrueVal(values.authn_enabled)}
                      onChange={(e) =>
                        setSettings({
                          authn_enabled: e.target.checked ? "1" : "0",
                        })
                      }
                    />
                  }
                  label={t("settings.webauthn")}
                />
                <NoMarginHelperText>{t("settings.webauthnDes")}</NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm lgWidth={5}>
              <FormControl fullWidth>
                <FormControlLabel
                  control={
                    <Switch
                      checked={isTrueVal(values.expose_user_email)}
                      onChange={(e) =>
                        setSettings({
                          expose_user_email: e.target.checked ? "1" : "0",
                        })
                      }
                    />
                  }
                  label={t("settings.exposeUserEmail")}
                />
                <NoMarginHelperText>{t("settings.exposeUserEmailDes")}</NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title={t("settings.defaultGroup")} lgWidth={5}>
              <FormControl>
                <GroupSelectionInput
                  value={values.default_group}
                  onChange={(g) =>
                    setSettings({
                      default_group: g,
                    })
                  }
                />
                <NoMarginHelperText>{t("settings.defaultGroupDes")}</NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title={t("settings.defaultSymbolics")} lgWidth={5}>
              <FormControl>
                <SharesInput />
                <NoMarginHelperText>
                  <Trans
                    i18nKey="settings.defaultSymbolicsDes"
                    ns={"dashboard"}
                    components={[<Link component={RouterLink} to={"/admin/share"} />]}
                  />
                </NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title={t("vas.filterEmailProvider")} lgWidth={5}>
              <FormControl fullWidth>
                <DenseSelect
                  value={filterMode.toString()}
                  onChange={(e) => setSettings({ filter_email_provider: e.target.value as string })}
                >
                  {["filterEmailProviderDisabled", "filterEmailProviderWhitelist", "filterEmailProviderBlacklist"].map(
                    (v, i) => (
                      <SquareMenuItem value={i.toString()} key={v}>
                        <ListItemText
                          slotProps={{
                            primary: { variant: "body2" },
                          }}
                        >
                          {t(`vas.${v}`)}
                        </ListItemText>
                      </SquareMenuItem>
                    ),
                  )}
                </DenseSelect>
                <NoMarginHelperText>{t("vas.filterEmailProviderDes")}</NoMarginHelperText>
              </FormControl>
              {filterMode !== 0 && (
                <FormControl fullWidth sx={{ mt: 2 }}>
                  <DenseFilledTextField
                    value={values.filter_email_provider_rule ?? ""}
                    onChange={(e) => setSettings({ filter_email_provider_rule: e.target.value })}
                    placeholder="example.com,gmail.com"
                  />
                  <NoMarginHelperText>{t("vas.filterEmailProviderRuleDes")}</NoMarginHelperText>
                </FormControl>
              )}
            </SettingForm>
            <SettingForm lgWidth={5}>
              <FormControl fullWidth>
                <FormControlLabel
                  control={
                    <Switch
                      checked={isTrueVal(values.disable_sub_address_email)}
                      onChange={(e) =>
                        setSettings({
                          disable_sub_address_email: e.target.checked ? "1" : "0",
                        })
                      }
                    />
                  }
                  label={t("vas.disableSubAddressEmail")}
                />
                <NoMarginHelperText>
                  <Trans i18nKey="vas.disableSubAddressEmailDes" ns={"dashboard"} components={[<Code />]} />
                </NoMarginHelperText>
              </FormControl>
            </SettingForm>
          </SettingSectionContent>
        </SettingSection>
        <SettingSection>
          <Typography variant="h6" gutterBottom sx={{ display: "flex", alignItems: "center" }}>
            {t("settings.thirdPartySignIn")}
          </Typography>
          <SettingSectionContent>
            <SettingForm lgWidth={5}>
              <SSOSettings />
            </SettingForm>
          </SettingSectionContent>
        </SettingSection>
        <SettingSection>
          <Typography variant="h6" gutterBottom>
            {t("settings.avatar")}
          </Typography>
          <SettingSectionContent>
            <SettingForm title={t("settings.avatarFilePath")} lgWidth={5}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  value={values.avatar_path}
                  onChange={(e) =>
                    setSettings({
                      avatar_path: e.target.value,
                    })
                  }
                  required
                />
                <NoMarginHelperText>{t("settings.avatarFilePathDes")}</NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title={t("settings.avatarSize")} lgWidth={5}>
              <FormControl>
                <SizeInput
                  variant={"outlined"}
                  required
                  label={t("application:navbar.minimum")}
                  value={parseInt(values.avatar_size) ?? 0}
                  onChange={(e) =>
                    setSettings({
                      avatar_size: e.toString(),
                    })
                  }
                />
                <NoMarginHelperText>{t("settings.avatarSizeDes")}</NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title={t("settings.avatarImageSize")} lgWidth={5}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  value={values.avatar_size_l}
                  onChange={(e) =>
                    setSettings({
                      avatar_size_l: e.target.value,
                    })
                  }
                  type={"number"}
                  inputProps={{ step: 1, min: 1 }}
                  required
                />
                <NoMarginHelperText>{t("settings.avatarImageSizeDes")}</NoMarginHelperText>
              </FormControl>
            </SettingForm>
            <SettingForm title={t("settings.gravatarServer")} lgWidth={5}>
              <FormControl fullWidth>
                <DenseFilledTextField
                  value={values.gravatar_server}
                  onChange={(e) =>
                    setSettings({
                      gravatar_server: e.target.value,
                    })
                  }
                  required
                />
                <NoMarginHelperText>{t("settings.gravatarServerDes")}</NoMarginHelperText>
              </FormControl>
            </SettingForm>
          </SettingSectionContent>
        </SettingSection>
      </Stack>
    </Box>
  );
};

export default UserSession;
