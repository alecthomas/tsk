import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

type Check = "identical" | "unused" | "unexported" | "unusedmethod";

interface Config {
  /**
   * Checks to run: "identical" interfaces, "unused" interfaces, "unexported"
   * interfaces in exported signatures, and "unusedmethod" interface methods.
   */
  enable: Check[];
  settings: {
    unused: {
      /** Package paths to skip. */
      exclude: string[];
    };
    unusedmethod: {
      /** Package paths to skip. */
      exclude: string[];
    };
  };
}

export default defineAnalyzer<Config>({
  name: "iface",
  doc: `detect the incorrect use of interfaces, helping avoid interface pollution

Reports interfaces identical to another in the same package, and optionally
interfaces or interface methods unused in their package, and unexported
interfaces in exported signatures. //iface:ignore, or //iface:ignore=<checks>,
on a declaration skips it. The opaque check is not supported.`,
  // Messages start with the check's name, as golangci-lint's do.
  requires: [inspect],
  config: { enable: ["identical"], settings: { unused: { exclude: [] }, unusedmethod: { exclude: [] } } },
  run(pass) {
    const enabled = new Set(pass.config.enable);
    if (enabled.has("identical")) {
      identical(pass);
    }
    if (enabled.has("unused") && !pass.config.settings.unused.exclude.includes(pass.pkg.path())) {
      unused(pass);
    }
    if (enabled.has("unexported")) {
      unexported(pass);
    }
    if (enabled.has("unusedmethod") && !pass.config.settings.unusedmethod.exclude.includes(pass.pkg.path())) {
      unusedMethods(pass);
    }
  },
});

// shouldIgnore reports whether a doc holds //iface:ignore, for every check
// or one naming this one.
function shouldIgnore(doc: ast.CommentGroup | null, check: Check): boolean {
  for (const comment of doc?.list ?? []) {
    const text = comment!.text.trim();
    if (text === "//iface:ignore") {
      return true;
    }
    if (text.startsWith("//iface:ignore=")) {
      const names = text.slice("//iface:ignore=".length).trim();
      return names === "" || names.split(",").some((name) => name.trim() === check);
    }
  }
  return false;
}

// interfaceSpecs lists type declarations of interfaces not ignored for a check.
function interfaceSpecs(pass: Pass<Config>, check: Check): { decl: ast.GenDecl; spec: ast.TypeSpec; iface: ast.InterfaceType }[] {
  const result: { decl: ast.GenDecl; spec: ast.TypeSpec; iface: ast.InterfaceType }[] = [];
  for (const cursor of pass.resultOf(inspect).root().preorder(ast.GenDecl)) {
    const decl = cursor.node() as ast.GenDecl;
    if (decl.tok !== token.TYPE || shouldIgnore(decl.doc, check)) {
      continue;
    }
    for (const spec of decl.specs) {
      const typeSpec = spec as ast.TypeSpec;
      if (typeSpec.type?.$type === "InterfaceType" && !shouldIgnore(typeSpec.doc, check)) {
        result.push({ decl, spec: typeSpec, iface: typeSpec.type });
      }
    }
  }
  return result;
}

function identical(pass: Pass<Config>): void {
  const declared = new Map<string, { pos: token.Pos; iface: types.Interface | null }>();
  for (const { spec } of interfaceSpecs(pass, "identical")) {
    const underlying = pass.typesInfo.defs.get(spec.name!)?.type()?.underlying() ?? null;
    declared.set(spec.name!.name, { pos: spec.pos(), iface: underlying?.$type === "Interface" ? underlying : null });
  }
  for (const [name, { pos, iface }] of declared) {
    if (iface === null) {
      continue;
    }
    const others = [...declared].filter(([other, o]) => other !== name && o.iface !== null && types.identical(iface, o.iface)).map(([other]) => other);
    if (others.length > 0) {
      pass.report({
        pos,
        message: `identical: interface '${name}' contains identical methods or type constraints with another interface, causing redundancy (see: ${others.sort().join(", ")})`,
      });
    }
  }
}

function unused(pass: Pass<Config>): void {
  const declared = new Map<types.TypeName, { decl: ast.GenDecl; spec: ast.TypeSpec }>();
  for (const { decl, spec } of interfaceSpecs(pass, "unused")) {
    const object = pass.typesInfo.defs.get(spec.name!);
    if (object?.$type === "TypeName") {
      declared.set(object, { decl, spec });
    }
  }
  for (const cursor of pass.resultOf(inspect).root().preorder(ast.Ident)) {
    const object = pass.typesInfo.uses.get(cursor.node() as ast.Ident);
    if (object?.$type === "TypeName") {
      declared.delete(object);
    }
  }
  for (const [typeName, { decl, spec }] of declared) {
    // A lone spec takes its declaration with it.
    const [node, doc] = decl.specs.length === 1 ? [decl as ast.Node, decl.doc] : [spec as ast.Node, spec.doc];
    pass.report({
      pos: spec.pos(),
      message: `unused: interface '${typeName.name()}' is declared but not used within the package`,
      suggestedFixes: [{ message: "Remove the unused interface declaration", textEdits: [{ pos: doc?.pos() ?? node.pos(), end: node.end(), newText: "" }] }],
    });
  }
}

