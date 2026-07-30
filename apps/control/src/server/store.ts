/** JSON-file storage for control-plane state. A database would be overkill
 *  for a few dozen jobs a season, and plain files mean an operator can read
 *  or hand-fix state from a file browser (see dufs on :5000) when something
 *  is sideways mid-broadcast — the same idiom as the relay's own
 *  .state-*.json / .control-*.json (CLAUDE.md). */
import { mkdir, readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG } from "./config.js";

export interface Store<T> {
  read(): Promise<T>;
  write(value: T): Promise<void>;
  update(fn: (current: T) => T): Promise<T>;
}

async function ensureStateDir(): Promise<void> {
  await mkdir(CONFIG.stateDir, { recursive: true });
}

/** Kasvava juokseva numero tmp-tiedostojen nimiin. Kiinteä `.tmp` riittäisi
 *  vain yhdelle kirjoittajalle: kaksi rinnakkaista kirjoitusta samaan
 *  tiedostoon osuisivat samaan tmp-nimeen, jolloin toinen kirjoittaisi toisen
 *  puskurin päälle ennen renamea ja jälkimmäinen rename kaatuisi ENOENTiin. */
let tmpCounter = 0;

export function createStore<T>(fileName: string, initial: T): Store<T> {
  const filePath = join(CONFIG.stateDir, fileName);
  // Serializes EVERY write to this file — both update()'s read-modify-write
  // and a bare write() — so two concurrent writers (e.g. an operator's fresh
  // device-flow login calling write() while the background source-ingest
  // poller's hourly token refresh is mid-update()) chain instead of racing on
  // disk and one silently clobbering the other's change. Leaving write()
  // outside the chain is exactly how a brand-new refresh token gets replaced
  // by the one the in-flight update() had already read.
  let chain: Promise<unknown> = Promise.resolve();

  async function read(): Promise<T> {
    try {
      const text = await readFile(filePath, "utf8");
      return JSON.parse(text) as T;
    } catch {
      // Missing file (first run) or corrupt JSON (killed mid-write, or a
      // manual edit gone wrong) both fall back to the caller's initial value
      // rather than taking the server down.
      return initial;
    }
  }

  /** The write itself, WITHOUT the lock — update() already holds it, and
   *  waiting for its own turn in the chain would deadlock. */
  async function writeUnlocked(value: T): Promise<void> {
    await ensureStateDir();
    const tmpPath = `${filePath}.tmp-${process.pid}-${++tmpCounter}`;
    await writeFile(tmpPath, JSON.stringify(value, null, 2), "utf8");
    // rename() is atomic on the same filesystem: a concurrent reader never
    // observes a half-written file, and a service killed mid-save leaves the
    // previous good version in place instead of a truncated one.
    await rename(tmpPath, filePath);
  }

  /** Queues `next` behind everything already in flight. The chain itself must
   *  never reject, or every write queued after a failed one would inherit that
   *  rejection forever. The caller of *this* write still observes the real
   *  failure via the returned promise. */
  function serialize<R>(fn: () => Promise<R>): Promise<R> {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  }

  function write(value: T): Promise<void> {
    return serialize(() => writeUnlocked(value));
  }

  function update(fn: (current: T) => T): Promise<T> {
    return serialize(async () => {
      const current = await read();
      const updated = fn(current);
      await writeUnlocked(updated);
      return updated;
    });
  }

  return { read, write, update };
}

export async function appendNdjson(fileName: string, row: unknown): Promise<void> {
  await ensureStateDir();
  await appendFile(join(CONFIG.stateDir, fileName), JSON.stringify(row) + "\n", "utf8");
}

/** Reads the most recent `limit` rows (or all rows, if omitted), returned
 *  oldest-first — i.e. read from the tail of the file, but hand back
 *  chronological order so callers can just append the result to a feed. */
export async function readNdjson<T>(fileName: string, limit?: number): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(join(CONFIG.stateDir, fileName), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const tail = limit !== undefined && limit >= 0 ? lines.slice(-limit) : lines;
  const rows: T[] = [];
  for (const line of tail) {
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // A truncated last line (crash mid-append) is skipped rather than
      // failing the whole read.
    }
  }
  return rows;
}
