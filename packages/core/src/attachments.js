import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";

// Attachments land in the OS temp dir, one subfolder per message, and are
// removed once Claude finishes the run (see the adapter's cleanup call).
const BASE_DIR = join(tmpdir(), "claude-channel-bridge", "attachments");

// Keep a filename recognizable but path-safe.
const safeName = (name, fallback) => {
  const cleaned = (name || "")
    .replace(/[/\\]/g, "_") // no path separators
    .replace(/^\.+/, "") // no leading dots (hidden / traversal)
    .trim();
  return cleaned || fallback;
};

const mb = (bytes) => (bytes / 1048576).toFixed(1);

/**
 * Download a batch of remote attachments to a private temp folder so Claude
 * can read them from disk. Adapter-agnostic: pass plain {url,name,...} objects.
 *
 * @param {string} key  unique subfolder name (e.g. "discord-<channel>-<msg>")
 * @param {Array<{url:string,name?:string,contentType?:string,size?:number}>} items
 * @returns {Promise<{dir:string, files:Array<{path,name,contentType,size}>, skipped:Array<{name,reason}>}>}
 */
export async function downloadAttachments(key, items) {
  const dir = join(BASE_DIR, key);
  await mkdir(dir, { recursive: true });

  const maxBytes = config.attachments.maxMb * 1024 * 1024;
  const files = [];
  const skipped = [];

  let i = 0;
  for (const item of items) {
    i++;
    const name = safeName(item.name, `attachment-${i}`);

    // Trust the advertised size first, so we never start a huge download.
    if (item.size && item.size > maxBytes) {
      skipped.push({
        name,
        reason: `too large (${mb(item.size)} MB > ${config.attachments.maxMb} MB limit)`,
      });
      continue;
    }

    try {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());

      // Re-check: the advertised size can be missing or wrong.
      if (buf.byteLength > maxBytes) {
        skipped.push({
          name,
          reason: `too large (${mb(buf.byteLength)} MB > ${config.attachments.maxMb} MB limit)`,
        });
        continue;
      }

      const path = join(dir, `${i}-${name}`);
      await writeFile(path, buf);
      files.push({
        path,
        name,
        contentType: item.contentType || "",
        size: buf.byteLength,
      });
    } catch (err) {
      log.warn(`[attachments] could not fetch "${name}": ${err.message}`);
      skipped.push({ name, reason: err.message });
    }
  }

  return { dir, files, skipped };
}

// Remove a message's attachment folder once the run is done.
export async function cleanupAttachments(dir) {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
