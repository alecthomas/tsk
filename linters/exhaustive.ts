import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import type * as inspector from "golang.org/x/tools/go/ast/inspector";
import { defineAnalyzer, defineFact, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Program elements to check: "switch" statements and "map" literals. */
  check: ("switch" | "map")[];
  /** A default case makes a switch exhaustive. */
  defaultSignifiesExhaustive: boolean;
  /** Constants to ignore, matching `<package path>.<name>`. */
  ignoreEnumMembers: string;
  /** Enum types to ignore, matching `<package path>.<name>`. */
  ignoreEnumTypes: string;
  /** Only treat constants declared at package level as enum members. */
  packageScopeOnly: boolean;
  /** Check only map literals with an //exhaustive:enforce comment. */
  explicitExhaustiveMap: boolean;
  /** Check only switches with an //exhaustive:enforce comment. */
  explicitExhaustiveSwitch: boolean;
  /** Require a default case even in exhaustive switches. */
  defaultCaseRequired: boolean;
}

// EnumMembers lists an enum type's constants in declaration order, with each
// one's constant value and position, which orders missing members.
interface EnumMembers {
  names: string[];
  values: Record<string, string>;
  positions: Record<string, number>;
}

const enumMembers = defineFact<EnumMembers>("enumMembers");

interface Enum {
  type: types.TypeName;
  members: EnumMembers;
}

const ignoreDirective = 1;
const enforceDirective = 2;
const ignoreDefaultCaseRequiredDirective = 4;
const enforceDefaultCaseRequiredDirective = 8;
const directives: Record<string, number> = {
  ignore: ignoreDirective,
  enforce: enforceDirective,
  "ignore-default-case-required": ignoreDefaultCaseRequiredDirective,
  "enforce-default-case-required": enforceDefaultCaseRequiredDirective,
};

export default defineAnalyzer<Config>({
  name: "exhaustive",
  doc: `check exhaustiveness of enum switch statements and map literals

An enum is a named type whose underlying type is an integer, float, or
string, with constants of that type declared in the same scope. A switch on an
enum must have a case for every member. //exhaustive:ignore on a switch or map
skips it; on a type or constant declaration it excludes those.`,
  requires: [inspect],
  facts: [enumMembers],
  // Enums declared in dependencies are known only through their facts.
  scope: "all",
  config: {
    check: ["switch"],
    defaultSignifiesExhaustive: false,
    ignoreEnumMembers: "",
    ignoreEnumTypes: "",
    packageScopeOnly: false,
    explicitExhaustiveMap: false,
    explicitExhaustiveSwitch: false,
    defaultCaseRequired: false,
  },
  run(pass) {
    new Checker(pass).run();
  },
});

class Checker {
  private readonly root: inspector.Cursor;
  private readonly commentMaps = new Map<ast.File, ast.CommentMap>();
  private readonly ignoreMember: RegExp | null;
  private readonly ignoreType: RegExp | null;

  constructor(private readonly pass: Pass<Config>) {
    this.root = pass.resultOf(inspect).root();
    this.ignoreMember = pass.config.ignoreEnumMembers === "" ? null : new RegExp(pass.config.ignoreEnumMembers);
    this.ignoreType = pass.config.ignoreEnumTypes === "" ? null : new RegExp(pass.config.ignoreEnumTypes);
  }

  run(): void {
    for (const [type, members] of this.findEnums()) {
      this.pass.exportObjectFact(type, enumMembers, members);
    }
    for (const element of this.pass.config.check) {
      if (element === "switch") {
        for (const cursor of this.root.preorder(ast.SwitchStmt)) {
          this.checkSwitch(cursor);
        }
      } else {
        for (const cursor of this.root.preorder(ast.CompositeLit)) {
          this.checkMap(cursor);
        }
      }
    }
  }