function unusedMethods(pass: Pass<Config>): void {
  const declared = new Map<types.Func, { iface: string; field: ast.Field }>();
  for (const { spec, iface } of interfaceSpecs(pass, "unusedmethod")) {
    for (const field of iface.methods!.list) {
      if (field!.type?.$type !== "FuncType" || shouldIgnore(field!.doc, "unusedmethod") || shouldIgnore(field!.comment, "unusedmethod")) {
        continue;
      }
      const object = pass.typesInfo.defs.get(field!.names[0]!);
      if (object?.$type === "Func") {
        declared.set(object, { iface: spec.name!.name, field: field! });
      }
    }
  }
  for (const cursor of pass.resultOf(inspect).root().preorder(ast.SelectorExpr)) {
    const object = pass.typesInfo.selections.get(cursor.node() as ast.SelectorExpr)?.obj();
    if (object?.$type === "Func") {
      declared.delete(object);
    }
  }
  for (const [fn, { iface, field }] of declared) {
    pass.report({
      pos: field.pos(),
      message: `unusedmethod: method '${fn.name()}()' is declared on interface '${iface}' but not used within the package`,
      suggestedFixes: [
        { message: "Remove the unused method", textEdits: [{ pos: field.doc?.pos() ?? field.pos(), end: field.comment?.end() ?? field.end(), newText: "" }] },
      ],
    });
  }
}

function unexported(pass: Pass<Config>): void {
  const qualifier = (pkg: types.Package | null) => (pkg === pass.pkg ? "" : (pkg?.name() ?? ""));
  const format = (expr: ast.Expr, t: types.Type | null) =>
    expr.$type === "Ellipsis" ? `...${types.typeString(pass.typesInfo.typeOf(expr.elt), qualifier)}` : types.typeString(t, qualifier);
  const errorType = types.Universe!.lookup("error")!.type();
  const anyType = types.Universe!.lookup("any")!.type();
  for (const cursor of pass.resultOf(inspect).root().preorder(ast.FuncDecl)) {
    const fn = cursor.node() as ast.FuncDecl;
    if (shouldIgnore(fn.doc, "unexported") || !ast.isExported(fn.name!.name)) {
      continue;
    }
    let receiver = "";
    if (fn.recv !== null) {
      let recvType = fn.recv.list[0]!.type!;
      if (recvType.$type === "StarExpr") {
        recvType = recvType.x!;
      }
      const t = pass.typesInfo.typeOf(recvType);
      receiver = t === null ? "" : format(recvType, t);
    }
    const [kind, name] = receiver === "" ? ["function", fn.name!.name] : ["method", `${receiver}.${fn.name!.name}`];
    const check = (expr: ast.Expr | null, role: string) => {
      const ident = findIdent(expr);
      if (ident?.$type !== "Ident" || ast.isExported(ident.name)) {
        return;
      }
      const identType = pass.typesInfo.typeOf(ident);
      if (identType === null || types.identical(identType, errorType) || types.identical(identType, anyType) || !types.isInterface(identType)) {
        return;
      }
      pass.report({
        pos: ident.pos(),
        message: `unexported: unexported interface '${format(expr!, pass.typesInfo.typeOf(expr))}' used as ${role} in exported ${kind} '${name}'`,
      });
    };
    for (const param of fn.type!.params!.list) {
      check(param!.type, "parameter");
    }
    for (const result of fn.type!.results?.list ?? []) {
      check(result!.type, "return value");
    }
  }
}

// findIdent returns the named type an expression is built from, through
// pointers, slices, maps, channels, and type arguments.
function findIdent(expr: ast.Expr | null): ast.Expr | null {
  for (;;) {
    switch (expr?.$type) {
      case "StarExpr":
      case "IndexExpr":
      case "IndexListExpr":
        expr = expr.x;
        break;
      case "Ellipsis":
      case "ArrayType":
        expr = expr.elt;
        break;
      case "ChanType":
      case "MapType":
        expr = expr.value;
        break;
      case "Ident":
      case "SelectorExpr":
        return expr;
      default:
        return null;
    }
  }
}
