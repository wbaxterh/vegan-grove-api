import nodemailer from 'nodemailer';
import type { Env } from '../config/env.js';
import type { EmailSender } from '../lib/deps.js';
import type { Logger } from '../lib/logger.js';

function magicLinkText(url: string): string {
  return [
    'Here is your Vegan Grove sign-in link. It works once and expires in 15 minutes.',
    '',
    url,
    '',
    'If you did not ask for this, ignore it. Nobody can sign in without the link.',
  ].join('\n');
}

/**
 * Magic-link delivery. `smtp` speaks to SES (or any SMTP relay) with the
 * credentials from env. `log` is for development and tests: it records that a
 * link was issued and where it points, but never the token.
 */
export function createEmailSender(env: Env, logger: Logger): EmailSender {
  if (env.EMAIL_TRANSPORT === 'log') {
    return {
      async sendMagicLink({ url }) {
        const { origin, pathname } = new URL(url);
        logger.info({ link: `${origin}${pathname}` }, 'magic link issued (log transport)');
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });

  return {
    async sendMagicLink({ to, url }) {
      await transport.sendMail({
        from: env.EMAIL_FROM,
        to,
        subject: 'Your Vegan Grove sign-in link',
        text: magicLinkText(url),
      });
      logger.info('magic link email sent');
    },
  };
}