  // findEnums collects the package's enum types and their members.
  private findEnums(): Map<types.TypeName, EnumMembers> {
    const info = this.pass.typesInfo;
    const ignoredTypes = new Set<types.Type>();
    const decls = this.root
      .preorder(ast.GenDecl)
      .toArray()
      .map((cursor) => cursor.node() as ast.GenDecl);
    for (const decl of decls) {
      if (decl.tok !== token.TYPE) {
        continue;
      }
      const ignoreDecl = this.hasIgnoreDecl(decl.doc);
      for (const spec of decl.specs) {
        const typeSpec = spec as ast.TypeSpec;
        if (ignoreDecl || this.hasIgnoreDecl(typeSpec.doc)) {
          ignoredTypes.add(info.defs.get(typeSpec.name!)!.type()!);
        }
      }
    }
    const result = new Map<types.TypeName, EnumMembers>();
    for (const decl of decls) {
      if (decl.tok !== token.CONST || this.hasIgnoreDecl(decl.doc)) {
        continue;
      }
      for (const spec of decl.specs) {
        const valueSpec = spec as ast.ValueSpec;
        if (this.hasIgnoreDecl(valueSpec.doc)) {
          continue;
        }
        for (const name of valueSpec.names) {
          const object = info.defs.get(name!) as types.Const;
          if (ignoredTypes.has(object.type()!) || object.name() === "_" || !isNamedBasic(object.type())) {
            continue;
          }
          const typeName = (types.unalias(object.type()) as types.Named).obj()!;
          // The type and its constants must share a scope.
          if (typeName.parent() !== object.parent()) {
            continue;
          }
          if (this.pass.config.packageScopeOnly && typeName.parent() !== this.pass.pkg.scope()) {
            continue;
          }
          let members = result.get(typeName);
          if (members === undefined) {
            members = { names: [], values: {}, positions: {} };
            result.set(typeName, members);
          }
          members.names.push(object.name());
          members.values[object.name()] = object.val()!.exactString();
          members.positions[object.name()] = name!.pos();
        }
      }
    }
    return result;
  }

  private hasIgnoreDecl(doc: ast.CommentGroup | null): boolean {
    const [found, error] = parseDirectives([doc]);
    if (error !== null) {
      this.pass.report({ pos: doc!.pos(), end: doc!.end(), message: `failed to parse directives: ${error}` });
      return false;
    }
    return (found & ignoreDirective) !== 0;
  }

  private commentsFor(cursor: inspector.Cursor, node: ast.Node): (ast.CommentGroup | null)[] {
    const file = cursor.enclosing(ast.File).toArray()[0].node() as ast.File;
    let map = this.commentMaps.get(file);
    if (map === undefined) {
      map = ast.newCommentMap(this.pass.fset, file, file.comments);
      this.commentMaps.set(file, map);
    }
    return map.get(node) ?? [];
  }

  private checkSwitch(cursor: inspector.Cursor): void {
    const stmt = cursor.node() as ast.SwitchStmt;
    const config = this.pass.config;
    const [found, error] = parseDirectives(this.commentsFor(cursor, stmt));
    if (error !== null) {
      this.pass.report({ pos: stmt.pos(), end: stmt.end(), message: `failed to parse directives: ${error}` });
    }
    if (config.explicitExhaustiveSwitch ? (found & enforceDirective) === 0 : (found & ignoreDirective) !== 0) {
      return;
    }
    let requireDefault = config.defaultCaseRequired;
    if ((found & ignoreDefaultCaseRequiredDirective) !== 0) {
      requireDefault = false;
    }
    if ((found & enforceDefaultCaseRequiredDirective) !== 0) {
      requireDefault = true;
    }
    if (stmt.tag === null) {
      return;
    }
    const tag = this.pass.typesInfo.types.get(stmt.tag);
    if (tag === undefined || !tag.isValue()) {
      return;
    }
    const enums = this.composingEnums(tag.type);
    if (enums === null || enums.length === 0) {
      return;
    }
    const checklist = this.checklist(enums);
    let hasDefault = false;
    for (const clause of stmt.body!.list) {
      const caseClause = clause as ast.CaseClause;
      if (caseClause.list.length === 0) {
        hasDefault = true;
      }
      for (const expr of caseClause.list) {
        const value = this.constantValue(expr!);
        if (value !== null) {
          checklist.found(value);
        }
      }
    }
    const enumTypes = dedup(enums.map((e) => e.type));
    if (!hasDefault && requireDefault) {
      this.pass.report({ pos: stmt.pos(), end: stmt.end(), message: `missing default case in switch of type ${typeNames(enumTypes)}` });
      return;
    }
    if (checklist.remaining.length === 0 || (hasDefault && config.defaultSignifiesExhaustive)) {
      return;
    }
    this.pass.report({
      pos: stmt.pos(),
      end: stmt.end(),
      message: `missing cases in switch of type ${typeNames(enumTypes)}: ${groupNames(checklist.remaining, enumTypes)}`,
    });
  }

