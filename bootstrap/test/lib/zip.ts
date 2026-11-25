// Minimal zip reader and writer for building fixture archives (corrupt, extra member,
// renamed member). Entries keep their raw (possibly deflated) data, so a real archive can
// be taken apart and put back together without recompressing the Bun binary.

export interface ZipEntry {
  name: string;
  versionMade: number;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  size: number;
  externalAttrs: number;
  raw: Uint8Array; // the stored (possibly deflated) bytes
}

export function readZip(buf: Uint8Array): ZipEntry[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("readZip: no end of central directory");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("readZip: bad central header");
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const compressedSize = v.getUint32(p + 20, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = v.getUint16(local + 26, true);
    const lExtraLen = v.getUint16(local + 28, true);
    const dataStart = local + 30 + lNameLen + lExtraLen;
    out.push({
      name,
      versionMade: v.getUint16(p + 4, true),
      flags: v.getUint16(p + 8, true),
      method: v.getUint16(p + 10, true),
      time: v.getUint16(p + 12, true),
      date: v.getUint16(p + 14, true),
      crc: v.getUint32(p + 16, true),
      compressedSize,
      size: v.getUint32(p + 24, true),
      externalAttrs: v.getUint32(p + 38, true),
      raw: buf.subarray(dataStart, dataStart + compressedSize),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** A small stored (method 0) file entry, for extra members. */
export function fileEntry(name: string, content: Uint8Array, mode = 0o644): ZipEntry {
  return {
    name,
    versionMade: (3 << 8) | 20,
    flags: 0x0800,
    method: 0,
    time: 0,
    date: 0x21, // 1980-01-01
    crc: Bun.hash.crc32(content) >>> 0,
    compressedSize: content.length,
    size: content.length,
    externalAttrs: ((0o100000 | mode) << 16) >>> 0,
    raw: content,
  };
}

export function writeZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (b: Uint8Array) => {
    parts.push(b);
    offset += b.length;
  };
  for (const e of entries) {
    const name = enc.encode(e.name);
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, e.flags | 0x0800, true);
    lv.setUint16(8, e.method, true);
    lv.setUint16(10, e.time, true);
    lv.setUint16(12, e.date, true);
    lv.setUint32(14, e.crc, true);
    lv.setUint32(18, e.compressedSize, true);
    lv.setUint32(22, e.size, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, e.versionMade, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, e.flags | 0x0800, true);
    cv.setUint16(10, e.method, true);
    cv.setUint16(12, e.time, true);
    cv.setUint16(14, e.date, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.compressedSize, true);
    cv.setUint32(24, e.size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, e.externalAttrs, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    central.push(ch);
    push(lh);
    push(e.raw);
  }
  const cdStart = offset;
  for (const c of central) push(c);
  const cdSize = offset - cdStart;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  push(end);
  const out = new Uint8Array(offset);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
