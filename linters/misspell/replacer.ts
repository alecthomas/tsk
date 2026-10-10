// Ports github.com/golangci/misspell (v0.8.0, MIT license): its replacer,
// which corrects misspellings case-insensitively while keeping their case,
// and its recheck of changed lines.
//
// Upstream works on bytes, so text here is a byte string: each character is
// one byte of the UTF-8 encoding, and indexes are byte offsets.

import { decode, encode } from "../internal/utf8";

const ascii = /^[\x00-\x7f]*$/;

// toBytes converts text to a byte string.
export function toBytes(s: string): string {
  if (ascii.test(s)) {
    return s;
  }
  const bytes = encode(s);
  const chunks: string[] = [];
  // Converting in chunks keeps each call's argument list small.
  for (let i = 0; i < bytes.length; i += 4096) {
    chunks.push(String.fromCharCode(...bytes.slice(i, i + 4096)));
  }
  return chunks.join("");
}

// fromBytes converts a byte string to text.
export function fromBytes(s: string): string {
  if (ascii.test(s)) {
    return s;
  }
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    bytes.push(s.charCodeAt(i));
  }
  return decode(bytes);
}

// Diff is one misspelling on a line, at a byte offset.
export interface Diff {
  line: number;
  column: number;
  original: string;
  corrected: string;
}

class TrieNode {
  value = "";
  priority = 0;
  prefix = "";
  next: TrieNode | null = null;
  table: (TrieNode | null)[] | null = null;

  add(key: string, value: string, priority: number, r: Replacer): void {
    if (key === "") {
      // The first rule for a key wins.
      if (this.priority === 0) {
        this.value = value;
        this.priority = priority;
      }
      return;
    }
    if (this.prefix !== "") {
      let n = 0;
      while (n < this.prefix.length && n < key.length && this.prefix[n] === key[n]) {
        n++;
      }
      if (n === this.prefix.length) {
        this.next!.add(key.slice(n), value, priority, r);
      } else if (n === 0) {
        let prefixNode: TrieNode;
        if (this.prefix.length === 1) {
          prefixNode = this.next!;
        } else {
          prefixNode = new TrieNode();
          prefixNode.prefix = this.prefix.slice(1);
          prefixNode.next = this.next;
        }
        const keyNode = new TrieNode();
        this.table = new Array<TrieNode | null>(r.tableSize).fill(null);
        this.table[r.mapping[this.prefix.charCodeAt(0)]!] = prefixNode;
        this.table[r.mapping[key.charCodeAt(0)]!] = keyNode;
        this.prefix = "";
        this.next = null;
        keyNode.add(key.slice(1), value, priority, r);
      } else {
        const next = new TrieNode();
        next.prefix = this.prefix.slice(n);
        next.next = this.next;
        this.prefix = this.prefix.slice(0, n);
        this.next = next;
        next.add(key.slice(n), value, priority, r);
      }
      return;
    }
    if (this.table !== null) {
      const m = r.mapping[key.charCodeAt(0)]!;
      if (this.table[m] === null) {
        this.table[m] = new TrieNode();
      }
      this.table[m]!.add(key.slice(1), value, priority, r);
      return;
    }
    this.prefix = key;
    this.next = new TrieNode();
    this.next.add("", value, priority, r);
  }
}

// Replacer corrects misspellings by a list of byte-string pairs. Earlier
// pairs win, and a match keeps the case of the text it replaces.
export class Replacer {
  readonly mapping = new Uint8Array(256);
  tableSize = 0;
  private readonly root = new TrieNode();
  // corrected maps each misspelling to its correction; later pairs win.
  private readonly corrected = new Map<string, string>();

  constructor(pairs: readonly [string, string][]) {
    const keys = pairs.map(([typo]) => lowerBytes(typo));
    for (const key of keys) {
      for (let j = 0; j < key.length; j++) {
        this.mapping[key.charCodeAt(j)] = 1;
      }
    }
    for (const b of this.mapping) {
      this.tableSize += b;
    }
    let index = 0;
    for (let i = 0; i < 256; i++) {
      this.mapping[i] = this.mapping[i] === 0 ? this.tableSize : index++;
    }
    this.root.table = new Array<TrieNode | null>(this.tableSize).fill(null);
    pairs.forEach(([typo, correction], i) => {
      this.root.add(keys[i]!, correction, (pairs.length - i) * 2, this);
      this.corrected.set(typo, correction);
    });
  }

  replace(s: string): string {
    let out = "";
    let last = 0;
    let prevMatchEmpty = false;
    for (let i = 0; i <= s.length; ) {
      if (i !== s.length && this.root.priority === 0) {
        const index = this.mapping[byteToLower(s.charCodeAt(i))]!;
        if (index === this.tableSize || this.root.table![index] === null) {
          i++;
          continue;
        }
      }
      const [value, keyLength, match] = this.lookup(s, i, prevMatchEmpty);
      prevMatchEmpty = match && keyLength === 0;
      if (match) {
        out += s.slice(last, i) + withCase(value, s.slice(i, i + keyLength));
        i += keyLength;
        last = i;
        continue;
      }
      i++;
    }
    return last === 0 ? s : out + s.slice(last);
  }

  // lookup finds the best match starting at an offset, by index rather than
  // by slicing, which copies strings.
  private lookup(s: string, start: number, ignoreRoot: boolean): [string, number, boolean] {
    let bestPriority = 0;
    let node: TrieNode | null = this.root;
    let at = start;
    let value = "";
    let keyLength = 0;
    let found = false;
    while (node !== null) {
      if (node.priority > bestPriority && !(ignoreRoot && node === this.root)) {
        bestPriority = node.priority;
        value = node.value;
        keyLength = at - start;
        found = true;
      }
      if (at === s.length) {
        break;
      }
      if (node.table !== null) {
        const index = this.mapping[byteToLower(s.charCodeAt(at))]!;
        if (index === this.tableSize) {
          break;
        }
        node = node.table[index] ?? null;
        at++;
      } else if (node.prefix !== "" && hasPrefixFoldAt(s, at, node.prefix)) {
        at += node.prefix.length;
        node = node.next;
      } else {
        break;
      }
    }
    return [value, keyLength, found];
  }

