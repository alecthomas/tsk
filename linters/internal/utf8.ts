// Go measures and indexes strings in UTF-8 bytes, so ports that report byte
// offsets or lengths convert with these.

export function byteLength(s: string): number {
  let n = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return n;
}

export function encode(s: string): number[] {
  const bytes: number[] = [];
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

// decode turns UTF-8 bytes back into a string, replacing invalid sequences
// with U+FFFD as Go does when converting.
export function decode(bytes: readonly number[]): string {
  let s = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    const size = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 0;
    const tail = bytes.slice(i + 1, i + size);
    if (size === 0 || tail.length !== size - 1 || tail.some((t) => (t & 0xc0) !== 0x80)) {
      s += "�";
      i++;
      continue;
    }
    const lead = size === 1 ? b : b & (0xff >> (size + 1));
    s += String.fromCodePoint(tail.reduce((code, t) => (code << 6) | (t & 0x3f), lead));
    i += size;
  }
  return s;
}