  private checkMap(cursor: inspector.Cursor): void {
    const lit = cursor.node() as ast.CompositeLit;
    if (lit.type === null) {
      return;
    }
    let mapType = types.unalias(this.pass.typesInfo.types.get(lit.type)?.type ?? null);
    if (mapType?.$type === "Named") {
      mapType = mapType.underlying();
    }
    if (mapType?.$type !== "Map" || lit.elts.length === 0) {
      return;
    }
    // Upstream gathers comments from every enclosing node of these kinds,
    // as its loop's break leaves only the switch.
    const related: (ast.CommentGroup | null)[] = [];
    const kinds = [ast.CompositeLit, ast.ReturnStmt, ast.IndexExpr, ast.CallExpr, ast.UnaryExpr, ast.AssignStmt, ast.DeclStmt, ast.GenDecl, ast.ValueSpec];
    for (const enclosing of cursor.enclosing(...kinds)) {
      related.push(...this.commentsFor(cursor, enclosing.node()!));
    }
    const [found, error] = parseDirectives(related);
    if (error !== null) {
      this.pass.report({ pos: lit.pos(), end: lit.end(), message: `failed to parse directives: ${error}` });
    }
    if (this.pass.config.explicitExhaustiveMap ? (found & enforceDirective) === 0 : (found & ignoreDirective) !== 0) {
      return;
    }
    const enums = this.composingEnums(mapType.key());
    if (enums === null || enums.length === 0) {
      return;
    }
    const checklist = this.checklist(enums);
    for (const element of lit.elts) {
      if (element?.$type === "KeyValueExpr") {
        const value = this.constantValue(element.key!);
        if (value !== null) {
          checklist.found(value);
        }
      }
    }
    if (checklist.remaining.length === 0) {
      return;
    }
    const enumTypes = dedup(enums.map((e) => e.type));
    this.pass.report({
      pos: lit.pos(),
      end: lit.end(),
      message: `missing keys in map of key type ${typeNames(enumTypes)}: ${groupNames(checklist.remaining, enumTypes)}`,
    });
  }

  private checklist(enums: Enum[]): Checklist {
    const checklist = new Checklist();
    for (const { type, members } of enums) {
      const path = type.pkg()!.path();
      const includeUnexported = this.pass.pkg === type.pkg();
      checklist.add(type, members, (name) => {
        return (
          name === "_" ||
          (!ast.isExported(name) && !includeUnexported) ||
          (this.ignoreMember?.test(`${path}.${name}`) ?? false) ||
          (this.ignoreType?.test(`${path}.${type.name()}`) ?? false)
        );
      });
    }
    return checklist;
  }

  // composingEnums returns the enums a type is made of: itself, or the terms
  // of a type parameter's constraint, or null if any term is not an enum.
  private composingEnums(t: types.Type | null): Enum[] | null {
    const typeParam = t?.$type === "TypeParam";
    const enums = this.fromType(t, typeParam);
    if (enums === null || !typeParam) {
      return enums;
    }
    // A type parameter's enums must share a basic kind.
    let kind: number | undefined;
    for (const e of enums) {
      const basic = e.type.type()?.underlying();
      if (basic?.$type !== "Basic" || (kind !== undefined && kind !== basic.kind())) {
        return null;
      }
      kind = basic.kind();
    }
    return enums;
  }

  private fromType(t: types.Type | null, typeParam: boolean): Enum[] | null {
    switch (t?.$type) {
      case "Alias":
        return this.fromType(types.unalias(t), typeParam);
      case "Named": {
        const object = t.obj()!;
        if (object.pkg() === null) {
          return null;
        }
        const members = this.pass.importObjectFact(object, enumMembers);
        if (members !== undefined) {
          return [{ type: object, members }];
        }
        const underlying = t.underlying();
        return typeParam && underlying?.$type === "Interface" ? this.fromInterface(underlying, typeParam) : null;
      }
      case "Union":
        return this.combine([...Array(t.len()).keys()].map((i) => this.fromType(t.term(i)!.type(), typeParam)));
      case "TypeParam":
        return this.fromType(t.constraint()!.underlying(), typeParam);
      case "Interface":
        return typeParam ? this.fromInterface(t, typeParam) : [];
    }
    return [];
  }

  private fromInterface(iface: types.Interface, typeParam: boolean): Enum[] | null {
    return this.combine([...Array(iface.numEmbeddeds()).keys()].map((i) => this.fromType(iface.embeddedType(i), typeParam)));
  }

  // combine joins the enums of several terms, or is null if any term failed.
  private combine(parts: (Enum[] | null)[]): Enum[] | null {
    return parts.some((part) => part === null) ? null : parts.flatMap((part) => part!);
  }

