import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { type Directive, optionality, type Scanner } from "./directives";

export const anonymousName = "<anonymous>";

// PatternList matches regular expressions against whole type names.
export class PatternList {
  private readonly res: RegExp[];

  constructor(patterns: readonly string[]) {
    this.res = patterns.map((p) => {
      if (p === "") {
        throw new Error("empty regular expression is not allowed");
      }
      return new RegExp(`^(?:${p})$`);
    });
  }

  matchFull(target: string): boolean {
    return this.res.some((re) => re.test(target));
  }

  // matchFullExcept matches target unless the same pattern also matches the
  // whole of excepted, which makes it a rule for neither in particular.
  matchFullExcept(target: string, excepted: string): boolean {
    return this.res.some((re) => re.test(target) && !re.test(excepted));
  }
}

export interface Patterns {
  enforce: PatternList;
  ignore: PatternList;
  optional: PatternList;
  allowEmpty: PatternList;
}

interface FieldInfo {
  name: string;
  exported: boolean;
  enforced: boolean;
  optional: boolean;
  embedded: StructFields | null;
}

// StructFields is a struct's raw field data, independent of the type name.
interface StructFields {
  strct: types.Struct;
  packagePath: string;
  fields: FieldInfo[];
}

export interface Field {
  name: string;
  exported: boolean;
  enforced: boolean;
  optional: boolean;
  // A pattern names this field in its own right, not by its type.
  patternEnforced: boolean;
  patternOptional: boolean;
  // A promoted field a literal of the outer type cannot name.
  shadowed: boolean;
  // Fields an embedded struct promotes; null for every other field.
  embedded: Fields | null;
}

export interface Fields {
  packagePath: string;
  items: Field[];
  // Every name a literal of the outer type may write, mapped to the chain of
  // field indices reaching it. Set on the outermost level only.
  paths: Map<string, number[]> | null;
}

export interface Struct {
  name: string;
  fullPath: string;
  packageName: string;
  fields: Fields;
  enforced: boolean;
  ignored: boolean;
  optional: boolean;
  patternEnforced: boolean;
  patternIgnored: boolean;
  patternOptional: boolean;
  allowEmptyDecl: boolean;
}

function packagePathOf(s: Struct): string {
  const i = s.fullPath.lastIndexOf(".");
  return i >= 0 ? s.fullPath.slice(0, i) : s.fullPath;
}

export const isEnforced = (s: Struct) => s.enforced || s.patternEnforced;
export const isIgnored = (s: Struct) => s.ignored || s.patternIgnored;
const isOptional = (s: Struct) => s.optional || s.patternOptional;

// Processor builds and caches struct metadata for one package.
export class Processor {
  private readonly fieldsCache = new Map<types.Struct, StructFields>();
  // Named types are keyed by declaration, anonymous ones by struct type.
  private readonly structCache = new Map<types.TypeName | types.Struct, Map<types.Struct, Struct>>();

  constructor(
    private readonly fset: token.FileSet,
    readonly directives: Scanner,
    private readonly patterns: Patterns,
  ) {}

  resolveStruct(typeName: types.TypeName | null, strct: types.Struct, pos: token.Pos, callerPkg: types.Package): Struct {
    const key = typeName ?? strct;
    let byStruct = this.structCache.get(key);
    if (byStruct === undefined) {
      byStruct = new Map();
      this.structCache.set(key, byStruct);
    }
    const cached = byStruct.get(strct);
    if (cached !== undefined) {
      return cached;
    }
    const pkg = typeName?.pkg() ?? callerPkg;
    const name = typeName?.name() ?? anonymousName;
    const s: Struct = {
      name,
      fullPath: `${pkg.path()}.${name}`,
      packageName: pkg.name(),
      fields: { packagePath: "", items: [], paths: null },
      enforced: false,
      ignored: false,
      optional: false,
      patternEnforced: false,
      patternIgnored: false,
      patternOptional: false,
      allowEmptyDecl: false,
    };
    s.fields = this.buildFields(s, this.structFields(strct));
    s.fields.paths = indexPromotion(s.fields);
    const position = this.fset.positionFor(pos, false);
    if (position.filename !== "" && position.line > 0) {
      const dirs = this.directives.lookup({ filename: position.filename, line: position.line });
      s.enforced = dirs.includes("enforce");
      s.ignored = dirs.includes("ignore");
      s.optional = dirs.includes("optional");
    }
    s.patternEnforced = this.patterns.enforce.matchFull(s.fullPath);
    s.patternIgnored = this.patterns.ignore.matchFull(s.fullPath);
    s.patternOptional = this.patterns.optional.matchFull(s.fullPath);
    s.allowEmptyDecl = this.patterns.allowEmpty.matchFull(s.fullPath);
    byStruct.set(strct, s);
    return s;
  }

