import { Env } from './types';

/**
 * Common disposable / burner / temporary email domains blocked at registration
 * to protect daily transactional email sending quota.
 */
const DISPOSABLE_EMAIL_DOMAINS = new Set<string>([
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  'bccto.me',
  'burnermail.io',
  'chacuo.net',
  'cock.li',
  'discard.email',
  'discardmail.com',
  'dispostable.com',
  'emailondeck.com',
  'fakeinbox.com',
  'fakemailgenerator.com',
  'getairmail.com',
  'getnada.com',
  'grr.la',
  'guerrillamail.biz',
  'guerrillamail.com',
  'guerrillamail.de',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'harakirimail.com',
  'inboxbear.com',
  'jetable.org',
  'linshi-email.com',
  'linshiyouxiang.net',
  'mailcatch.com',
  'maildrop.cc',
  'mailexpire.com',
  'mailforspam.com',
  'mailinator.com',
  'mailinator.net',
  'mailnesia.com',
  'mailnull.com',
  'mailsac.com',
  'mintemail.com',
  'mohmal.com',
  'moakt.com',
  'mytemp.email',
  'nada.email',
  'owlymail.com',
  'pokemail.net',
  'sharklasers.com',
  'spam4.me',
  'spamgourmet.com',
  'temp-mail.io',
  'temp-mail.org',
  'tempail.com',
  'tempinbox.com',
  'tempmail.cn',
  'tempmail.com',
  'tempmail.dev',
  'tempmail.net',
  'tempmail.org',
  'tempmail.plus',
  'tempmailo.com',
  'throwawaymail.com',
  'tmpmail.net',
  'tmpmail.org',
  'trashmail.com',
  'trashmail.me',
  'trashmail.net',
  'wegwerfmail.de',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
]);

const EMAIL_REGEX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeEmail(raw: string): string {
  return String(raw || '').trim().toLowerCase();
}

export function validateEmailAddress(raw: string): { valid: boolean; email: string; error?: string } {
  const email = normalizeEmail(raw);
  if (!email) {
    return { valid: false, email: '', error: '请输入邮箱地址' };
  }
  if (email.length > 128 || !EMAIL_REGEX.test(email)) {
    return { valid: false, email, error: '邮箱地址格式不正确，请核对后重试' };
  }
  const atIndex = email.lastIndexOf('@');
  const domain = email.slice(atIndex + 1);
  if (!domain || !domain.includes('.')) {
    return { valid: false, email, error: '邮箱域名无效' };
  }
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    return { valid: false, email, error: '不支持使用一次性临时邮箱注册，请使用常用邮箱（如 QQ、163、Gmail、Outlook 或校园邮箱）' };
  }
  for (const blocked of DISPOSABLE_EMAIL_DOMAINS) {
    if (domain.endsWith(`.${blocked}`)) {
      return { valid: false, email, error: '不支持使用一次性临时邮箱注册，请更换常用邮箱' };
    }
  }
  return { valid: true, email };
}

export interface SendEmailResult {
  ok: boolean;
  mode: 'resend' | 'dev_console' | 'unconfigured' | 'error';
  error?: string;
}

function buildVerificationEmailHtml(code: string, purpose: 'register' | 'reset_password'): { subject: string; html: string; text: string } {
  const isRegister = purpose === 'register';
  const actionLabel = isRegister ? '注册 OnlyArabics 账号' : '重置 OnlyArabics 登录密码';
  const subject = isRegister
    ? `【OnlyArabics 只有阿语】注册验证码：${code}`
    : `【OnlyArabics 只有阿语】重置密码验证码：${code}`;

  const text = [
    `您好！`,
    `您正在${actionLabel}。`,
    `您的 6 位数字验证码为：${code}`,
    `该验证码将在 10 分钟后失效，请勿向他人泄露。如非本人操作，请忽略本邮件。`,
    `—— OnlyArabics 只有阿语 (onlyaras.cn)`,
  ].join('\n\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${subject}</title>
</head>
<body style="margin:0;padding:24px 12px;background-color:#f7f4ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#292524;">
  <div style="max-width:460px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:24px;padding:32px 28px;box-shadow:0 8px 28px rgba(41,37,36,0.06);">
    <div style="text-align:center;margin-bottom:24px;">
      <img src="https://onlyaras.cn/images/logo-email.png" width="56" height="56" alt="ع" style="display:inline-block;width:56px;height:56px;border:0;border-radius:14px;background:#1f1a16;color:#fbbf6a;font-size:28px;font-weight:700;line-height:56px;text-align:center;" />
      <h1 style="margin:12px 0 4px;font-size:20px;font-weight:800;color:#1c1917;letter-spacing:-0.01em;">OnlyArabics · 只有阿语</h1>
      <p style="margin:0;font-size:13px;color:#78716c;">纯净的阿拉伯语背单词网站</p>
    </div>

    <p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#44403c;">您好，您正在<strong>${actionLabel}</strong>，请在页面中输入以下 6 位数字验证码：</p>

    <div style="margin:20px 0;padding:18px 16px;border-radius:16px;background:#fafaf9;border:1px dashed #d6d3d1;text-align:center;">
      <span style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:32px;font-weight:800;letter-spacing:8px;color:#b45309;">${code}</span>
    </div>

    <p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#78716c;">• 验证码有效期为 <strong>10 分钟</strong>，单次验证后立即失效。</p>
    <p style="margin:0;font-size:12px;line-height:1.6;color:#78716c;">• 如非您本人发起的操作，请直接忽略此邮件，您的账户仍然安全。</p>

    <hr style="border:none;border-top:1px solid #f5f5f4;margin:24px 0 16px;" />
    <div style="text-align:center;font-size:11px;color:#a8a29e;">
      OnlyArabics 只有阿语 · <a href="https://onlyaras.cn" style="color:#b45309;text-decoration:none;">onlyaras.cn</a>
    </div>
  </div>
</body>
</html>`;

  return { subject, html, text };
}

export async function sendVerificationEmail(
  env: Env,
  toEmail: string,
  code: string,
  purpose: 'register' | 'reset_password'
): Promise<SendEmailResult> {
  const apiKey = (env.RESEND_API_KEY || '').trim();
  const fromAddress = (env.EMAIL_FROM || 'OnlyArabics 只有阿语 <noreply@onlyaras.cn>').trim();

  if (!apiKey) {
    if (env.ENVIRONMENT !== 'production') {
      console.log(`[DEV EMAIL OTP] To=${toEmail} Purpose=${purpose} Code=${code}`);
      return { ok: true, mode: 'dev_console' };
    }
    return {
      ok: false,
      mode: 'unconfigured',
      error: '邮件发送服务尚未配置密钥（RESEND_API_KEY），请联系管理员完成域名发信配置。',
    };
  }

  const { subject, html, text } = buildVerificationEmailHtml(code, purpose);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [toEmail],
        subject,
        html,
        text,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`Resend API error (${res.status}):`, errBody);
      return {
        ok: false,
        mode: 'error',
        error: '验证码邮件发送失败，请检查邮箱地址是否正确或稍后再试',
      };
    }

    return { ok: true, mode: 'resend' };
  } catch (err) {
    console.error('Resend network exception:', err);
    return {
      ok: false,
      mode: 'error',
      error: '邮件服务连接超时，请稍后重试',
    };
  }
}
