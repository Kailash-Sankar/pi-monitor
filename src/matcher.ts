/**
 * Condition logic for pi-monitor.
 *
 * Pure and synchronous: no timers, no processes, no I/O. The spawn layer feeds
 * it output lines, an exit, and periodic ticks, and it decides whether the
 * monitor should fire. Kept separate so it can be tested without a running Pi.
 *
 * Semantics (v1, deliberately minimal):
 *   - One-shot: once the monitor fires, it is done and never fires again.
 *   - First event wins: a matching line, or the process ending.
 *   - Quiet detection is a renewable *silence* threshold, not total runtime.
 *     Any output renews the deadline. 0 disables it.
 */

export type FireReason =
  | { kind: "matched"; line: string }
  | { kind: "exited"; code: number | null; signal: string | null }
  | { kind: "quiet"; silentMs: number };

export interface MatcherOptions {
  /** Regex source. The monitor fires when any output line matches. */
  match?: string;
  /** Regex flags, e.g. "i" for case-insensitive. */
  flags?: string;
  /** Silence threshold in ms. 0 disables quiet detection. */
  timeoutMs?: number;
}

export class ConditionMatcher {
  private readonly pattern: RegExp | null;
  private readonly timeoutMs: number;
  private lastActivityAt: number;
  private isDone = false;

  /**
   * @param options Condition configuration.
   * @param now     Current time in ms, used to seed the silence clock.
   * @throws If `match` is not a valid regular expression.
   */
  constructor(options: MatcherOptions, now: number) {
    if (options.match !== undefined && options.match !== "") {
      // g/y make RegExp.test() stateful via lastIndex; we only care whether a
      // line matches at all, so drop them. Dedupe the rest, which RegExp rejects.
      const rawFlags = options.flags ?? "";
      const flags = [...new Set(rawFlags.replace(/[gy]/g, ""))].join("");
      try {
        this.pattern = new RegExp(options.match, flags);
      } catch (err) {
        throw new Error(`invalid match pattern: ${(err as Error).message}`);
      }
    } else {
      this.pattern = null;
    }

    this.timeoutMs = options.timeoutMs ?? 0;
    this.lastActivityAt = now;
  }

  /** Whether the monitor has already fired. */
  get done(): boolean {
    return this.isDone;
  }

  /** Feed one output line. Returns a reason if it matches, else null. */
  onLine(line: string, now: number): FireReason | null {
    if (this.isDone) return null;
    this.lastActivityAt = now;
    if (this.pattern !== null && this.pattern.test(line)) {
      this.isDone = true;
      return { kind: "matched", line };
    }
    return null;
  }

  /** Feed process termination. Returns a reason unless already fired. */
  onExit(code: number | null, signal: string | null = null): FireReason | null {
    if (this.isDone) return null;
    this.isDone = true;
    return { kind: "exited", code, signal };
  }

  /** Advance the clock. Returns a reason if the process went quiet. */
  onTick(now: number): FireReason | null {
    if (this.isDone) return null;
    if (this.timeoutMs <= 0) return null;
    const silentMs = now - this.lastActivityAt;
    if (silentMs >= this.timeoutMs) {
      this.isDone = true;
      return { kind: "quiet", silentMs };
    }
    return null;
  }
}
