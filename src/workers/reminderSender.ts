import type { AppDeps } from '../lib/deps.js';
import { ScheduledNotificationModel } from '../models/index.js';

export interface Worker {
  start(): void;
  stop(): Promise<void>;
}

/**
 * Event reminder worker. Ticks every `REMINDER_TICK_MS`, claims due rows from
 * `scheduled_notifications`, and (TODO(m2)) sends them through push tokens.
 * The scaffold only counts what is due and logs it at debug level. A tick
 * never overlaps the previous one, and `stop()` waits for an in-flight tick.
 */
export function createReminderSender(deps: Pick<AppDeps, 'env' | 'logger'>): Worker {
  const log = deps.logger.child({ worker: 'reminderSender' });
  let timer: NodeJS.Timeout | null = null;
  let inflight: Promise<void> | null = null;

  async function tick(): Promise<void> {
    const due = await ScheduledNotificationModel.countDocuments({
      status: 'pending',
      scheduledFor: { $lte: new Date() },
    });
    // TODO(m2): claim due rows (pending -> sent) and deliver via push tokens,
    // honouring notification_preferences and quiet hours.
    log.debug({ due }, 'reminder tick');
  }

  function runTick(): void {
    if (inflight) return;
    inflight = tick()
      .catch((err) => log.error({ err }, 'reminder tick failed'))
      .finally(() => {
        inflight = null;
      });
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(runTick, deps.env.REMINDER_TICK_MS);
      timer.unref();
      log.info({ intervalMs: deps.env.REMINDER_TICK_MS }, 'reminder worker started');
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (inflight) await inflight;
      log.info('reminder worker stopped');
    },
  };
}
