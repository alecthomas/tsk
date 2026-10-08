import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Check calls to functions excluded by default, such as fmt.Println and (*bytes.Buffer).Write. */
  disableDefaultExclusions: boolean;
  /** Report type assertions whose ok result is not checked, as in `a := b.(T)`. */
  checkTypeAssertions: boolean;
  /** Report errors assigned to the blank identifier, as in `_ = f()`. */
  checkBlank: boolean;
  /**
   * Functions whose errors may go unchecked, as `fmt.Errorf`, `(hash.Hash).Write`
   * for a method, or `fmt.Fprintf(os.Stderr)` for a call with that first argument.
   */
  excludeFunctions: string[];
  /** Name excluded-function candidates fully in messages, as (*bytes.Buffer).Write. */
  verbose: boolean;
}

// defaultExclusions are errcheck's DefaultExcludedSymbols.
const defaultExclusions = [
  "(*bytes.Buffer).Write",
  "(*bytes.Buffer).WriteByte",
  "(*bytes.Buffer).WriteRune",
  "(*bytes.Buffer).WriteString",
  "crypto/rand.Read",
  "fmt.Print",
  "fmt.Printf",
  "fmt.Println",
  "fmt.Fprint(*bytes.Buffer)",
  "fmt.Fprintf(*bytes.Buffer)",
  "fmt.Fprintln(*bytes.Buffer)",
  "fmt.Fprint(*strings.Builder)",
  "fmt.Fprintf(*strings.Builder)",
  "fmt.Fprintln(*strings.Builder)",
  "fmt.Fprint(os.Stderr)",
  "fmt.Fprintf(os.Stderr)",
  "fmt.Fprintln(os.Stderr)",
  "(*io.PipeReader).CloseWithError",
  "(*io.PipeWriter).CloseWithError",
  "math/rand.Read",
  "(*math/rand.Rand).Read",
  "(*strings.Builder).Write",
  "(*strings.Builder).WriteByte",
  "(*strings.Builder).WriteRune",
  "(*strings.Builder).WriteString",
  "(hash.Hash).Write",
  "(*crypto/sha3.SHA3).Write",
  "(*crypto/sha3.SHAKE).Read",
  "(*crypto/sha3.SHAKE).Write",
  "(*hash/maphash.Hash).Write",
  "(*hash/maphash.Hash).WriteByte",
  "(*hash/maphash.Hash).WriteString",
];

export default defineAnalyzer<Config>({
  name: "errcheck",
  doc: `check for unchecked errors

Reports calls whose error result is discarded, in expression, go, and defer
statements, and optionally when assigned to _. Unchecked type assertions can be
reported too.`,
  url: "https://github.com/kisielk/errcheck",
  requires: [inspect],
  config: { disableDefaultExclusions: false, checkTypeAssertions: false, checkBlank: false, excludeFunctions: [], verbose: false },
  run(pass) {
    new Checker(pass).run();
  },
});

class Checker {
  private readonly exclude: Set<string>;
  private readonly errorType = types.Universe!.lookup("error")!.type()!.underlying() as types.Interface;

  constructor(private readonly pass: Pass<Config>) {
    const config = pass.config;
    this.exclude = new Set([...(config.disableDefaultExclusions ? [] : defaultExclusions), ...config.excludeFunctions]);
  }

  run(): void {
    // Upstream walks with ast.Walk and prunes some subtrees, such as those of
    // type assertions. Preorder visits parents first, so pruned nodes nest;
    // files need not be in position order.
    const pruned: ast.Node[] = [];
    const nodes = [ast.ExprStmt, ast.GoStmt, ast.DeferStmt, ast.GenDecl, ast.AssignStmt, ast.TypeAssertExpr];
    for (const cursor of this.pass
      .resultOf(inspect)
      .root()
      .preorder(...nodes)) {
      const node = cursor.node()!;
      while (pruned.length > 0 && !contains(pruned[pruned.length - 1], node)) {
        pruned.pop();
      }
      if (pruned.length > 0) {
        continue;
      }
      if (!this.visit(node)) {
        pruned.push(node);
      }
    }
  }

