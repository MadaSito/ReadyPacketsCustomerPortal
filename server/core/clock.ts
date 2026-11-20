import type { Clock } from "./types.js";

export const systemClock: Clock = { now: () => new Date() };

/** Deterministic clock for tests. */
export class FakeClock implements Clock {
  constructor(private current: Date = new Date("2026-11-20T09:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(date: Date): void {
    this.current = new Date(date.getTime());
  }
}
