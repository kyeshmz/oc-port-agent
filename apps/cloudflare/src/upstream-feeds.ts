import type { FeedObservation, UpstreamFeedStore, UpstreamFeedWatch } from './store.js';

const INTERVAL_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
const MAX_BODY_BYTES = 512 * 1_024;
const REQUEST_TIMEOUT_MS = 10_000;
const BATCH_SIZE = 20;
const CONCURRENCY = 4;

class FeedError extends Error {
  constructor(readonly retryAfterMs = 0) { super('upstream-feed-unavailable'); }
}

/** Fixed-origin, anonymous hints only. No feed URL, links, title, or entry is trusted as executable data. */
function feedUrl(watch: UpstreamFeedWatch): string {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/.exec(watch.repository);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') throw new FeedError();
  const path = watch.kind === 'tags' ? 'tags.atom' : `commits/${encodeURIComponent(watch.ref)}.atom`;
  return `https://github.com/${match[1]}/${match[2]}/${path}`;
}

function validator(response: Response, name: string): string | null {
  const value = response.headers.get(name);
  return value && value.length <= 1_024 && !/[\r\n]/.test(value) ? value : null;
}

function retryDelay(response: Response, now: number): number {
  if (response.status !== 429 && response.status !== 503) return 0;
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, Math.min(MAX_BACKOFF_MS, milliseconds)) : 0;
}

async function observe(watch: UpstreamFeedWatch, fetcher: typeof fetch, now: number): Promise<FeedObservation> {
  const controller = new AbortController();
  // Race as well as abort: a broken injected transport must not retain the lease
  // indefinitely. The same deadline covers headers and streaming the body.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new FeedError()); }, REQUEST_TIMEOUT_MS);
  });
  const request = async (): Promise<FeedObservation> => {
    const headers = new Headers({ accept: 'application/atom+xml' });
    if (watch.etag) headers.set('if-none-match', watch.etag);
    if (watch.lastModified) headers.set('if-modified-since', watch.lastModified);
    const response = await fetcher(feedUrl(watch), {
      method: 'GET', headers, redirect: 'error', credentials: 'omit', signal: controller.signal,
    });
    try {
      if (response.redirected || response.status >= 300 && response.status !== 304) throw new FeedError(retryDelay(response, now));
      if (response.status === 304 && watch.bodyDigest) return { kind: 'unchanged' };
      if (response.status !== 200 || !/^application\/atom\+xml(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new FeedError();
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new FeedError();
      if (!response.body) throw new FeedError();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > MAX_BODY_BYTES) throw new FeedError();
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // Envelope check, not an XML parser: reject declarations/entities and
      // error HTML. Entries stay opaque; nothing is resolved or expanded.
      if (/<!DOCTYPE|<!ENTITY/i.test(text)
        || !/^\s*(?:<\?xml\s[^?]*\?>\s*)?<feed\s[^>]*\bxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2005\/Atom["'][^>]*>[\s\S]*<\/feed>\s*$/.test(text)) throw new FeedError();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return {
        kind: 'snapshot', digest: [...digest].map(value => value.toString(16).padStart(2, '0')).join(''),
        etag: validator(response, 'etag'), lastModified: validator(response, 'last-modified'),
      };
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  };
  try { return await Promise.race([request(), timeout]); }
  finally { clearTimeout(timer); }
}

/** All network dependencies are explicit; this module has no App or provider port. */
export async function monitorUpstreamFeeds(input: {
  store: UpstreamFeedStore; fetch: typeof fetch; now: () => number;
}): Promise<void> {
  const started = input.now();
  const watches = await input.store.claimDueUpstreamFeeds({
    now: new Date(started).toISOString(), leaseUntil: new Date(started + 2 * 60_000).toISOString(), limit: BATCH_SIZE,
  });
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, watches.length) }, async () => {
    while (index < watches.length) {
      const watch = watches[index++]!;
      let observation: FeedObservation;
      let delay = INTERVAL_MS;
      try { observation = await observe(watch, input.fetch, input.now()); }
      catch (error) {
        observation = { kind: 'error' };
        delay = Math.max(Math.min(MAX_BACKOFF_MS, INTERVAL_MS * 2 ** Math.min(watch.failures, 7)),
          error instanceof FeedError ? error.retryAfterMs : 0);
      }
      const now = input.now();
      // A failed persistence attempt is retried after lease expiry, not silently
      // converted into a snapshot. Other watches and the daily fallback continue.
      try {
        await input.store.completeUpstreamFeed({ watch, observation, now: new Date(now).toISOString(), nextDueAt: new Date(now + delay).toISOString() });
      } catch { /* lease expiry permits retry */ }
    }
  }));
}