  // constantValue returns the exact value of a constant expression naming a
  // constant, seeing through parentheses and conversions.
  private constantValue(expr: ast.Expr): string | null {
    const e = stripConversions(this.pass.typesInfo, ast.unparen(expr)!);
    let ident: ast.Ident | null = null;
    if (e.$type === "Ident") {
      ident = e;
    } else if (e.$type === "SelectorExpr") {
      const x = ast.unparen(e.x);
      if (x?.$type !== "Ident" || this.pass.typesInfo.objectOf(x)?.$type !== "PkgName") {
        return null;
      }
      ident = e.sel;
    }
    const object = ident === null ? null : this.pass.typesInfo.uses.get(ident);
    if (object?.$type !== "Const") {
      return null;
    }
    return object.val()!.exactString();
  }
}

function stripConversions(info: types.Info, expr: ast.Expr): ast.Expr {
  if (expr.$type !== "CallExpr") {
    return expr;
  }
  const t = info.typeOf(expr.fun);
  if (t === null || t.underlying()?.$type === "Signature" || expr.args.length !== 1) {
    return expr;
  }
  return stripConversions(info, ast.unparen(expr.args[0])!);
}

interface Member {
  type: types.TypeName;
  name: string;
  value: string;
  pos: number;
}

// Checklist tracks the members not yet matched by a case or key. Members are
// keyed by position, so an enum appearing twice in a constraint counts once.
class Checklist {
  private readonly members = new Map<number, Member>();
  private readonly byValue = new Map<string, Member[]>();

  get remaining(): Member[] {
    return [...this.members.values()];
  }

  add(type: types.TypeName, members: EnumMembers, skip: (name: string) => boolean): void {
    for (const name of members.names) {
      const member = { type, name, value: members.values[name], pos: members.positions[name] };
      this.byValue.set(member.value, [...(this.byValue.get(member.value) ?? []), member]);
      if (!skip(name)) {
        this.members.set(member.pos, member);
      }
    }
  }

  // found marks every member with a value as handled, whatever its enum.
  found(value: string): void {
    for (const member of this.byValue.get(value) ?? []) {
      this.members.delete(member.pos);
    }
  }
}

// groupNames lists missing members, those sharing a value joined by |, in
// enum and declaration order.
function groupNames(missing: Member[], enums: types.TypeName[]): string {
  const order = (m: Member) => enums.indexOf(m.type);
  const before = (a: Member, b: Member) => order(a) - order(b) || a.pos - b.pos;
  const groups = new Map<string, Member[]>();
  for (const member of missing) {
    groups.set(member.value, [...(groups.get(member.value) ?? []), member]);
  }
  const sorted = [...groups.values()].map((group) => group.sort(before)).sort((a, b) => before(a[0], b[0]));
  return sorted.map((group) => group.map((m) => `${m.type.pkg()!.name()}.${m.name}`).join("|")).join(", ");
}

function typeNames(enums: types.TypeName[]): string {
  return enums.map((type) => `${type.pkg()!.name()}.${type.name()}`).join("|");
}

function dedup<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isNamedBasic(t: types.Type | null): boolean {
  const named = types.unalias(t);
  const basic = named?.$type === "Named" ? named.underlying() : null;
  if (basic?.$type !== "Basic") {
    return false;
  }
  const info = basic.info();
  return (info & (types.IsInteger | types.IsFloat | types.IsString)) !== 0;
}

// parseDirectives reads //exhaustive: directives from comment groups,
// returning them with an error message for an invalid or conflicting one.
function parseDirectives(groups: (ast.CommentGroup | null)[]): [number, string | null] {
  let found = 0;
  for (const group of groups) {
    for (const comment of group?.list ?? []) {
      if (!comment!.text.startsWith("//exhaustive:")) {
        continue;
      }
      const directive = comment!.text.slice("//exhaustive:".length).split(/[ \t]/)[0];
      const flag = directives[directive];
      if (flag === undefined) {
        return [found, `invalid directive "${directive}"`];
      }
      found |= flag;
    }
  }
  if ((found & (ignoreDirective | enforceDirective)) === (ignoreDirective | enforceDirective)) {
    return [found, 'conflicting directives "ignore" and "enforce"'];
  }
  const defaults = ignoreDefaultCaseRequiredDirective | enforceDefaultCaseRequiredDirective;
  if ((found & defaults) === defaults) {
    return [found, 'conflicting directives "ignore-default-case-required" and "enforce-default-case-required"'];
  }
  return [found, null];
}
