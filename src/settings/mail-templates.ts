/**
 * 邮件模板的出厂默认值。
 *
 * 上游把这两项写死在 `inventory/setting.go:356-357` 里，是两段 minified 的巨型
 * HTML（单行、数万字符），再按语言用 `util.Replace` 把 `[[ .ActiveTitle ]]` 一类
 * 的标记替换掉，最终存进 `mail_activation_template` / `mail_reset_template`。
 *
 * 边缘版不照抄那两段 HTML —— 它们把样式和文案死死绑在一起，改一次要动整行。
 * 这里改成等价语义但可读的模板：**占位符契约与上游完全一致**，
 * 所以管理员把上游的模板原样贴回后台设置，渲染结果也不会出错。
 *
 * 存储格式（与上游一致）：JSON 数组，每项 `{language, title, body}`。
 * 选模板的规则见 `src/services/mail.ts` 的 `selectTemplate()` —— 按用户语言匹配，
 * 匹配不到就用第一项。
 */

/** 可用占位符（与上游 `pkg/email/template.go` 的 `templateData()` 一一对应）。 */
export const MAIL_TEMPLATE_PLACEHOLDERS = [
  'CommonContext.SiteBasic.Name',
  'CommonContext.SiteBasic.Title',
  'CommonContext.SiteBasic.ID',
  'CommonContext.SiteBasic.Description',
  'CommonContext.SiteBasic.Script',
  'CommonContext.Logo.Normal',
  'CommonContext.Logo.Light',
  'CommonContext.SiteUrl',
  'User.ID',
  'User.Email',
  'User.Nick',
  'User.CreatedAt',
  'Url',
] as const;

interface MailTemplateEntry {
  language: string;
  title: string;
  body: string;
}

/** 一段共用的骨架样式，避免两个模板各写一遍。 */
function body(opts: {
  lang: string;
  heading: string;
  description: string;
  button: string;
  autoSend: string;
}): string {
  return [
    `<html lang="${opts.lang}">`,
    '<body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#1f2329;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;">',
    '<tr><td style="padding:32px 32px 8px 32px;">',
    '<img src="{{ .CommonContext.Logo.Normal }}" alt="{{ .CommonContext.SiteBasic.Name }}" style="height:36px;">',
    '</td></tr>',
    '<tr><td style="padding:8px 32px 0 32px;">',
    `<h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.4;">${opts.heading}</h1>`,
    `<p style="margin:0 0 8px 0;font-size:14px;line-height:1.7;color:#4e5969;">${opts.description}</p>`,
    '</td></tr>',
    '<tr><td style="padding:16px 32px 24px 32px;">',
    `<a href="{{ .Url }}" style="display:inline-block;padding:10px 22px;border-radius:6px;background:#1976d2;color:#ffffff;font-size:14px;text-decoration:none;">${opts.button}</a>`,
    '</td></tr>',
    '<tr><td style="padding:0 32px 32px 32px;border-top:1px solid #e5e6eb;">',
    `<p style="margin:16px 0 0 0;font-size:12px;line-height:1.7;color:#86909c;">${opts.autoSend}<br>`,
    '<a href="{{ .CommonContext.SiteUrl }}" style="color:#86909c;">{{ .CommonContext.SiteBasic.Name }}</a>',
    '</p></td></tr>',
    '</table>',
    '</body></html>',
  ].join('');
}

/** 一种语言的文案。字符串与上游 `inventory/setting.go:373-484` 逐字一致。 */
interface Wording {
  language: string;
  autoSend: string;
  activeTitle: string;
  activeDes: string;
  activeButton: string;
  resetTitle: string;
  resetDes: string;
  resetButton: string;
}

/**
 * 上游出厂模板覆盖的全部语言（11 种）。顺序即「匹配不到就取第一项」的兜底顺序，
 * 所以 en-US 必须在最前 —— 别重排。
 */
