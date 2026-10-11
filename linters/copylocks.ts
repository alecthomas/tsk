// Port of golang.org/x/tools/go/analysis/passes/copylock at v0.50.0.
import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import * as version from "go/version";
import { defineAnalyzer, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { atLeast } from "./internal/goversion";
import { structuralTerms } from "./internal/typeparams";
import { isTypeNamed } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "copylocks",
  doc: `check for locks erroneously passed by value

Inadvertently copying a value containing a lock, such as sync.Mutex or
sync.WaitGroup, may cause both copies to malfunction. Generally such
values should be referred to through a pointer.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/copylock",
  requires: [inspect],
  runDespiteErrors: true,
  run(pass) {
    const checker = new Checker(pass);
    for (const fileCursor of pass.resultOf(inspect).root().children()) {
      const file = fileCursor.node() as ast.File;
      const fileVersion = pass.typesInfo.fileVersions.get(file) ?? "";
      const goversion = version.isValid(fileVersion) ? fileVersion : "";
      const nodes = fileCursor.preorder(ast.AssignStmt, ast.CallExpr, ast.CompositeLit, ast.FuncDecl, ast.FuncLit, ast.GenDecl, ast.RangeStmt, ast.ReturnStmt);
      for (const cursor of nodes) {
        const node = cursor.node()!;
        switch (node.$type) {
          case "RangeStmt":
            checker.checkRangeVar(node.tok, node.key);
            checker.checkRangeVar(node.tok, node.value);
            break;
          case "FuncDecl":
            checker.checkFunc(node.name!.name, node.recv, node.type!);
            break;
          case "FuncLit":
            checker.checkFunc("func", null, node.type!);
            break;
          case "CallExpr":
            checker.checkCallExpr(node);
            break;
          case "AssignStmt":
            checker.checkAssign(node, goversion, cursor.parent().node());
            break;
          case "GenDecl":
            checker.checkGenDecl(node);
            break;
          case "CompositeLit":
            checker.checkCompositeLit(node);
            break;
          case "ReturnStmt":
            checker.checkReturnStmt(node);
            break;
        }
      }
    }
  },
});

class Checker {
  private readonly lockerType: types.Interface;

  constructor(private readonly pass: Pass<unknown>) {
    const nullary = types.newSignatureType(null, [], [], null, null, false);
    const methods = [types.newFunc(token.NoPos, null, "Lock", nullary), types.newFunc(token.NoPos, null, "Unlock", nullary)];
    this.lockerType = types.newInterfaceType(methods, [])!.complete()!;
  }

  private reportRange(node: ast.Node, message: string): void {
    this.pass.report({ pos: node.pos(), end: node.end(), message });
  }

  private format(node: ast.Node): string {
    return formatNode(node, this.pass.fset);
  }

  checkAssign(assign: ast.AssignStmt, goversion: string, parent: ast.Node | null): void {
    let lhs = assign.lhs;
    assign.rhs.forEach((x, i) => {
      const path = this.lockPathRhs(x!);
      if (path !== null) {
        this.reportRange(x!, `assignment copies lock value to ${this.format(assign.lhs[i]!)}: ${pathString(path)}`);
        // Prefer the assignment warning to reporting the loop variable too.
        lhs = [];
      }
    });

    // From Go 1.22, each iteration copies the loop variables.
    if (assign.tok === token.DEFINE && atLeast(goversion, "go1.22") && parent?.$type === "ForStmt" && parent.init === assign) {
      for (const l of lhs) {
        if (l?.$type !== "Ident" || l.name === "_") {
          continue;
        }
        const obj = this.pass.typesInfo.defs.get(l);
        const t = obj?.type() ?? null;
        if (t !== null) {
          const path = this.lockPath(t, new Set());
          if (path !== null) {
            this.reportRange(l, `for loop iteration copies lock value to ${this.format(l)}: ${pathString(path)}`);
          }
        }
      }
    }
  }

  checkGenDecl(gd: ast.GenDecl): void {
    if (gd.tok !== token.VAR) {
      return;
    }
    for (const spec of gd.specs) {
      const valueSpec = spec as ast.ValueSpec;
      valueSpec.values.forEach((x, i) => {
        const path = this.lockPathRhs(x!);
        if (path !== null) {
          this.reportRange(x!, `variable declaration copies lock value to ${valueSpec.names[i]!.name}: ${pathString(path)}`);
        }
      });
    }
  }

  checkCompositeLit(cl: ast.CompositeLit): void {
    for (let x of cl.elts) {
      if (x?.$type === "KeyValueExpr") {
        x = x.value;
      }
      const path = this.lockPathRhs(x!);
      if (path !== null) {
        this.reportRange(x!, `literal copies lock value from ${this.format(x!)}: ${pathString(path)}`);
      }
    }
  }

  checkReturnStmt(rs: ast.ReturnStmt): void {
    for (const x of rs.results) {
      const path = this.lockPathRhs(x!);
      if (path !== null) {
        this.reportRange(x!, `return copies lock value: ${pathString(path)}`);
      }
    }
  }

  checkCallExpr(ce: ast.CallExpr): void {
    const fun = ce.fun!;
    const id = fun.$type === "Ident" ? fun : fun.$type === "SelectorExpr" ? fun.sel : null;
    const builtin = id === null ? null : this.pass.typesInfo.uses.get(id);
    if (builtin?.$type === "Builtin") {
      switch (builtin.name()) {
        // These use the argument only for its type, or do not copy it.
        case "len":
        case "cap":
        case "Sizeof":
        case "Offsetof":
        case "Alignof":
          return;
      }
    }
    for (const x of ce.args) {
      const path = this.lockPathRhs(x!);
      if (path !== null) {
        this.reportRange(x!, `call of ${this.format(fun)} copies lock value: ${pathString(path)}`);
      }
    }
  }

  // checkFunc reports receivers and parameters that pass locks by value.
  // Results are left to return statements, since returning T{} is fine.
  checkFunc(name: string, recv: ast.FieldList | null, typ: ast.FuncType): void {
    const fields: (ast.Field | null)[] = [];
    if (recv !== null && recv.list.length > 0) {
      fields.push(recv.list[0]!);
    }
    fields.push(...(typ.params?.list ?? []));
    for (const field of fields) {
      const expr = field!.type!;
      const path = this.lockPath(this.pass.typesInfo.types.get(expr)?.type ?? null, new Set());
      if (path !== null) {
        this.reportRange(expr, `${name} passes lock by value: ${pathString(path)}`);
      }
    }
  }

  checkRangeVar(rtok: token.Token, e: ast.Expr | null): void {
    if (e === null || (e.$type === "Ident" && e.name === "_")) {
      return;
    }
    let typ: types.Type | null;
    if (rtok === token.DEFINE) {
      if (e.$type !== "Ident") {
        return;
      }
      const obj = this.pass.typesInfo.defs.get(e);
      if (obj === null || obj === undefined) {
        return;
      }
      typ = obj.type();
    } else {
      typ = this.pass.typesInfo.types.get(e)?.type ?? null;
    }
    const path = this.lockPath(typ, new Set());
    if (path !== null) {
      this.pass.report({ pos: e.pos(), message: `range var ${this.format(e)} copies lock: ${pathString(path)}` });
    }
  }

  private lockPathRhs(x: ast.Expr): string[] | null {
    x = ast.unparen(x)!;
    // A call may return a zero value, or a pointer to one.
    if (x.$type === "CompositeLit" || x.$type === "CallExpr") {
      return null;
    }
    if (x.$type === "StarExpr" && ast.unparen(x.x)?.$type === "CallExpr") {
      return null;
    }
    const tv = this.pass.typesInfo.types.get(x);
    if (tv?.isValue()) {
      return this.lockPath(tv.type, new Set());
    }
    return null;
  }

  // lockPath returns the path, innermost first, to a lock that typ contains,
  // or null if it contains none. seen stops recursion on type cycles.
  private lockPath(typ: types.Type | null, seen: Set<types.Type>): string[] | null {
    if (typ === null || seen.has(typ)) {
      return null;
    }
    seen.add(typ);

    const tpar = types.unalias(typ);
    if (tpar?.$type === "TypeParam") {
      const terms = structuralTerms(tpar);
      if (terms === null) {
        return null;
      }
      for (const term of terms) {
        const subpath = this.lockPath(term.type(), seen);
        if (subpath !== null && subpath.length > 0) {
          if (term.tilde()) {
            // Clarify that a type parameter contains the lock only via an approximation element.
            subpath[subpath.length - 1] = `~${subpath[subpath.length - 1]}`;
          }
          subpath.push(typ.string());
          return subpath;
        }
      }
      return null;
    }

    for (let atyp = typ.underlying(); atyp?.$type === "Array"; atyp = typ.underlying()) {
      typ = atyp.elem()!;
    }

    const u = typ.underlying();
    if (u?.$type === "Tuple") {
      for (const v of u.variables()) {
        const subpath = this.lockPath(v!.type(), seen);
        if (subpath !== null) {
          subpath.push(typ.string());
          return subpath;
        }
      }
      return null;
    }

    // Only structs matter: interfaces and pointers are safe to copy.
    if (u?.$type !== "Struct") {
      return null;
    }

    // A pointer to the type is a sync.Locker but a value is not, which tells
    // embedded values from embedded interfaces.
    if (types.implements_(types.newPointer(typ), this.lockerType) && !types.implements_(typ, this.lockerType)) {
      return [typ.string()];
    }

    // In go1.10, sync.noCopy did not implement Locker.
    if (isTypeNamed(typ, "sync", "noCopy")) {
      return [typ.string()];
    }

    for (const field of u.fields()) {
      const subpath = this.lockPath(field!.type(), seen);
      if (subpath !== null) {
        subpath.push(typ.string());
        return subpath;
      }
    }
    return null;
  }
}

// pathString prints a lock path outermost first.
function pathString(path: string[]): string {
  return [...path].reverse().join(" contains ");
}