  // visit checks a node and reports whether to visit its children.
  private visit(node: ast.Node): boolean {
    switch (node.$type) {
      case "ExprStmt":
        if (node.x?.$type === "CallExpr") {
          this.checkCall(node.x);
        }
        return true;
      case "GoStmt":
      case "DeferStmt":
        this.checkCall(node.call!);
        return true;
      case "GenDecl":
        if (node.tok !== token.VAR) {
          return true;
        }
        for (const spec of node.specs) {
          const value = spec as ast.ValueSpec;
          if (value.values.length > 0 && !this.checkAssignment(value.names, value.values)) {
            return false;
          }
        }
        return true;
      case "AssignStmt":
        return this.checkAssignment(node.lhs, node.rhs);
      case "TypeAssertExpr":
        if (this.pass.config.checkTypeAssertions && node.type !== null) {
          this.report(node.pos(), null);
        }
        return false;
    }
    return true;
  }

  private checkCall(call: ast.CallExpr): void {
    if (!this.ignoreCall(call) && this.callReturnsError(call)) {
      this.report(call.lparen, call);
    }
  }

  // checkAssignment checks an assignment and reports whether to visit its children.
  private checkAssignment(lhs: (ast.Expr | null)[], rhs: (ast.Expr | null)[]): boolean {
    const { checkBlank, checkTypeAssertions } = this.pass.config;
    if (rhs.length === 1) {
      const value = rhs[0]!;
      if (value.$type === "CallExpr") {
        if (!checkBlank || this.ignoreCall(value)) {
          return true;
        }
        const errors = this.errorsByResult(value);
        lhs.forEach((target, i) => {
          if (target?.$type === "Ident" && target.name === "_" && (this.isRecover(value) || errors[i])) {
            this.report(target.namePos, value);
          }
        });
      } else if (value.$type === "TypeAssertExpr") {
        if (!checkTypeAssertions || value.type === null) {
          return false;
        }
        const ok = lhs[1];
        if (lhs.length < 2) {
          this.report(value.pos(), null);
        } else if (ok?.$type === "Ident" && checkBlank && ok.name === "_") {
          this.report(ok.namePos, null);
        }
        return false;
      }
      return true;
    }
    lhs.forEach((target, i) => {
      const value = rhs[i];
      if (target?.$type !== "Ident") {
        return;
      }
      if (value?.$type === "CallExpr") {
        if (checkBlank && !this.ignoreCall(value) && target.name === "_" && this.callReturnsError(value)) {
          this.report(target.namePos, value);
        }
      } else if (value?.$type === "TypeAssertExpr" && checkTypeAssertions && value.type !== null) {
        this.report(target.namePos, null);
      }
    });
    return true;
  }

  private report(pos: token.Pos, call: ast.CallExpr | null): void {
    const fullName = call === null ? "" : this.fullName(call);
    let message = "Error return value is not checked";
    if (fullName !== "") {
      const name = this.pass.config.verbose ? fullName : this.selectorName(call!) || fullName;
      message = `Error return value of ${formatCode(name)} is not checked`;
    }
    this.pass.report({ pos, message });
  }

  // selectorAndFunc returns a call's selector, as a.b in a.b(), and the
  // function it selects.
  private selectorAndFunc(call: ast.CallExpr): [ast.SelectorExpr, types.Func] | null {
    const fun = baseCallExpr(call.fun);
    if (fun?.$type !== "SelectorExpr") {
      return null;
    }
    const fn = this.pass.typesInfo.objectOf(fun.sel);
    return fn?.$type === "Func" ? [fun, fn] : null;
  }

  // fullName names a selected function by package and receiver, as
  // (*encoding/base64.Encoding).Decode, or is empty for a plain call.
  private fullName(call: ast.CallExpr): string {
    return this.selectorAndFunc(call)?.[1].fullName() ?? "";
  }

  // selectorName names a selected function as written, as base64.StdEncoding.Decode.
  private selectorName(call: ast.CallExpr): string {
    const found = this.selectorAndFunc(call);
    return found === null ? "" : selectorText(found[0]);
  }

  // namesForExclusion lists the names a call may be excluded by: the
  // function's full name, or each interface a method is reached through.
  private namesForExclusion(call: ast.CallExpr): string[] {
    const found = this.selectorAndFunc(call);
    if (found === null) {
      return [];
    }
    const [sel, fn] = found;
    const name = fn.fullName();
    const selection = this.pass.typesInfo.selections.get(sel);
    if (selection === undefined || selection === null) {
      return [name];
    }
    const interfaces = walkThroughEmbeddedInterfaces(selection);
    return interfaces === null ? [name] : interfaces.map((t) => `(${t.string()}).${fn.name()}`);
  }

