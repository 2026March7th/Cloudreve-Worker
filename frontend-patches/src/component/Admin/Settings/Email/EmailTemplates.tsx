/**
 * 边缘版补丁：恢复官方原版的四个邮件模板，全部真实可编辑。
 *
 * 原版（cloudreve/frontend@19da0fe1）里「支付收据」与「存储配额超出」两个
 * 模板是 Pro 专属：点击只弹 ProDialog、编辑器永远打不开。之前边缘版把这
 * 两个条目直接删掉，与原版不一致。现在边缘版后端已真实实现这两封邮件：
 *   - 支付收据：订单履行成功后发送（src/services/payment.ts sendReceiptMail）
 *   - 配额超出：容量校验失败时发送，KV 限频 24h/用户（src/middleware/app.ts）
 * 所以这里按原版结构渲染全部四个模板，去掉 Pro 门槛，并给两个边缘版模板
 * 补上变量说明（标签用内联中文 —— 这些变量是边缘版语义，官方语言包里没有）。
 */
import { ExpandMoreRounded } from "@mui/icons-material";
import { Box, Typography } from "@mui/material";
import AccordionDetails from "@mui/material/AccordionDetails";
import React, { useContext } from "react";
import { useTranslation } from "react-i18next";
import SettingForm from "../../../Pages/Setting/SettingForm.tsx";
import { MagicVar } from "../../Common/MagicVarDialog.tsx";
import { SettingContext } from "../SettingWrapper.tsx";
import { SettingSection, SettingSectionContent } from "../Settings.tsx";
import { AccordionSummary, StyledAccordion } from "../UserSession/SSOSettings.tsx";
import EmailTemplateEditor from "./EmailTemplateEditor.tsx";

interface EmailTemplate {
  key: string;
  title: string;
  description: string;
  magicVars: MagicVar[];
}

const commonMagicVars: MagicVar[] = [
  {
    value: "settings.mainTitle",
    name: "{{ .CommonContext.SiteBasic.Name }}",
    example: "Cloudreve",
  },
  {
    value: "settings.siteDescription",
    name: "{{ .CommonContext.SiteBasic.Description }}",
    example: "Another Cloudreve instance",
  },
  {
    value: "settings.siteID",
    name: "{{ .CommonContext.SiteBasic.ID }}",
    example: "123e4567-e89b-12d3-a456-426614174000",
  },
  {
    value: "settings.logo",
    name: "{{ .CommonContext.Logo.Normal }}",
    example: "https://cloudreve.org/logo.svg",
  },
  {
    value: "settings.logo",
    name: "{{ .CommonContext.Logo.Light }}",
    example: "https://cloudreve.org/logo_light.svg",
  },
  {
    value: "settings.siteURL",
    name: "{{ .CommonContext.SiteUrl }}",
    example: "https://cloudreve.org",
  },
];

const userMagicVars: MagicVar[] = [
  {
    value: "policy.magicVar.uid",
    name: "{{ .User.ID }}",
    example: "2534",
  },
  {
    value: "application:login.email",
    name: "{{ .User.Email }}",
    example: "example@cloudreve.org",
  },
  {
    value: "application:setting.nickname",
    name: "{{ .User.Nick }}",
    example: "Aaron Liu",
  },
  {
    value: "user.usedStorage",
    name: "{{ .User.Storage }}",
    example: "123221000",
  },
];

/** 支付收据专属变量（边缘版语义：订单履行成功后发送）。 */
const orderMagicVars: MagicVar[] = [
  { value: "vas.orders", name: "{{ .Order.No }}", example: "2026092112345678" },
  { value: "settings.orderTitle", name: "{{ .Order.ProductName }}", example: "100GB 容量包" },
  { value: "vas.vas", name: "{{ .Order.ProductType }}", example: "storage" },
  { value: "vas.priceYuan", name: "{{ .Order.Amount }}", example: "9.90" },
  { value: "payment.tradeNo", name: "{{ .Order.TradeNo }}", example: "2026092122001400001" },
  { value: "vas.reportTime", name: "{{ .Order.PaidAt }}", example: "2026-09-21T12:34:56.000Z" },
];

const EmailTemplates: React.FC = () => {
  const { t } = useTranslation("dashboard");
  const { setSettings, values } = useContext(SettingContext);

  // Template setting keys —— 与官方原版一致的四个模板，Pro 门槛已移除
  const templateSettings: EmailTemplate[] = [
    {
      key: "mail_receipt_template",
      title: "receiptEmailTemplate",
      description: "receiptEmailTemplateDes",
      magicVars: [...commonMagicVars, ...userMagicVars, ...orderMagicVars],
    },
    {
      key: "mail_activation_template",
      title: "activationEmailTemplate",
      description: "activationEmailTemplateDes",
      magicVars: [
        ...commonMagicVars,
        ...userMagicVars,
        {
          value: "settings.activateUrl",
          name: "{{ .Url }}",
          example: "https://cloudreve.org/activate",
        },
      ],
    },
    {
      key: "mail_exceed_quota_template",
      title: "quotaExceededEmailTemplate",
      description: "quotaExceededEmailTemplateDes",
      magicVars: [...commonMagicVars, ...userMagicVars],
    },
    {
      key: "mail_reset_template",
      title: "resetPasswordEmailTemplate",
      description: "resetPasswordEmailTemplateDes",
      magicVars: [
        ...commonMagicVars,
        ...userMagicVars,
        {
          value: "settings.resetUrl",
          name: "{{ .Url }}",
          example: "https://cloudreve.org/reset",
        },
      ],
    },
  ];

  return (
    <SettingSection>
      <Typography variant="h6" gutterBottom>
        {t("settings.emailTemplates")}
      </Typography>
      <SettingSectionContent>
        <Box>
          {templateSettings.map((template) => (
            <StyledAccordion
              disableGutters
              key={template.key}
              TransitionProps={{ unmountOnExit: true }}
            >
              <AccordionSummary expandIcon={<ExpandMoreRounded />}>
                <Typography>{t("settings." + template.title)}</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ display: "block" }}>
                <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
                  {t("settings." + template.description)}{" "}
                </Typography>
                <SettingForm noContainer lgWidth={12}>
                  <Box sx={{ width: "100%" }}>
                    <EmailTemplateEditor
                      magicVars={template.magicVars || []}
                      value={values[template.key] || "[]"}
                      onChange={(value) => setSettings({ [template.key]: value })}
                      templateType={template.key}
                    />
                  </Box>
                </SettingForm>
              </AccordionDetails>
            </StyledAccordion>
          ))}
        </Box>
      </SettingSectionContent>
    </SettingSection>
  );
};

export default EmailTemplates;