  fieldDirectives(field: types.Var): Directive[] {
    return this.directives.lookupPos(field.pos());
  }

  private structFields(strct: types.Struct): StructFields {
    const cached = this.fieldsCache.get(strct);
    if (cached !== undefined) {
      return cached;
    }
    const result: StructFields = { strct, packagePath: "", fields: [] };
    for (let i = 0; i < strct.numFields(); i++) {
      const f = strct.field(i)!;
      if (result.packagePath === "" && f.pkg() !== null) {
        result.packagePath = f.pkg()!.path();
      }
      // Embedded pointers promote nothing a literal can write.
      const embedded = f.embedded() ? types.unalias(f.type())!.underlying() : null;
      const o = optionality(this.fieldDirectives(f));
      result.fields.push({
        name: f.name(),
        exported: f.exported(),
        enforced: o.enforced,
        optional: o.optional,
        embedded: embedded?.$type === "Struct" ? this.structFields(embedded) : null,
      });
    }
    this.fieldsCache.set(strct, result);
    return result;
  }

  // buildFields opens each embedded struct once, at the depth it is first
  // reached and only where it is reached once, as Go resolves promoted names.
  private buildFields(s: Struct, resolved: StructFields): Fields {
    const { fields: root, pending } = this.levelFields(s, resolved);
    const opened = new Set<types.Struct>([resolved.strct]);
    let level = pending.map((p) => ({ ...p, owner: root }));
    while (level.length > 0) {
      const occurrences = new Map<types.Struct, number>();
      for (const e of level) {
        occurrences.set(e.resolved.strct, (occurrences.get(e.resolved.strct) ?? 0) + 1);
      }
      const next: typeof level = [];
      for (const e of level) {
        if (opened.has(e.resolved.strct) || occurrences.get(e.resolved.strct)! > 1) {
          continue;
        }
        opened.add(e.resolved.strct);
        const sub = this.levelFields(s, e.resolved);
        e.owner.items[e.index].embedded = sub.fields;
        next.push(...sub.pending.map((p) => ({ ...p, owner: sub.fields })));
      }
      for (const strct of occurrences.keys()) {
        opened.add(strct);
      }
      level = next;
    }
    return root;
  }

  private levelFields(s: Struct, resolved: StructFields): { fields: Fields; pending: { index: number; resolved: StructFields }[] } {
    const external = resolved.packagePath !== packagePathOf(s);
    const fields: Fields = { packagePath: resolved.packagePath, items: [], paths: null };
    const pending: { index: number; resolved: StructFields }[] = [];
    for (const sf of resolved.fields) {
      // An unexported field of another package can never be written, but an
      // embedded one still promotes exported fields.
      if (external && !sf.exported && sf.embedded === null) {
        continue;
      }
      const fieldPath = `${s.fullPath}#${sf.name}`;
      fields.items.push({
        name: sf.name,
        exported: sf.exported,
        enforced: sf.enforced,
        optional: sf.optional,
        patternEnforced: this.patterns.enforce.matchFullExcept(fieldPath, s.fullPath),
        patternOptional: this.patterns.optional.matchFullExcept(fieldPath, s.fullPath),
        shadowed: false,
        embedded: null,
      });
      if (sf.embedded !== null) {
        pending.push({ index: fields.items.length - 1, resolved: sf.embedded });
      }
    }
    return { fields, pending };
  }
}

// promotionKey names a field the way a literal's key resolves to it: an
// unexported name belongs to the package that wrote it.
function promotionKey(pkgPath: string, name: string): string {
  return token.isExported(name) ? name : `${pkgPath}.${name}`;
}

// indexPromotion maps every name a literal may write to its field path, and
// marks fields a shallower or same-depth field of the same name shadows.
function indexPromotion(fs: Fields): Map<string, number[]> {
  const paths = new Map<string, number[]>();
  const blocked = new Set<string>();
  let level: { fields: Fields; path: number[] }[] = [{ fields: fs, path: [] }];
  while (level.length > 0) {
    const atDepth = new Map<string, number>();
    for (const l of level) {
      for (const item of l.fields.items) {
        const key = promotionKey(l.fields.packagePath, item.name);
        atDepth.set(key, (atDepth.get(key) ?? 0) + 1);
      }
    }
    const next: typeof level = [];
    for (const l of level) {
      l.fields.items.forEach((item, i) => {
        const path = [...l.path, i];
        const key = promotionKey(l.fields.packagePath, item.name);
        item.shadowed = blocked.has(key) || atDepth.get(key)! > 1;
        if (!item.shadowed) {
          paths.set(key, path);
        }
        if (item.embedded !== null) {
          next.push({ fields: item.embedded, path });
        }
      });
    }
    for (const key of atDepth.keys()) {
      blocked.add(key);
    }
    level = next;
  }
  return paths;
}

