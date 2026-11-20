/**
 * In-memory fakes for the CoreDeps contracts so every module can be unit/integration tested before the
 * real implementations land. Usage:
 *
 *   const t = await createTestDb({ schema: { users, ...mine } });
 *   const h = createTestDeps({ db: t.db });
 *   const mod = createOrdersModule(h.deps);
 *   h.services.identity = fakeIdentity;            // register peers your code calls
 *   expect(h.audit.events).toContainEqual(expect.objectContaining({ eventName: "order.created" }));
 */
import { Readable } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import { testConfig, type AppConfig } from "../../server/config/env.js";
import { FakeClock } from "../../server/core/clock.js";
import { AuditUnavailableError } from "../../server/core/errors.js";
import { runWithRequestContext, newRequestContext } from "../../server/core/requestContext.js";
import type {
  AuditEmitter,
  AuditEventInput,
  ClaimedJob,
  CoreDeps,
  Db,
  EnqueueOptions,
  JobHandlerOptions,
  JobQueue,
  JobResult,
  Logger,
  Mailer,
  MailTemplate,
  ObjectStorage,
  OutboundMail,
  RateLimiter,
  SessionPrincipal,
  SettingsStore,
  StoredObjectInfo,
  Tx,
} from "../../server/core/types.js";
import type { ModuleDeps, Services } from "../../server/container.js";
import { createFieldCrypto } from "../../server/security/fieldCrypto.js";
import type { UserRole } from "../../shared/domain.js";

export class FakeAudit implements AuditEmitter {
  events: AuditEventInput[] = [];
  notes: AuditEventInput[] = [];
  /** Set true to simulate the durable audit store being unavailable (fail-closed tests). */
  failRecords = false;
  /** `tx` presence per recorded event, so tests can assert transactional audit. */
  recordedInTx: boolean[] = [];
  async record(event: AuditEventInput, tx?: Tx): Promise<void> {
    if (this.failRecords) throw new AuditUnavailableError();
    this.events.push(event);
    this.recordedInTx.push(tx !== undefined);
  }
  note(event: AuditEventInput): void {
    this.notes.push(event);
  }
  named(eventName: string): AuditEventInput[] {
    return this.events.filter((event) => event.eventName === eventName);
  }
  clear(): void {
    this.events = [];
    this.notes = [];
    this.recordedInTx = [];
  }
}

export class FakeMailer implements Mailer {
  sent: OutboundMail[] = [];
  templates = new Map<string, MailTemplate>();
  registerTemplate(template: MailTemplate): void {
    if (this.templates.has(template.key)) throw new Error(`duplicate mail template ${template.key}`);
    this.templates.set(template.key, template);
  }
  async enqueue(mail: OutboundMail): Promise<void> {
    const template = this.templates.get(mail.template);
    if (!template) throw new Error(`unregistered mail template ${mail.template}`);
    for (const name of Object.keys(mail.vars)) {
      if (!template.vars.includes(name)) throw new Error(`mail template ${mail.template} does not accept var ${name}`);
    }
    if (!this.sent.some((existing) => existing.idempotencyKey === mail.idempotencyKey)) this.sent.push(mail);
  }
  last(template: string): OutboundMail | undefined {
    return [...this.sent].reverse().find((mail) => mail.template === template);
  }
}

export class FakeJobs implements JobQueue {
  enqueued: { jobId: string; type: string; payload: unknown; options?: EnqueueOptions }[] = [];
  handlers = new Map<string, (job: ClaimedJob<never>) => Promise<JobResult>>();
  schedules: { name: string; type: string; everyMs: number; payload?: unknown }[] = [];
  registerSchedule(schedule: { name: string; type: string; everyMs: number; payload?: unknown }): void {
    this.schedules.push(schedule);
  }
  async enqueue<P>(type: string, payload: P, options?: EnqueueOptions): Promise<{ jobId: string }> {
    const existing = options?.idempotencyKey
      ? this.enqueued.find((job) => job.type === type && job.options?.idempotencyKey === options.idempotencyKey)
      : undefined;
    if (existing) return { jobId: existing.jobId };
    const jobId = `job_${randomBytes(6).toString("hex")}`;
    this.enqueued.push({ jobId, type, payload, options });
    return { jobId };
  }
  handlerOptions = new Map<string, JobHandlerOptions>();
  register<P>(type: string, handler: (job: ClaimedJob<P>) => Promise<JobResult>, options?: JobHandlerOptions): void {
    this.handlers.set(type, handler as (job: ClaimedJob<never>) => Promise<JobResult>);
    this.handlerOptions.set(type, options ?? {});
  }
  /** Runs every queued job of a type through its registered handler (synchronously, in order). */
  async runAll(type?: string): Promise<JobResult[]> {
    const results: JobResult[] = [];
    const pending = this.enqueued.filter((job) => !type || job.type === type);
    this.enqueued = this.enqueued.filter((job) => !pending.includes(job));
    for (const job of pending) {
      const handler = this.handlers.get(job.type);
      if (!handler) throw new Error(`no handler registered for ${job.type}`);
      results.push(
        await handler({
          jobId: job.jobId,
          type: job.type,
          payload: job.payload as never,
          attempt: 1,
          fencingToken: 1,
          correlationId: job.options?.correlationId ?? job.jobId,
          signal: new AbortController().signal,
          assertStillOwned: async () => {},
        }),
      );
    }
    return results;
  }
}

