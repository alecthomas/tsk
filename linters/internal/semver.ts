// Ports the parts of github.com/Masterminds/semver/v3 (v3.5.0, MIT license)
// that module guards use: lenient version parsing and constraint checks.
// Parse errors are thrown with the library's messages.

import { quote } from "./strconv";

const maxVersionLen = 256;
const maxConstraintLen = 512;
const maxConstraintGroups = 32;
const maxUint64 = (1n << 64n) - 1n;

// Go's \s matches only ASCII whitespace.
const space = "[\\t\\n\\f\\r ]";

const looseVersionRegex = /^v?([0-9]+)(\.[0-9]+)?(\.[0-9]+)?(-([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$/;

const num = "0123456789";
const allowed = `abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-${num}`;

export class Version {
  constructor(
    readonly major: bigint,
    readonly minor: bigint,
    readonly patch: bigint,
    readonly pre: string,
    readonly metadata: string,
  ) {}

  compare(o: Version): number {
    for (const [a, b] of [
      [this.major, o.major],
      [this.minor, o.minor],
      [this.patch, o.patch],
    ]) {
      if (a !== b) {
        return a < b ? -1 : 1;
      }
    }
    if (this.pre === "" && o.pre === "") {
      return 0;
    }
    if (this.pre === "") {
      return 1;
    }
    if (o.pre === "") {
      return -1;
    }
    return comparePrerelease(this.pre, o.pre);
  }
}

// newVersion parses a version leniently: a v prefix and missing minor and
// patch numbers are allowed.
export function newVersion(v: string): Version {
  if (v.length > maxVersionLen) {
    throw new Error(`version string is too long (max ${maxVersionLen} bytes)`);
  }
  const m = looseVersionRegex.exec(v);
  if (m === null) {
    throw new Error("invalid semantic version");
  }
  const segment = (text: string | undefined): bigint => {
    const digits = (text ?? "").replace(/^\./, "");
    if (digits === "") {
      return 0n;
    }
    const value = BigInt(digits);
    if (value > maxUint64) {
      throw new Error(`error parsing version segment: strconv.ParseUint: parsing "${digits}": value out of range`);
    }
    return value;
  };
  const version = new Version(segment(m[1]), segment(m[2]), segment(m[3]), m[5] ?? "", m[8] ?? "");
  if (version.pre !== "") {
    validatePrerelease(version.pre);
  }
  if (version.metadata !== "") {
    for (const part of version.metadata.split(".")) {
      if (part === "" || !containsOnly(part, allowed)) {
        throw new Error("invalid metadata string");
      }
    }
  }
  return version;
}

function validatePrerelease(pre: string): void {
  for (const part of pre.split(".")) {
    if (part === "") {
      throw new Error("invalid prerelease string");
    }
    if (containsOnly(part, num)) {
      if (part.length > 1 && part[0] === "0") {
        throw new Error("version segment starts with 0");
      }
    } else if (!containsOnly(part, allowed)) {
      throw new Error("invalid prerelease string");
    }
  }
}

function containsOnly(s: string, chars: string): boolean {
  return [...s].every((c) => chars.includes(c));
}

function comparePrerelease(v: string, o: string): number {
  const sparts = v.split(".");
  const oparts = o.split(".");
  for (let i = 0; i < Math.max(sparts.length, oparts.length); i++) {
    const d = comparePrePart(sparts[i] ?? "", oparts[i] ?? "");
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

function comparePrePart(s: string, o: string): number {
  if (s === o) {
    return 0;
  }
  if (s === "") {
    return -1;
  }
  if (o === "") {
    return 1;
  }
  const oi = parseUint(o);
  const si = parseUint(s);
  if (oi === null && si === null) {
    return s > o ? 1 : -1;
  }
  if (oi === null) {
    return -1;
  }
  if (si === null) {
    return 1;
  }
  return si > oi ? 1 : -1;
}

function parseUint(s: string): bigint | null {
  if (!/^[0-9]+$/.test(s)) {
    return null;
  }
  const value = BigInt(s);
  return value > maxUint64 ? null : value;
}

const ops = "=||!=|>|<|>=|=>|<=|=<|~|~>|\\^";
const cvRegex = "v?([0-9|x|X|\\*]+)(\\.[0-9|x|X|\\*]+)?(\\.[0-9|x|X|\\*]+)?(-([0-9A-Za-z\\-]+(\\.[0-9A-Za-z\\-]+)*))?(\\+([0-9A-Za-z\\-]+(\\.[0-9A-Za-z\\-]+)*))?";
const constraintRegex = new RegExp(`^${space}*(${ops})${space}*(${cvRegex})${space}*$`);
const constraintRangeSource = `${space}*(${cvRegex})${space}+-${space}+(${cvRegex})${space}*`;
const findConstraintSource = `(${ops})${space}*(${cvRegex})`;
const validConstraintRegex = new RegExp(`^(${space}*(${ops})${space}*(${cvRegex})${space}*)((?:${space}+|,${space}*)(${ops})${space}*(${cvRegex})${space}*)*$`);

type Op = "" | "=" | "!=" | ">" | "<" | ">=" | "=>" | "<=" | "=<" | "~" | "~>" | "^";

interface Constraint {
  con: Version;
  op: Op;
  // orig is the version as written.
  orig: string;
  minorDirty: boolean;
  patchDirty: boolean;
  dirty: boolean;
}

export class Constraints {
  constructor(
    private readonly groups: Constraint[][],
    private readonly containsPre: boolean[],
  ) {}

  // check reports whether a version meets every constraint of any group.
  // Prereleases match only groups that mention one.
  check(v: Version): boolean {
    return this.groups.some((group, i) => group.every((c) => checkConstraint(v, c, this.containsPre[i]!)));
  }

  // string formats the constraints as the library does, with each
  // constraint's operator and version as written.
  string(): string {
    return this.groups.map((group) => group.map((c) => c.op + c.orig).join(" ")).join(" || ");
  }
}

// newConstraint parses constraints such as ">= 1.2, < 2 || ^3".
export function newConstraint(c: string): Constraints {
  if (c.length > maxConstraintLen) {
    throw new Error(`constraint string is too long (max ${maxConstraintLen} bytes)`);
  }
  const ors = rewriteRange(c).split("||");
  if (ors.length > maxConstraintGroups) {
    throw new Error(`too many constraint groups (max ${maxConstraintGroups})`);
  }
  const groups: Constraint[][] = [];
  const containsPre: boolean[] = [];
  for (const or of ors) {
    if (!validConstraintRegex.test(or)) {
      throw new Error(`improper constraint: ${quote(or)}`);
    }
    const found = [...or.matchAll(new RegExp(findConstraintSource, "g"))].map((m) => m[0]);
    const parsed = (found.length > 0 ? found : [or]).map(parseConstraint);
    groups.push(parsed);
    containsPre.push(parsed.some((p) => p.con.pre !== ""));
  }
  return new Constraints(groups, containsPre);
}

function isX(x: string | undefined): boolean {
  return x === "x" || x === "*" || x === "X";
}

function parseConstraint(c: string): Constraint {
  if (c.length === 0) {
    return { con: new Version(0n, 0n, 0n, "", ""), op: "", orig: c, minorDirty: false, patchDirty: false, dirty: true };
  }
  const m = constraintRegex.exec(c);
  if (m === null) {
    throw new Error(`improper constraint: ${quote(c)}`);
  }
  const [, op, orig, major = "", minor = "", patch = "", pre = ""] = m;
  let ver = orig!;
  let minorDirty = false;
  let patchDirty = false;
  let dirty = false;
  if (isX(major) || major === "") {
    ver = `0.0.0${pre}`;
    dirty = true;
  } else if (isX(minor.replace(/^\./, "")) || minor === "") {
    minorDirty = true;
    dirty = true;
    ver = `${major}.0.0${pre}`;
  } else if (isX(patch.replace(/^\./, "")) || patch === "") {
    dirty = true;
    patchDirty = true;
    ver = `${major}${minor}.0${pre}`;
  }
  let con: Version;
  try {
    con = newVersion(ver);
  } catch {
    throw new Error("constraint parser error");
  }
  return { con, op: op as Op, orig: orig!, minorDirty, patchDirty, dirty };
}

function rewriteRange(input: string): string {
  let out = input;
  for (const m of input.matchAll(new RegExp(constraintRangeSource, "g"))) {
    out = out.replace(m[0], () => `>= ${m[1]}, <= ${m[11]} `);
  }
  return out;
}

function checkConstraint(v: Version, c: Constraint, includePre: boolean): boolean {
  if (v.pre !== "" && !includePre) {
    return false;
  }
  switch (c.op) {
    case "":
    case "=":
      return c.dirty ? tilde(v, c) : v.compare(c.con) === 0;
    case "!=":
      return notEqual(v, c);
    case ">":
      if (!c.dirty) {
        return v.compare(c.con) === 1;
      }
      if (v.major !== c.con.major) {
        return v.major > c.con.major;
      }
      if (c.minorDirty) {
        return false;
      }
      return c.patchDirty ? v.minor > c.con.minor : v.compare(c.con) === 1;
    case "<":
      return v.compare(c.con) < 0;
    case ">=":
    case "=>":
      return v.compare(c.con) >= 0;
    case "<=":
    case "=<":
      if (!c.dirty) {
        return v.compare(c.con) <= 0;
      }
      return !(v.major > c.con.major || (v.major === c.con.major && v.minor > c.con.minor && !c.minorDirty));
    case "~":
    case "~>":
      return tilde(v, c);
    case "^":
      return caret(v, c);
  }
}

function notEqual(v: Version, c: Constraint): boolean {
  if (c.dirty) {
    if (c.con.major !== v.major) {
      return true;
    }
    if (c.con.minor !== v.minor && !c.minorDirty) {
      return true;
    }
    if (c.minorDirty) {
      return false;
    }
    if (c.con.patch !== v.patch && !c.patchDirty) {
      return true;
    }
    if (c.patchDirty) {
      return (v.pre !== "" || c.con.pre !== "") && comparePrerelease(v.pre, c.con.pre) !== 0;
    }
  }
  return v.compare(c.con) !== 0;
}

function tilde(v: Version, c: Constraint): boolean {
  if (v.compare(c.con) < 0) {
    return false;
  }
  if (c.con.major === 0n && c.con.minor === 0n && c.con.patch === 0n && !c.minorDirty && !c.patchDirty) {
    return true;
  }
  if (v.major !== c.con.major) {
    return false;
  }
  return v.minor === c.con.minor || c.minorDirty;
}

function caret(v: Version, c: Constraint): boolean {
  if (v.compare(c.con) < 0) {
    return false;
  }
  if (c.con.major > 0n || c.minorDirty) {
    return v.major === c.con.major;
  }
  if (v.major > 0n) {
    return false;
  }
  if (c.con.minor > 0n || c.patchDirty) {
    return v.minor === c.con.minor;
  }
  if (v.minor > 0n) {
    return false;
  }
  return c.con.patch === v.patch;
}
