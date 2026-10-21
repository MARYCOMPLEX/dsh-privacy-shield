import type { ShieldConfig } from "./config.js";
import type { Vault } from "./vault.js";

export interface MaskStats {
  readonly masked: number;
  readonly byLabel: Readonly<Record<string, number>>;
}

interface MutableStats {
  masked: number;
  byLabel: Map<string, number>;
}

function freshStats(): MutableStats {
  return { masked: 0, byLabel: new Map() };
}

function snapshot(stats: MutableStats): MaskStats {
  return { masked: stats.masked, byLabel: Object.fromEntries(stats.byLabel) };
}

/**
 * Runtime switch and counters. The config `enabled` is the startup default;
 * `/privacy on|off` writes a per-session override that lives until the process
 * ends. Counters are counts/types only — never values.
 */
export class ShieldState {
  readonly config: ShieldConfig;
  readonly vault: Vault;
  private globalEnabled: boolean;
  private readonly overrides = new Map<string, boolean>();
  private readonly sessionStats = new Map<string, MutableStats>();
  private readonly totalStats = freshStats();

  constructor(config: ShieldConfig, vault: Vault) {
    this.config = config;
    this.vault = vault;
    this.globalEnabled = config.enabled;
  }

  get enabled(): boolean {
    return this.globalEnabled;
  }

  isEnabled(sessionId?: string): boolean {
    if (sessionId !== undefined) {
      const override = this.overrides.get(sessionId);
      if (override !== undefined) return override;
    }
    return this.globalEnabled;
  }

  /** Enable/disable one session; returns the previous effective value. */
  setSessionEnabled(sessionId: string, enabled: boolean): boolean {
    const previous = this.isEnabled(sessionId);
    this.overrides.set(sessionId, enabled);
    return previous;
  }

  setGlobalEnabled(enabled: boolean): boolean {
    const previous = this.globalEnabled;
    this.globalEnabled = enabled;
    return previous;
  }

  clearSessionOverride(sessionId: string): void {
    this.overrides.delete(sessionId);
  }

  record(sessionId: string | undefined, labels: readonly string[]): void {
    if (labels.length === 0) return;
    const bump = (stats: MutableStats) => {
      stats.masked += labels.length;
      for (const label of labels) stats.byLabel.set(label, (stats.byLabel.get(label) ?? 0) + 1);
    };
    bump(this.totalStats);
    if (sessionId === undefined) return;
    let stats = this.sessionStats.get(sessionId);
    if (stats === undefined) {
      stats = freshStats();
      this.sessionStats.set(sessionId, stats);
    }
    bump(stats);
  }

  statsFor(sessionId: string | undefined): MaskStats {
    if (sessionId === undefined) return snapshot(freshStats());
    const stats = this.sessionStats.get(sessionId);
    return stats === undefined ? snapshot(freshStats()) : snapshot(stats);
  }

  totals(): MaskStats {
    return snapshot(this.totalStats);
  }

  get sessionsTracked(): number {
    return this.sessionStats.size;
  }

  get overrideCount(): number {
    return this.overrides.size;
  }
}
