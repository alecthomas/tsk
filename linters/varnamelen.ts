import * as ast from "go/ast";
import * as token from "go/token";
import type * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { byteLength } from "./internal/utf8";

interface Config {
  /** Most lines between a declaration and a use that count as a small scope. */
  maxDistance: number;
  /** Shortest name that counts as long. */
  minNameLength: number;
  /** Check method receivers. */
  checkReceiver: boolean;
  /** Check named return values. */
  checkReturn: boolean;
  /** Check type parameters. */
  checkTypeParam: boolean;
  /** Names to ignore. */
  ignoreNames: readonly string[];
  /** Ignore ok from a type assertion. */
  ignoreTypeAssertOk: boolean;
  /** Ignore ok from a map index. */
  ignoreMapIndexOk: boolean;
  /** Ignore ok from a channel receive. */
  ignoreChanRecvOk: boolean;
  /** Declarations to ignore, as "name type" or "const name". */
  ignoreDecls: readonly string[];
}

interface Declaration {
  name: string;
  constant: boolean;
  typ: string;
}

interface ImportDecl {
  name: string;
  path: string;
  self: boolean;
}

// Candidate is a declared name with the farthest use found so far. Uses
// replace each other in source order, so the last use decides.
interface Candidate {
  kind: "variable" | "constant" | "parameter" | "return value" | "type parameter";
  name: string;
  typ: string;
  // The declaring statement, spec or field, where the report goes.
  decl: ast.AssignStmt | ast.ValueSpec | ast.Field;
  dist: number;
}

const parseDeclaration = (decl: string): Declaration => {
  if (decl.startsWith("const ")) {
    return { name: decl.slice("const ".length), constant: true, typ: "" };
  }
  const space = decl.indexOf(" ");
  return { name: decl.slice(0, space), constant: false, typ: decl.slice(space + 1) };
};

const conventionalDecls = ["ctx context.Context", "b *testing.B", "f *testing.F", "m *testing.M", "pb *testing.PB", "t *testing.T", "tb testing.TB"].map(
  parseDeclaration,
);

// splitList reads a list the way upstream's comma-separated flags do.
function splitList(values: readonly string[]): string[] {
  const joined = values.join(",");
  return joined.trim() === "" ? [] : joined.split(",").map((s) => s.trim());
}

export default defineAnalyzer<Config>({
  name: "varnamelen",
  doc: `checks that the length of a variable's name matches its scope

A variable with a short name can be hard to use if the variable is used
over a longer span of lines of code. A longer variable name may be easier
to comprehend.`,
  requires: [inspect],
  config: {
    maxDistance: 5,
    minNameLength: 3,
    checkReceiver: false,
    checkReturn: false,
    checkTypeParam: false,
    ignoreNames: [],
    ignoreTypeAssertOk: false,
    ignoreMapIndexOk: false,
    ignoreChanRecvOk: false,
    ignoreDecls: [],
  },
  run(pass) {
    const c = pass.config;
    const maxDistance = c.maxDistance > 0 ? c.maxDistance : 5;
    const minNameLength = c.minNameLength > 0 ? c.minNameLength : 3;
    const ignoreNames = splitList(c.ignoreNames);
    const ignoreDecls = splitList(c.ignoreDecls).map(parseDeclaration);
    for (const cand of candidates(pass)) {
      if (ignoreNames.includes(cand.name) || ignoreDecls.some((d) => matches(cand, d))) {
        continue;
      }
      if (byteLength(cand.name) >= minNameLength || cand.dist <= maxDistance) {
        continue;
      }
      if (cand.kind === "variable" || cand.kind === "constant") {
        const assign = cand.decl.$type === "AssignStmt" ? cand.decl : null;
        if (
          (c.ignoreTypeAssertOk && isOk(cand, assign, "TypeAssertExpr")) ||
          (c.ignoreMapIndexOk && isOk(cand, assign, "IndexExpr")) ||
          (c.ignoreChanRecvOk && isOk(cand, assign, "Recv"))
        ) {
          continue;
        }
      }
      if ((cand.kind === "variable" || cand.kind === "constant" || cand.kind === "parameter") && conventionalDecls.some((d) => matches(cand, d))) {
        continue;
      }
      pass.report({ pos: cand.decl.pos(), message: `${cand.kind} name '${cand.name}' is too short for the scope of its usage` });
    }
  },
});

// matches reports whether a declared name matches an ignore or conventional
// declaration. Variables also compare constness.
function matches(cand: Candidate, decl: Declaration): boolean {
  if (cand.name !== decl.name) {
    return false;
  }
  if (cand.kind === "variable" || cand.kind === "constant") {
    const constant = cand.kind === "constant";
    if (constant !== decl.constant) {
      return false;
    }
    if (constant) {
      return true;
    }
    return cand.typ !== "" && decl.typ === cand.typ;
  }
  return decl.typ === cand.typ;
}

// isOk reports whether a variable is the ok of a two-value type assertion,
// map index or channel receive.
function isOk(cand: Candidate, assign: ast.AssignStmt | null, rhsType: "TypeAssertExpr" | "IndexExpr" | "Recv"): boolean {
  if (cand.name !== "ok" || assign === null || assign.lhs.length !== 2 || assign.rhs.length !== 1) {
    return false;
  }
  const second = assign.lhs[1];
  if (second?.$type !== "Ident" || second.name !== "ok") {
    return false;
  }
  const rhs = assign.rhs[0];
  if (rhsType === "Recv") {
    return rhs?.$type === "UnaryExpr" && rhs.op === token.ARROW;
  }
  return rhs?.$type === rhsType;
}

