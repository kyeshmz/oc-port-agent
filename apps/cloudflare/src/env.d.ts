import type { TrackingId } from './contracts.js';
import type { D1DatabaseBinding, QueueWorkMessage } from './store.js';

/** Identity-only work persisted to the D1 outbox before it is sent to Queues. */
export interface TargetJobRpc {
  runTracking(trackingId: TrackingId): Promise<void>;
  reconcileTracking(trackingId: TrackingId): Promise<void>;
}

export interface QueueBinding {
  send(message: QueueWorkMessage): Promise<void>;
}

export interface DurableObjectNamespaceBinding<T> {
  getByName(name: string): T;
}

export interface Env {
  DB: D1DatabaseBinding;
  JOB_QUEUE: QueueBinding;
  TARGET_JOBS: DurableObjectNamespaceBinding<TargetJobRpc>;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
}

export interface ExecutionContextBinding {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledEventBinding {
  scheduledTime: number;
}

export interface QueueMessageBinding {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface QueueBatchBinding {
  messages: readonly QueueMessageBinding[];
}