const WORDINGS: Wording[] = [
  {
    language: 'en-US',
    autoSend: 'This email is sent automatically.',
    activeTitle: 'Confirm your account',
    activeDes:
      'Please click the button below to confirm your email address and finish setting up your account. This link is valid for 24 hours.',
    activeButton: 'Confirm',
    resetTitle: 'Reset your password',
    resetDes:
      'Please click the button below to reset your password. This link is valid for 1 hour.',
    resetButton: 'Reset',
  },
  {
    language: 'zh-CN',
    autoSend: '此邮件由系统自动发送。',
    activeTitle: '激活你的账号',
    activeDes: '请点击下方按钮确认你的电子邮箱并完成账号注册，此链接有效期为 24 小时。',
    activeButton: '确认激活',
    resetTitle: '重设密码',
    resetDes: '请点击下方按钮重设你的密码，此链接有效期为 1 小时。',
    resetButton: '重设密码',
  },
  {
    language: 'zh-TW',
    autoSend: '此郵件由系統自動發送。',
    activeTitle: '激活你的帳號',
    activeDes: '請點擊下方按鈕確認你的電子郵箱並完成帳號註冊，此連結有效期為 24 小時。',
    activeButton: '確認激活',
    resetTitle: '重設密碼',
    resetDes: '請點擊下方按鈕重設你的密碼，此連結有效期為 1 小時。',
    resetButton: '重設密碼',
  },
  {
    language: 'de-DE',
    autoSend: 'Diese E-Mail wird automatisch vom System gesendet.',
    activeTitle: 'Bestätigen Sie Ihr Konto',
    activeDes:
      'Bitte klicken Sie auf die Schaltfläche unten, um Ihre E-Mail-Adresse zu bestätigen und Ihr Konto einzurichten. Dieser Link ist 24 Stunden lang gültig.',
    activeButton: 'Bestätigen',
    resetTitle: 'Passwort zurücksetzen',
    resetDes:
      'Bitte klicken Sie auf die Schaltfläche unten, um Ihr Passwort zurückzusetzen. Dieser Link ist 1 Stunde lang gültig.',
    resetButton: 'Passwort zurücksetzen',
  },
  {
    language: 'es-ES',
    autoSend: 'Este correo electrónico se envía automáticamente.',
    activeTitle: 'Confirma tu cuenta',
    activeDes:
      'Por favor, haz clic en el botón de abajo para confirmar tu dirección de correo electrónico y completar la configuración de tu cuenta. Este enlace es válido por 24 horas.',
    activeButton: 'Confirmar',
    resetTitle: 'Restablecer tu contraseña',
    resetDes:
      'Por favor, haz clic en el botón de abajo para restablecer tu contraseña. Este enlace es válido por 1 hora.',
    resetButton: 'Restablecer',
  },
  {
    language: 'fr-FR',
    autoSend: 'Cet e-mail est envoyé automatiquement.',
    activeTitle: 'Confirmer votre compte',
    activeDes:
      'Veuillez cliquer sur le bouton ci-dessous pour confirmer votre adresse e-mail et terminer la configuration de votre compte. Ce lien est valable 24 heures.',
    activeButton: 'Confirmer',
    resetTitle: 'Réinitialiser votre mot de passe',
    resetDes:
      'Veuillez cliquer sur le bouton ci-dessous pour réinitialiser votre mot de passe. Ce lien est valable 1 heure.',
    resetButton: 'Réinitialiser',
  },
  {
    language: 'it-IT',
    autoSend: 'Questa email è inviata automaticamente.',
    activeTitle: 'Conferma il tuo account',
    activeDes:
      'Per favore, clicca sul pulsante qui sotto per confermare il tuo indirizzo email e completare la configurazione del tuo account. Questo link è valido per 24 ore.',
    activeButton: 'Conferma',
    resetTitle: 'Reimposta la tua password',
    resetDes:
      'Per favore, clicca sul pulsante qui sotto per reimpostare la tua password. Questo link è valido per 1 ora.',
    resetButton: 'Reimposta',
  },
  {
    language: 'ja-JP',
    autoSend: 'このメールはシステムによって自動的に送信されました。',
    activeTitle: 'アカウントを確認する',
    activeDes:
      'アカウントの設定を完了するために、以下のボタンをクリックしてメールアドレスを確認してください。このリンクは24時間有効です。',
    activeButton: '確認する',
    resetTitle: 'パスワードをリセットする',
    resetDes:
      '以下のボタンをクリックしてパスワードをリセットしてください。このリンクは1時間有効です。',
    resetButton: 'リセットする',
  },
  {
    language: 'ko-KR',
    autoSend: '이 이메일은 시스템에 의해 자동으로 전송됩니다.',
    activeTitle: '계정 확인',
    activeDes:
      '아래 버튼을 클릭하여 이메일 주소를 확인하고 계정을 설정하세요. 이 링크는 24시간 동안 유효합니다.',
    activeButton: '확인',
    resetTitle: '비밀번호 재설정',
    resetDes: '아래 버튼을 클릭하여 비밀번호를 재설정하세요. 이 링크는 1시간 동안 유효합니다.',
    resetButton: '비밀번호 재설정',
  },
  {
    language: 'pt-BR',
    autoSend: 'Este e-mail é enviado automaticamente.',
    activeTitle: 'Confirme sua conta',
    activeDes:
      'Por favor, clique no botão abaixo para confirmar seu endereço de e-mail e concluir a configuração da sua conta. Este link é válido por 24 horas.',
    activeButton: 'Confirmar',
    resetTitle: 'Redefinir sua senha',
    resetDes:
      'Por favor, clique no botão abaixo para redefinir sua senha. Este link é válido por 1 hora.',
    resetButton: 'Redefinir',
  },
  {
    language: 'ru-RU',
    autoSend: 'Это письмо отправлено автоматически.',
    activeTitle: 'Подтвердите вашу учетную запись',
    activeDes:
      'Пожалуйста, нажмите кнопку ниже, чтобы подтвердить ваш адрес электронной почты и завершить настройку вашей учетной записи. Эта ссылка действительна в течение 24 часов.',
    activeButton: 'Подтвердить',
    resetTitle: 'Сбросить ваш пароль',
    resetDes:
      'Пожалуйста, нажмите кнопку ниже, чтобы сбросить ваш пароль. Эта ссылка действительна в течение 1 часа.',
    resetButton: 'Сбросить пароль',
  },
];

/** 标题的包装格式取自上游：`[{{ .CommonContext.SiteBasic.Name }}] <标题>`。 */
const TITLE_PREFIX = '[{{ .CommonContext.SiteBasic.Name }}] ';

export const DEFAULT_MAIL_TEMPLATES: {
  activation: MailTemplateEntry[];
  reset: MailTemplateEntry[];
} = {
  activation: WORDINGS.map((w) => ({
    language: w.language,
    title: TITLE_PREFIX + w.activeTitle,
    body: body({
      lang: w.language,
      heading: w.activeTitle,
      description: w.activeDes,
      button: w.activeButton,
      autoSend: w.autoSend,
    }),
  })),
  reset: WORDINGS.map((w) => ({
    language: w.language,
    title: TITLE_PREFIX + w.resetTitle,
    body: body({
      lang: w.language,
      heading: w.resetTitle,
      description: w.resetDes,
      button: w.resetButton,
      autoSend: w.autoSend,
    }),
  })),
};
