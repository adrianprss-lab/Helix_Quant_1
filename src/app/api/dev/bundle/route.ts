import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Serves the complete project source as a ZIP so the operator can move HELIX
 * onto their own infrastructure (GitHub -> Render, or a VPS). Store-only ZIP
 * writer, no dependencies: local file headers + central directory + EOCD.
 */

const INCLUDE_DIRS = ["src", "public"];
const INCLUDE_FILES = [
  "package.json",
  "package-lock.json",
  "next.config.ts",
  "tsconfig.json",
  "drizzle.config.ts",
  "postcss.config.mjs",
  "eslint.config.mjs",
  "Dockerfile",
  "docker-compose.yml",
  "Caddyfile",
  ".dockerignore",
  ".nvmrc",
  "render.yaml",
  "README.md",
];
const EXCLUDE = new Set(["node_modules", ".next", ".git", ".env", "dist-debug", ".next-dev"]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string;
  data: Buffer;
}

function zip(entries: Entry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, e.data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(e.data.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + e.data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

async function walk(dir: string, base: string, out: Entry[]): Promise<void> {
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    if (EXCLUDE.has(item.name)) continue;
    const full = path.join(dir, item.name);
    const rel = base ? `${base}/${item.name}` : item.name;
    if (item.isDirectory()) await walk(full, rel, out);
    else if (item.isFile()) {
      const data = await readFile(full);
      out.push({ name: rel, data });
    }
  }
}

export async function GET() {
  const root = process.cwd();
  const entries: Entry[] = [];
  for (const file of INCLUDE_FILES) {
    try {
      entries.push({ name: file, data: await readFile(path.join(root, file)) });
    } catch {
      // optional file missing — skip
    }
  }
  for (const dir of INCLUDE_DIRS) {
    try {
      await walk(path.join(root, dir), dir, entries);
    } catch {
      // ignore missing directory
    }
  }
  if (!entries.length) {
    return Response.json({ ok: false, error: "nothing to bundle" }, { status: 500 });
  }
  const buf = zip(entries);
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="helix-quant-source.zip"',
      "cache-control": "no-store",
    },
  });
}