export class MemoryStorage implements ObjectStorage {
  objects = new Map<string, Buffer>();
  newKey(namespace: string): string {
    return `${namespace}/${randomBytes(16).toString("hex")}`;
  }
  async put(key: string, body: Readable | Buffer, options?: { maxBytes?: number }): Promise<StoredObjectInfo> {
    let buffer: Buffer;
    if (Buffer.isBuffer(body)) buffer = body;
    else {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of body) {
        const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        total += piece.length;
        if (options?.maxBytes !== undefined && total > options.maxBytes) throw new Error("OBJECT_TOO_LARGE");
        chunks.push(piece);
      }
      buffer = Buffer.concat(chunks);
    }
    if (options?.maxBytes !== undefined && buffer.length > options.maxBytes) throw new Error("OBJECT_TOO_LARGE");
    this.objects.set(key, buffer);
    return { key, size: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
  }
  async get(key: string, range?: { start: number; end: number }): Promise<Readable> {
    const buffer = this.objects.get(key);
    if (!buffer) throw new Error("OBJECT_NOT_FOUND");
    return Readable.from(range ? buffer.subarray(range.start, range.end + 1) : buffer);
  }
  async stat(key: string): Promise<StoredObjectInfo | null> {
    const buffer = this.objects.get(key);
    return buffer ? { key, size: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") } : null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async move(fromKey: string, toKey: string): Promise<void> {
    const buffer = this.objects.get(fromKey);
    if (!buffer) throw new Error("OBJECT_NOT_FOUND");
    this.objects.set(toKey, buffer);
    this.objects.delete(fromKey);
  }
}

export class MemorySettings implements SettingsStore {
  values = new Map<string, unknown>();
  secrets = new Map<string, string>();
  flags = new Set<string>();
  async get<T>(key: string, parse: (raw: unknown) => T, fallback: T): Promise<T> {
    if (!this.values.has(key)) return fallback;
    try {
      return parse(this.values.get(key));
    } catch {
      return fallback;
    }
  }
  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
  async getSecret(key: string): Promise<string | null> {
    return this.secrets.get(key) ?? null;
  }
  async setSecret(key: string, value: string | null): Promise<void> {
    if (value === null) this.secrets.delete(key);
    else this.secrets.set(key, value);
  }
  async isFeatureEnabled(flag: string): Promise<boolean> {
    return this.flags.has(flag);
  }
}

export class FakeRateLimiter implements RateLimiter {
  /** Category names (or `category:key`) that should be refused. */
  blocked = new Set<string>();
  calls: { category: string; key: string }[] = [];
  async consume(category: string, key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    this.calls.push({ category, key });
    const refused = this.blocked.has(category) || this.blocked.has(`${category}:${key}`);
    return { allowed: !refused, retryAfterSeconds: refused ? 30 : 0 };
  }
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

export interface TestHarness {
  deps: ModuleDeps;
  services: Services;
  config: AppConfig;
  clock: FakeClock;
  audit: FakeAudit;
  mailer: FakeMailer;
  jobs: FakeJobs;
  storage: MemoryStorage;
  settings: MemorySettings;
  rateLimiter: FakeRateLimiter;
}

/** Builds CoreDeps from fakes. `db` is required for anything that touches the database. */
export function createTestDeps(options: { db?: Db; config?: Partial<AppConfig>; now?: Date } = {}): TestHarness {
  const config = testConfig(options.config);
  const clock = new FakeClock(options.now ?? new Date("2026-11-20T12:00:00.000Z"));
  const audit = new FakeAudit();
  const mailer = new FakeMailer();
  const jobs = new FakeJobs();
  const storage = new MemoryStorage();
  const settings = new MemorySettings();
  const rateLimiter = new FakeRateLimiter();
  const db =
    options.db ??
    (new Proxy(
      {},
      {
        get() {
          throw new Error("createTestDeps: no db supplied — pass { db: (await createTestDb(...)).db }");
        },
      },
    ) as Db);
  const core: CoreDeps = {
    config,
    db,
    clock,
    logger: silentLogger,
    audit,
    crypto: createFieldCrypto(config),
    settings,
    mailer,
    jobs,
    storage,
    rateLimiter,
  };
  const services = { ...core } as Services;
  return { deps: { ...core, services }, services, config, clock, audit, mailer, jobs, storage, settings, rateLimiter };
}

let sessionCounter = 0;
/** A synthetic verified principal for router/service tests. */
export function fakePrincipal(overrides: Partial<SessionPrincipal> & { role?: UserRole } = {}): SessionPrincipal {
  sessionCounter += 1;
  const now = new Date("2026-11-20T12:00:00.000Z");
  return {
    sessionId: `sess_test_${sessionCounter}`,
    userId: 1000 + sessionCounter,
    userPublicId: `01TESTUSER${String(sessionCounter).padStart(16, "0")}`,
    role: "customer",
    state: "full",
    pendingSteps: [],
    authMethod: "local",
    authenticatedAt: now,
    mfaVerifiedAt: now,
    stepUpAt: null,
    csrfSecret: "test-csrf-secret",
    ...overrides,
  };
}

/** Runs `fn` inside a synthetic request context (so audit/logging correlation code paths execute). */
export function withTestRequest<T>(fn: () => Promise<T>, principal?: SessionPrincipal): Promise<T> {
  const context = newRequestContext("test");
  if (principal) context.actor = { userId: principal.userId, role: principal.role, sessionId: principal.sessionId };
  return runWithRequestContext(context, fn);
}
