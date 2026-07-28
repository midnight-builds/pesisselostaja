/** Small hand-rolled HTTP helpers — no framework (DESIGN.md: no new
 *  dependencies). Every route in index.ts goes through these so JSON shape,
 *  body-size limits and static-file semantics stay in one place instead of
 *  being reimplemented per route. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { ApiError } from "../shared/api.js";

/** A stray or malicious client should never be able to make the control
 *  server buffer an unbounded body in memory. Every real request here (job
 *  patches, knob nudges) is a few hundred bytes at most. */
const MAX_BODY_BYTES = 1024 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
};

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, error: string, detail?: string): void {
  const body: ApiError = detail === undefined ? { error } : { error, detail };
  sendJson(res, status, body);
}

/** Reads and parses a JSON request body. Throws (rather than returning an
 *  error shape) on anything wrong — oversized, empty or malformed — so route
 *  handlers can just await it inside their existing try/catch and let
 *  index.ts's 500 handler, or their own 400 handler, take it from there. */
export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("pyynnön runko on liian suuri (yli 1 Mt)");
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    throw new Error("pyynnön runko puuttuu");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("pyynnön runko ei ole kelvollista JSONia");
  }
}

/** Serves one static file if it exists and is a regular file. Returns false
 *  (never throws) on anything else, so callers can chain fallbacks — e.g.
 *  the SPA index.html — without a try/catch of their own. Path containment
 *  is the caller's responsibility (index.ts resolves against a known root
 *  before calling this). */
export async function serveStatic(res: ServerResponse, filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    const buf = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
      "Content-Length": buf.length,
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

export function parseQuery(url: string): URLSearchParams {
  const idx = url.indexOf("?");
  return new URLSearchParams(idx === -1 ? "" : url.slice(idx + 1));
}