  // argName names a call's first argument for exclusions such as
  // fmt.Fprintf(os.Stderr): os.Stdout and os.Stderr by name, others by type.
  private argName(expr: ast.Expr): string {
    if (expr.$type === "SelectorExpr") {
      const object = this.pass.typesInfo.objectOf(expr.sel);
      if (object?.$type === "Var" && object.pkg()?.name() === "os" && (object.name() === "Stderr" || object.name() === "Stdout")) {
        return `os.${object.name()}`;
      }
    }
    return this.pass.typesInfo.typeOf(expr)?.string() ?? "";
  }

  private ignoreCall(call: ast.CallExpr): boolean {
    const arg0 = call.args.length > 0 ? this.argName(call.args[0]!) : "";
    return this.namesForExclusion(call).some((name) => this.exclude.has(name) || (arg0 !== "" && this.exclude.has(`${name}(${arg0})`)));
  }

  // errorsByResult reports, for each of a call's results, whether it is an error.
  private errorsByResult(call: ast.CallExpr): boolean[] {
    const t = this.pass.typesInfo.types.get(call)?.type ?? null;
    switch (t?.$type) {
      case "Named":
      case "Pointer":
        return [this.isError(t)];
      case "Tuple":
        return [...Array(t.len()).keys()].map((i) => {
          const result = t.at(i)!.type();
          return (result?.$type === "Named" || result?.$type === "Pointer") && this.isError(result);
        });
    }
    return [false];
  }

  private callReturnsError(call: ast.CallExpr): boolean {
    return this.isRecover(call) || this.errorsByResult(call).some((isError) => isError);
  }

  private isRecover(call: ast.CallExpr): boolean {
    const fun = call.fun;
    return fun?.$type === "Ident" && this.pass.typesInfo.uses.get(fun)?.$type === "Builtin" && fun.name === "recover";
  }

  private isError(t: types.Type): boolean {
    return types.implements_(t, this.errorType);
  }
}

function contains(outer: ast.Node, inner: ast.Node): boolean {
  return outer.pos() <= inner.pos() && inner.end() <= outer.end();
}

// baseCallExpr strips type arguments and parentheses from a call's function.
function baseCallExpr(fun: ast.Expr | null): ast.Expr | null {
  while (fun?.$type === "IndexExpr" || fun?.$type === "IndexListExpr" || fun?.$type === "ParenExpr") {
    fun = fun.x;
  }
  return fun;
}

function selectorText(sel: ast.SelectorExpr): string {
  if (sel.x?.$type === "Ident") {
    return `${sel.x.name}.${sel.sel!.name}`;
  }
  if (sel.x?.$type === "SelectorExpr") {
    return `${selectorText(sel.x)}.${sel.sel!.name}`;
  }
  return "";
}

// walkThroughEmbeddedInterfaces lists the interfaces a selected method is
// reached through, from the receiver's to the one declaring it, or returns
// null if the method is not declared in an interface.
function walkThroughEmbeddedInterfaces(selection: types.Selection): types.Type[] | null {
  const fn = selection.obj();
  if (fn?.$type !== "Func") {
    return null;
  }
  let current = selection.recv()!;
  const indexes = selection.index();
  for (const index of indexes.slice(0, -1)) {
    let t = types.unalias(current)!;
    if (t.$type === "Pointer") {
      t = t.elem()!;
    }
    t = types.unalias(t)!;
    const struct = (t.$type === "Named" ? t.underlying() : t) as types.Struct;
    current = struct.field(index)!.type()!;
  }
  let iface = current.$type === "Named" ? current.underlying() : current;
  if (iface?.$type !== "Interface") {
    return null;
  }
  const result: types.Type[] = [current];
  while (!explicitlyDefines(iface, fn)) {
    const embedded = embeddedDefining(iface, fn);
    if (embedded === null) {
      break;
    }
    result.push(embedded);
    iface = embedded.underlying() as types.Interface;
  }
  return result;
}

function explicitlyDefines(iface: types.Interface, fn: types.Func): boolean {
  return [...Array(iface.numExplicitMethods()).keys()].some((i) => iface.explicitMethod(i) === fn);
}

function embeddedDefining(iface: types.Interface, fn: types.Func): types.Named | null {
  for (let i = 0; i < iface.numEmbeddeds(); i++) {
    const embedded = iface.embedded(i);
    const underlying = embedded?.underlying() as types.Interface | undefined;
    if (embedded != null && [...Array(underlying!.numMethods()).keys()].some((j) => underlying!.method(j) === fn)) {
      return embedded;
    }
  }
  return null;
}

// formatCode fences code in backquotes, unless it contains one itself.
function formatCode(code: string): string {
  const fence = "`";
  return code.includes(fence) ? code : fence + code + fence;
}
