import { createServiceNotifications } from '@agroasys/notifications';
import { config } from '../config';
import { pool } from '../database/connection';
import { Logger } from '../utils/logger';

/**
 * The reconciliation service's durable notification outbox (H-26).
 *
 * Every reconciliation alert is committed to `notification_outbox` before a
 * webhook is tried, so an outage or restart delays the page instead of losing
 * it, and a critical page the primary route cannot take is escalated to the
 * duty owner.
 */
export const serviceNotifications = createServiceNotifications({
  enabled: config.notificationsEnabled,
  webhookUrl: config.notificationsWebhookUrl,
  escalationWebhookUrl: config.notificationsEscalationWebhookUrl,
  cooldownMs: config.notificationsCooldownMs,
  requestTimeoutMs: config.notificationsRequestTimeoutMs,
  executor: pool,
  logger: Logger,
});
