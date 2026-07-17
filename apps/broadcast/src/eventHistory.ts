import type { LiveEvent } from "@pesisselostaja/core";

/** Result of merging one delta response into the local history. */
export interface MergeResult {
  /** Events appended as genuinely new keys. */
  added: number;
  /** Existing events replaced with a newer version (e.g. more sub-events). */
  updated: number;
  /** True when the delta looked inconsistent with the stored history — an
   *  existing event came back with FEWER sub-events than we already hold.
   *  Sub-event lists only ever grow within one event, so shrinkage means the
   *  server re-keyed or rewrote history; the caller should discard the local
   *  history and do a full refetch. */
  inconsistent: boolean;
}

/** Local full-history mirror of the online/{id}/events feed, so delta
 *  (`after=`) polling can coexist with processing code that assumes the
 *  complete history every poll (processEventsLive, recomputeCurrentOutsKeyed,
 *  outsThroughSubEvent — see HANDOFF.md 15.7. kohta 6). Delta responses are
 *  merged in; `events` always exposes the merged full list in first-seen
 *  order, which matches the API's append-order for a growing feed.
 *
 *  Keying: event.id alone is NOT unique (it restarts every turn on the live
 *  feed — see reference-event-id-resets-per-turn), so the key includes the
 *  turn coordinates, same principle as eventFingerprint. Note: in period 3
 *  the API can transiently re-key a turn-ending palo into the next sisävuoro,
 *  which would appear here as a short-lived duplicate entry; speech stays
 *  correct (eventFingerprint ignores coordinates in period 3) and the
 *  periodic full resync replaces the history, bounding the window. */
export class EventHistory {
  private order: string[] = [];
  private byKey = new Map<string, LiveEvent>();

  static keyOf(e: LiveEvent): string {
    return `${e.period}:${e.inning}:${e.batTurn}:${e.team}:${e.id}`;
  }

  get size(): number {
    return this.order.length;
  }

  /** The merged full history, in first-seen order. */
  get events(): LiveEvent[] {
    return this.order.map((k) => this.byKey.get(k)!);
  }

  /** Replaces the whole history with a full-fetch response. */
  replace(events: LiveEvent[]): void {
    this.order = [];
    this.byKey = new Map();
    for (const e of events) {
      const key = EventHistory.keyOf(e);
      if (!this.byKey.has(key)) this.order.push(key);
      this.byKey.set(key, e);
    }
  }

  /** Merges a delta response's events. New keys append in response order;
   *  an existing key's event is replaced (its sub-event list can grow across
   *  polls). Never mutates on inconsistency — caller refetches instead. */
  merge(events: LiveEvent[]): MergeResult {
    const result: MergeResult = { added: 0, updated: 0, inconsistent: false };
    for (const e of events) {
      const key = EventHistory.keyOf(e);
      const existing = this.byKey.get(key);
      if (!existing) {
        this.order.push(key);
        this.byKey.set(key, e);
        result.added++;
        continue;
      }
      if (e.events.length < existing.events.length) {
        result.inconsistent = true;
        continue;
      }
      if (JSON.stringify(e) !== JSON.stringify(existing)) {
        this.byKey.set(key, e);
        result.updated++;
      }
    }
    return result;
  }
}