// KeyGroups holds a literal's keys arranged by the embedded fields they
// reach through.
class KeyGroups {
  readonly named = new Set<number>();
  readonly children = new Map<number, KeyGroups>();

  add(path: readonly number[]): void {
    let g: KeyGroups = this;
    for (const i of path.slice(0, -1)) {
      let child = g.children.get(i);
      if (child === undefined) {
        child = new KeyGroups();
        g.children.set(i, child);
      }
      g = child;
    }
    g.named.add(path[path.length - 1]);
  }
}

const unreachable = (f: Field, external: boolean) => f.shadowed || (external && !f.exported);
const optedOut = (f: Field) => f.optional || f.patternOptional;

function isFieldRequired(s: Struct, f: Field, external: boolean): boolean {
  if (unreachable(f, external)) {
    return false;
  }
  if (f.enforced) {
    return true;
  }
  if (f.optional) {
    return false;
  }
  if (f.patternEnforced) {
    return true;
  }
  if (f.patternOptional) {
    return false;
  }
  return !isOptional(s);
}

// skippedFields returns the required fields a literal leaves out. Since Go
// 1.27 a literal may name a promoted field in place of its embedded field.
export function skippedFields(s: Struct, lit: ast.CompositeLit, callerPkgPath: string, canNamePromoted: boolean): Field[] {
  const named = lit.elts.length > 0 && lit.elts[0]!.$type === "KeyValueExpr";
  if (!named && lit.elts.length > 0) {
    const external = s.fields.packagePath !== callerPkgPath;
    return s.fields.items.slice(lit.elts.length).filter((f) => isFieldRequired(s, f, external));
  }
  const groups = new KeyGroups();
  for (const elt of lit.elts) {
    if (elt!.$type !== "KeyValueExpr" || elt.key?.$type !== "Ident") {
      continue;
    }
    const path = s.fields.paths!.get(promotionKey(callerPkgPath, elt.key.name));
    if (path !== undefined && (path.length === 1 || canNamePromoted)) {
      groups.add(path);
    }
  }
  return skippedIn(s, s.fields, groups, callerPkgPath, canNamePromoted, []);
}

function skippedIn(s: Struct, fs: Fields, groups: KeyGroups | undefined, callerPkgPath: string, canNamePromoted: boolean, missing: Field[]): Field[] {
  const external = fs.packagePath !== callerPkgPath;
  fs.items.forEach((f, i) => {
    // A keyed literal cannot name a blank field.
    if (groups?.named.has(i) || f.name === "_") {
      return;
    }
    const child = groups?.children.get(i);
    if (!isFieldRequired(s, f, external)) {
      skippedUnder(s, f, child, callerPkgPath, external, canNamePromoted, missing);
    } else if (child !== undefined) {
      skippedIn(s, f.embedded!, child, callerPkgPath, canNamePromoted, missing);
    } else {
      missing.push(f);
    }
  });
  return missing;
}

// skippedUnder finds fields enforced in their own right under an embedded
// field nothing requires. Before Go 1.27 only the embedded field reaches them.
function skippedUnder(
  s: Struct,
  f: Field,
  groups: KeyGroups | undefined,
  callerPkgPath: string,
  external: boolean,
  canNamePromoted: boolean,
  missing: Field[],
): void {
  if (f.embedded === null || optedOut(f)) {
    return;
  }
  if (canNamePromoted) {
    skippedIn(s, f.embedded, groups, callerPkgPath, canNamePromoted, missing);
  } else if (!unreachable(f, external) && requiresAnyBelow(s, f.embedded, callerPkgPath)) {
    missing.push(f);
  }
}

function requiresAnyBelow(s: Struct, fs: Fields, callerPkgPath: string): boolean {
  const external = fs.packagePath !== callerPkgPath;
  return fs.items.some((f) => {
    if (f.name === "_" || unreachable(f, external)) {
      return false;
    }
    return isFieldRequired(s, f, external) || (f.embedded !== null && !optedOut(f) && requiresAnyBelow(s, f.embedded, callerPkgPath));
  });
}
