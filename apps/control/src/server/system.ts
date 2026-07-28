/** System vitals for the status grid and the global disk-space stop rule. */
import { statfs } from "node:fs/promises";
import { freemem, totalmem, loadavg, cpus } from "node:os";
import type { SystemState } from "../shared/types.js";

// Global operating rule (~/.claude/CLAUDE.md "KRIITTINEN: Levytilan
// valvonta"): if free space threatens to run out, every writing operation
// must stop immediately. "Threatens" is defined as under 2 GiB free OR under
// 10% of total capacity free, whichever trips first — a huge disk can still
// hit the byte floor, and a small disk can have >2 GiB free yet be nearly
// full. This mirrors the same floor already used in apps/broadcast/preflight.ts.
const DISK_MIN_BYTES = 2 * 1024 * 1024 * 1024;
const DISK_MIN_FRACTION = 0.1;

export async function getSystemState(): Promise<SystemState> {
  const s = await statfs("/");
  const diskFreeBytes = s.bavail * s.bsize;
  const diskTotalBytes = s.blocks * s.bsize;
  const diskCritical =
    diskFreeBytes < DISK_MIN_BYTES || diskFreeBytes / diskTotalBytes < DISK_MIN_FRACTION;

  return {
    diskFreeBytes,
    diskTotalBytes,
    diskCritical,
    memFreeBytes: freemem(),
    memTotalBytes: totalmem(),
    load1: loadavg()[0],
    cpuCount: cpus().length,
  };
}