function candidates(pass: Pass<Config>): Candidate[] {
  const c = pass.config;
  const imports: ImportDecl[] = [];
  // The assignments of type switches, whose variables have no single type.
  const switchAssigns = new Set<ast.Stmt>();
  // The kind of every field of the functions visited so far. A field belongs
  // to one function, so indexing as they are visited matches upstream's scans.
  const fieldKinds = new Map<ast.Field, FieldKind>();
  const index = (list: ast.FieldList | null, kind: FieldKind) => {
    for (const field of list?.list ?? []) {
      if (!fieldKinds.has(field!)) {
        fieldKinds.set(field!, kind);
      }
    }
  };
  // Keys of the non-map composite literals visited so far, which name fields.
  const literalKeys = new Set<ast.Expr>();
  const idents: ast.Ident[] = [];
  const root = pass.resultOf(inspect).root();
  for (const cursor of root.preorder(ast.ImportSpec, ast.FuncDecl, ast.FuncLit, ast.CompositeLit, ast.TypeSwitchStmt, ast.Ident)) {
    const node = cursor.node()!;
    switch (node.$type) {
      case "ImportSpec": {
        const decl = importDecl(node, pass.pkg.imports());
        if (decl !== null) {
          imports.push(decl);
        }
        break;
      }
      case "FuncDecl":
      case "FuncLit":
        // Upstream checks receivers, then results, type parameters and
        // parameters.
        if (node.$type === "FuncDecl") {
          index(node.recv, "receiver");
        }
        index(node.type!.results, "return value");
        index(node.type!.typeParams, "type parameter");
        index(node.type!.params, "parameter");
        break;
      case "CompositeLit":
        if (node.type?.$type !== "MapType") {
          for (const elt of node.elts) {
            if (elt?.$type === "KeyValueExpr" && elt.key !== null) {
              literalKeys.add(elt.key);
            }
          }
        }
        break;
      case "TypeSwitchStmt":
        if (node.assign !== null) {
          switchAssigns.add(node.assign);
        }
        break;
      case "Ident":
        // Classification sees only the functions and literals visited so far.
        if (node.obj !== null && !literalKeys.has(node) && keep(node, c, fieldKinds)) {
          idents.push(node);
        }
        break;
    }
  }
  imports.push({ name: "", path: pass.pkg.path(), self: true });
  // Longest paths first, so a package's subpackages are shortened before it.
  imports.sort((a, b) => b.path.length - a.path.length);

  const line = (pos: token.Pos) => pass.fset.position(pos).line;
  const typeName = (t: types.Type | null) => shortTypeName(t, imports);
  // Keyed by what upstream keys its maps by: the kind, name, type and
  // declaring node.
  const byDecl = new Map<ast.Node, Map<string, Candidate>>();
  const record = (cand: Omit<Candidate, "dist">, useLine: number) => {
    let byKey = byDecl.get(cand.decl);
    if (byKey === undefined) {
      byKey = new Map();
      byDecl.set(cand.decl, byKey);
    }
    byKey.set(`${cand.kind}\0${cand.name}\0${cand.typ}`, { ...cand, dist: useLine - line(cand.decl.pos()) });
  };
  for (const ident of idents) {
    const decl = ident.obj!.decl as ast.Node;
    switch (decl.$type) {
      case "AssignStmt": {
        const typ = switchAssigns.has(decl) ? "<type-switched>" : typeName(pass.typesInfo.typeOf(ident));
        record({ kind: "variable", name: ident.name, typ, decl }, line(ident.pos()));
        break;
      }
      case "ValueSpec": {
        const kind = ident.obj!.kind === ast.Con ? "constant" : "variable";
        record({ kind, name: ident.name, typ: typeName(pass.typesInfo.typeOf(ident)), decl }, line(ident.pos()));
        break;
      }
      case "Field": {
        const kind = fieldKinds.get(decl)!;
        const typ = typeName(pass.typesInfo.typeOf(kind === "return value" ? ident : decl.type));
        record({ kind: kind === "receiver" ? "parameter" : kind, name: ident.name, typ, decl }, line(ident.pos()));
        break;
      }
    }
  }
  return [...byDecl.values()].flatMap((byKey) => [...byKey.values()]);
}

type FieldKind = "receiver" | "return value" | "type parameter" | "parameter";

// keep reports whether an identifier refers to a declaration this run checks.
function keep(ident: ast.Ident, c: Config, fieldKinds: Map<ast.Field, FieldKind>): boolean {
  const decl = ident.obj!.decl as ast.Node | null;
  switch (decl?.$type) {
    case "AssignStmt":
    case "ValueSpec":
      return true;
    case "Field":
      switch (fieldKinds.get(decl)) {
        case "receiver":
          return c.checkReceiver;
        case "return value":
          return c.checkReturn;
        case "type parameter":
          return c.checkTypeParam;
        case "parameter":
          return true;
        default:
          return false;
      }
    default:
      return false;
  }
}

function importDecl(spec: ast.ImportSpec, imports: readonly (types.Package | null)[]): ImportDecl | null {
  const path = spec.path!.value.replace(/^"/, "").replace(/"$/, "");
  if (spec.name !== null) {
    return { name: spec.name.name, path, self: false };
  }
  const imp = imports.find((p) => p!.path() === path);
  return imp === undefined ? null : { name: imp!.name(), path, self: false };
}

// shortTypeName writes a type with package paths replaced by the names the
// file imports them as, and the current package's dropped.
function shortTypeName(t: types.Type | null, imports: readonly ImportDecl[]): string {
  if (t === null) {
    return "";
  }
  let s = t.string();
  for (const imp of imports) {
    s = s.split(`${imp.path}.`).join(imp.self ? "" : `${imp.name}.`);
  }
  return s;
}
