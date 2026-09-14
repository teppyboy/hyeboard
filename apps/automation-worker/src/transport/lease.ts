import { randomUUID } from "node:crypto";
import { LeaseLostError } from "../runtime/errors";

export type JobLease = {
  readonly jobId: string;
  readonly fence: number;
  renew(): Promise<boolean>;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
};

export interface JobLeaseStore {
  acquire(jobId: string, fence: number, ttlMs: number): Promise<JobLease | undefined>;
}

type LeaseRecord = { token: string; fence: number; expiresAt: number };

export class InMemoryJobLeaseStore implements JobLeaseStore {
  private readonly records = new Map<string, LeaseRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  async acquire(jobId: string, fence: number, ttlMs: number): Promise<JobLease | undefined> {
    const existing = this.records.get(jobId);
    if (existing && existing.expiresAt > this.now()) return undefined;
    const token = randomUUID();
    const record = { token, fence, expiresAt: this.now() + ttlMs };
    this.records.set(jobId, record);
    let released = false;
    return {
      jobId,
      fence,
      renew: async () => {
        if (released || !this.owns(jobId, token, fence)) return false;
        record.expiresAt = this.now() + ttlMs;
        return true;
      },
      assertHeld: async () => {
        if (released || !this.owns(jobId, token, fence)) throw new LeaseLostError();
      },
      release: async () => {
        released = true;
        if (this.owns(jobId, token, fence)) this.records.delete(jobId);
      },
    };
  }

  private owns(jobId: string, token: string, fence: number): boolean {
    const record = this.records.get(jobId);
    return Boolean(record && record.token === token && record.fence === fence && record.expiresAt > this.now());
  }
}

export type RedisLeaseClient = {
  set(key: string, value: string, options: { PX: number; NX: boolean }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

const renewScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0";
const releaseScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

export class RedisJobLeaseStore implements JobLeaseStore {
  constructor(private readonly client: RedisLeaseClient, private readonly keyPrefix = "hyeboard:automation:lease:") {}

  async acquire(jobId: string, fence: number, ttlMs: number): Promise<JobLease | undefined> {
    const token = randomUUID();
    const key = `${this.keyPrefix}${jobId}`;
    const value = JSON.stringify({ token, fence });
    const acquired = await this.client.set(key, value, { PX: ttlMs, NX: true });
    if (acquired !== "OK" && acquired !== true) return undefined;
    let released = false;
    const lease: JobLease = {
      jobId,
      fence,
      renew: async () => {
        if (released) return false;
        return Number(await this.client.eval(renewScript, { keys: [key], arguments: [value, String(ttlMs)] })) === 1;
      },
      assertHeld: async () => {
        if (released || !(await lease.renew())) throw new LeaseLostError();
      },
      release: async () => {
        released = true;
        await this.client.eval(releaseScript, { keys: [key], arguments: [value] });
      },
    };
    return lease;
  }
}