  // recheckLine finds the words on a changed line that are themselves
  // misspellings, ignoring URLs, paths, emails, hosts, and escapes.
  recheckLine(s: string, line: number, diffs: Diff[]): void {
    const redacted = removeNotWords(s);
    for (const match of redacted.matchAll(/[a-zA-Z0-9']+/g)) {
      const start = match.index!;
      const word = s.slice(start, start + match[0].length);
      const corrected = this.replace(word);
      if (corrected === word || caseStyle(word) === "unknown") {
        continue;
      }
      if (stringEqualFold(this.corrected.get(lowerBytes(word)) ?? "", corrected)) {
        diffs.push({ line, column: start, original: word, corrected });
      }
    }
  }
}

type CaseStyle = "unknown" | "lower" | "upper" | "title";

// caseStyle classifies a word by its ASCII letters.
function caseStyle(word: string): CaseStyle {
  let upper = 0;
  let lower = 0;
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i);
    if (c >= 0x61 && c <= 0x7a) {
      lower++;
    } else if (c >= 0x41 && c <= 0x5a) {
      upper++;
    }
  }
  if (upper !== 0 && lower === 0) {
    return "upper";
  }
  if (upper === 0 && lower !== 0) {
    return "lower";
  }
  const first = word.charCodeAt(0);
  return upper === 1 && lower > 0 && first >= 0x41 && first <= 0x5a ? "title" : "unknown";
}

// withCase gives a correction the case of the text it replaces.
function withCase(value: string, original: string): string {
  switch (caseStyle(original)) {
    case "upper":
      return upperBytes(value);
    case "lower":
      return lowerBytes(value);
    case "title":
      return value.length < 2 ? upperBytes(value) : upperBytes(value.slice(0, 1)) + lowerBytes(value.slice(1));
  }
  return value;
}

function upperBytes(s: string): string {
  return ascii.test(s) ? s.toUpperCase() : toBytes(fromBytes(s).toUpperCase());
}

function lowerBytes(s: string): string {
  return ascii.test(s) ? s.toLowerCase() : toBytes(fromBytes(s).toLowerCase());
}

// byteToLower lowers an ASCII letter, as upstream's branchless version does.
function byteToLower(b: number): number {
  let x = ((b & 0x7f) + 0x25) & 0xff;
  x = ((x & 0x7f) + 0x1a) & 0xff;
  x = (((x & ~b & 0xff) >> 2) & 0x20) & 0xff;
  return (b + x) & 0xff;
}

// stringEqualFold compares ASCII letters without case.
function stringEqualFold(a: string, b: string): boolean {
  return a.length === b.length && equalFoldAt(a, 0, b);
}

// hasPrefixFoldAt reports whether s has prefix at an offset, comparing ASCII
// letters without case.
function hasPrefixFoldAt(s: string, at: number, prefix: string): boolean {
  return s.length - at >= prefix.length && equalFoldAt(s, at, prefix);
}

function equalFoldAt(s: string, at: number, t: string): boolean {
  for (let i = 0; i < t.length; i++) {
    let c1 = s.charCodeAt(at + i);
    let c2 = t.charCodeAt(i);
    if (c1 !== c2) {
      c1 |= 0x20;
      c2 |= 0x20;
      if (c1 !== c2 || c1 < 0x61 || c1 > 0x7a) {
        return false;
      }
    }
  }
  return true;
}

// The patterns upstream masks. Go's POSIX classes are ASCII.
const reURL = /(https?|ftp):\/\/(-\.)?([^\t\n\f\r /?.#]+\.?)+(\/[^\t\n\f\r ]*)?/gi;
const reEmail = /[A-Za-z0-9_.%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,6}[^A-Za-z]/g;
const reHost = /([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}/g;
const reBackslash = /\\[a-z]/g;

function blanks(s: string): string {
  return " ".repeat(s.length);
}

// removeNotWords blanks what is not prose, keeping offsets.
function removeNotWords(s: string): string {
  let out = removePath(s.replace(reURL, blanks));
  out = out.replace(reEmail, blanks);
  out = out.replace(reHost, (host) => (/[A-Z]/.test(host) ? host : blanks(host)));
  return out.replace(reBackslash, blanks);
}

// removePath blanks paths, such as /usr/lib, after a space or bracket.
function removePath(input: string): string {
  let s = input;
  let out = "";
  while (s !== "") {
    let idx = s.indexOf("/");
    if (idx === -1) {
      out += s;
      break;
    }
    if (idx > 0) {
      idx--;
    }
    let ends: string;
    switch (s[idx]) {
      case "/":
      case " ":
      case "\n":
      case "\t":
      case "\r":
        ends = " \n\r\t";
        break;
      case "[":
        ends = "]\n";
        break;
      case "(":
        ends = ")\n";
        break;
      default:
        out += s.slice(0, idx + 2);
        s = s.slice(idx + 2);
        continue;
    }
    const rest = s.slice(idx + 1);
    let end = -1;
    for (let i = 0; i < rest.length; i++) {
      if (ends.includes(rest[i]!)) {
        end = i;
        break;
      }
    }
    if (end === -1) {
      out += s;
      break;
    }
    out += s.slice(0, idx + 1) + " ".repeat(end);
    s = s.slice(idx + end + 1);
  }
  return out;
}
