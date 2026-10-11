// Port of golang.org/x/tools/go/analysis/passes/printf at v0.50.0, with
// internal/fmtstr and the parts of refactor/satisfy it uses.
import * as ast from "go/ast";
import * as constant from "go/constant";
import * as token from "go/token";
import * as types from "go/types";
import * as version from "go/version";
import * as edge from "golang.org/x/tools/go/ast/edge";
import type * as inspector from "golang.org/x/tools/go/ast/inspector";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, defineFact, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { atLeast, fileUsesGoVersion } from "./internal/goversion";
import { unquote } from "./internal/strconv";
import { deref, normalTerms, structuralTerms } from "./internal/typeparams";
import { isTypeNamed } from "./internal/typesinternal";
import { byteLength } from "./internal/utf8";

interface Config {
  /**
   * Names of additional print functions to check: `dir/pkg.Function`, `(*dir/pkg.Type).Method`, or a
   * case-insensitive unqualified name such as `errorf`. A name ending in f is Printf-like.
   */
  funcs: string[];
}

enum Kind {
  None = 0,
  Print = 1,
  Printf = 2,
  Errorf = 3,
}

const kindNames: Record<Kind, string> = { [Kind.None]: "(none)", [Kind.Print]: "print", [Kind.Printf]: "printf", [Kind.Errorf]: "errorf" };

type WrapperName = "printWrapper" | "printfWrapper" | "errorfWrapper";

const wrapperNames: Record<WrapperName, Kind> = { printWrapper: Kind.Print, printfWrapper: Kind.Printf, errorfWrapper: Kind.Errorf };

// isWrapper marks a function as a print, printf or errorf wrapper.
const isWrapper = defineFact<WrapperName>("isWrapper");

// The well-known print functions. Most could be deduced from the standard
// library, but upstream lists them for drivers that do not analyze it.
const defaultIsPrint = [
  "fmt.Appendf",
  "fmt.Append",
  "fmt.Appendln",
  "fmt.Errorf",
  "fmt.Fprint",
  "fmt.Fprintf",
  "fmt.Fprintln",
  "fmt.Print",
  "fmt.Printf",
  "fmt.Println",
  "fmt.Sprint",
  "fmt.Sprintf",
  "fmt.Sprintln",
  "runtime/trace.Logf",
  "log.Print",
  "log.Printf",
  "log.Println",
  "log.Fatal",
  "log.Fatalf",
  "log.Fatalln",
  "log.Panic",
  "log.Panicf",
  "log.Panicln",
  "(*log.Logger).Fatal",
  "(*log.Logger).Fatalf",
  "(*log.Logger).Fatalln",
  "(*log.Logger).Panic",
  "(*log.Logger).Panicf",
  "(*log.Logger).Panicln",
  "(*log.Logger).Print",
  "(*log.Logger).Printf",
  "(*log.Logger).Println",
  "(*testing.common).Error",
  "(*testing.common).Errorf",
  "(*testing.common).Fatal",
  "(*testing.common).Fatalf",
  "(*testing.common).Log",
  "(*testing.common).Logf",
  "(*testing.common).Skip",
  "(*testing.common).Skipf",
  "(testing.TB).Error",
  "(testing.TB).Errorf",
  "(testing.TB).Fatal",
  "(testing.TB).Fatalf",
  "(testing.TB).Log",
  "(testing.TB).Logf",
  "(testing.TB).Skip",
  "(testing.TB).Skipf",
];

export default defineAnalyzer<Config>({
  name: "printf",
  doc: `check consistency of Printf format strings and arguments

The check applies to calls of the formatting functions such as fmt.Printf and
fmt.Sprintf, as well as any detected wrappers of those functions such as
log.Printf. It reports a variety of mistakes such as syntax errors in the
format string and mismatches (of number and type) between the verbs and their
arguments.

It also reports calls to Print-like functions that appear to have been
intended for their Printf-like counterpart, calls to Printf-like functions
with a non-constant format string and no other arguments (in files using at
least Go 1.24), and %w operands of pointer-to-error type (in files using at
least Go 1.27).

Functions that delegate their arguments to fmt.Printf are inferred to be
printf wrappers, and calls to them are checked too. So are interface methods,
declared in files using at least Go 1.26, when the interface's package assigns
to it an implementation whose method is a wrapper.

The funcs option names additional print functions.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/printf",
  group: "govet",
  requires: [inspect],
  facts: [isWrapper],
  scope: "all",
  config: { funcs: [] },
  run(pass) {
    // Dependencies use only the default list, so their facts do not depend
    // on config; findings there are discarded, so calls go unchecked.
    const checker = new Checker(pass, isPrintSet(pass.dependency ? [] : pass.config.funcs));
    checker.findPrintLike();
    if (!pass.dependency) {
      checker.checkCalls();
    }
  },
});

// isPrintSet returns the print function names: full names as
// types.Func.fullName gives them, or lower-cased unqualified names.
function isPrintSet(funcs: readonly string[]): Set<string> {
  const set = new Set(defaultIsPrint);
  for (const name of funcs) {
    if (name === "") {
      throw new Error("printf: funcs: empty string");
    }
    set.add(name.includes(".") ? name : name.toLowerCase());
  }
  return set;
}

// A wrapper is a candidate print or printf wrapper: a func, or a var
// holding a function literal. Interface methods have no body.
interface Wrapper {
  obj: types.Object;
  body: inspector.Cursor | null;
  format: types.Var | null;
  args: types.Var;
  callers: { w: Wrapper; call: ast.CallExpr | null }[];
}

interface Range {
  pos: token.Pos;
  end: token.Pos;
}

const rangeOf = (node: ast.Node): Range => ({ pos: node.pos(), end: node.end() });

class Checker {
  private readonly info: types.Info;
  // Known kinds by object, as upstream's Result.funcs.
  private readonly funcs = new Map<types.Object, Kind>();
  readonly errorType: types.Interface;

  constructor(
    private readonly pass: Pass<Config>,
    private readonly isPrint: Set<string>,
  ) {
    this.info = pass.typesInfo;
    this.errorType = types.Universe!.lookup("error")!.type()!.underlying() as types.Interface;
  }

  private report(rng: Range, message: string): void {
    this.pass.report({ pos: rng.pos, end: rng.end, message });
  }

  // findPrintLike finds the package's print and printf wrappers, exporting
  // a fact for each.
  findPrintLike(): void {
    const info = this.info;
    const wrappers: Wrapper[] = [];
    const byObj = new Map<types.Object, Wrapper>();
    const addWrapper = (obj: types.Object, sig: types.Signature, body: inspector.Cursor | null): void => {
      const params = formatArgsParams(sig);
      if (params !== null) {
        const w: Wrapper = { obj, body, format: params[0], args: params[1], callers: [] };
        byObj.set(obj, w);
        wrappers.push(w);
      }
    };
    for (const cur of variadicDecls(this.pass.resultOf(inspect).root())) {
      const n = cur.node()!;
      switch (n.$type) {
        case "FuncDecl":
          if (n.body !== null) {
            const fn = info.defs.get(n.name!) as types.Func;
            addWrapper(fn, fn.signature()!, cur.childAt(edge.FuncDecl_Body, -1));
          }
          break;
        case "FuncLit": {
          // A function literal assigned to a variable, field or imported var.
          let lhs: ast.Node | null = null;
          const [ek, idx] = cur.parentEdge();
          if (ek === edge.ValueSpec_Values) {
            lhs = cur.parent().childAt(edge.ValueSpec_Names, idx).node();
          } else if (ek === edge.AssignStmt_Rhs) {
            lhs = cur.parent().childAt(edge.AssignStmt_Lhs, idx).node();
          }
          let v: types.Object | null | undefined = null;
          if (lhs?.$type === "Ident") {
            v = info.objectOf(lhs);
          } else if (lhs?.$type === "SelectorExpr") {
            const sel = info.selections.get(lhs);
            v = sel ? sel.obj() : info.uses.get(lhs.sel!);
          }
          if (v?.$type === "Var") {
            addWrapper(v, info.typeOf(n) as types.Signature, cur.childAt(edge.FuncLit_Body, -1));
          }
          break;
        }
        case "InterfaceType": {
          // Induction through interface methods is gated as if it were a
          // go1.26 language feature.
          const file = cur.enclosing(ast.File).next().value?.node();
          if (file?.$type === "File" && fileUsesGoVersion(this.pass, file, "go1.26")) {
            for (const imeth of (info.typeOf(n) as types.Interface).methods()) {
              addWrapper(imeth!, imeth!.signature()!, null);
            }
          }
          break;
        }
      }
    }

    // Interface methods act as if they call each implementing method.
    let impls: Map<types.Func, Set<types.Func>> | null = null;
    const doCall = (w: Wrapper, callee: types.Object, call: ast.CallExpr | null): void => {
      byObj.get(callee)?.callers.push({ w, call });
      const kind = this.callKind(callee);
      if (kind !== Kind.None) {
        this.propagate(w, call, kind);
      }
    };
    for (const w of wrappers) {
      if (w.body === null) {
        impls ??= this.methodImplementations();
        for (const impl of impls.get(w.obj as types.Func) ?? []) {
          doCall(w, impl, null);
        }
        continue;
      }
      // Wrappers that may mutate format or args before forwarding are
      // rejected (go.dev/issue/26555).
      for (const cur of w.body.preorder(ast.AssignStmt, ast.UnaryExpr, ast.CallExpr)) {
        const n = cur.node()!;
        if (n.$type === "AssignStmt") {
          if (n.lhs.some((lhs) => (w.format !== null && match(info, lhs, w.format)) || match(info, lhs, w.args))) {
            break;
          }
        } else if (n.$type === "UnaryExpr") {
          if (n.op === token.AND && ((w.format !== null && match(info, n.x, w.format)) || match(info, n.x, w.args))) {
            break;
          }
        } else if (n.$type === "CallExpr" && n.args.length > 0 && match(info, n.args[n.args.length - 1], w.args)) {
          const callee = typeutil.callee(info, n);
          if (callee !== null) {
            doCall(w, callee, n);
          }
        }
      }
    }
  }

  // methodImplementations maps this package's printf-like interface methods
  // to the methods implementing them in the package's interface assignments.
  private methodImplementations(): Map<types.Func, Set<types.Func>> {
    const impls = new Map<types.Func, Set<types.Func>>();
    const finder = new SatisfyFinder(this.info);
    finder.find(this.pass.files);
    for (const [lhs, rhss] of finder.result) {
      for (const imeth of (lhs.underlying() as types.Interface).methods()) {
        if (imeth!.pkg() !== this.pass.pkg || formatArgsParams(imeth!.signature()!) === null) {
          continue;
        }
        for (const rhs of rhss) {
          const [impl] = types.lookupFieldOrMethod(rhs, false, this.pass.pkg, imeth!.name());
          if (impl?.$type === "Func") {
            let set = impls.get(imeth!);
            if (set === undefined) {
              set = new Set();
              impls.set(imeth!, set);
            }
            set.add(impl);
          }
        }
      }
    }
    return impls;
  }

  // propagate records w's kind, and that of the callers forwarding to it.
  private propagate(w: Wrapper, call: ast.CallExpr | null, kind: Kind): void {
    if (call !== null && !this.checkForward(w, call, kind)) {
      return;
    }
    if (this.funcs.get(w.obj) !== kind) {
      this.funcs.set(w.obj, kind);
      if (w.obj.pkg() === this.pass.pkg) {
        this.pass.exportObjectFact(origin(w.obj), isWrapper, `${kindNames[kind]}Wrapper` as WrapperName);
      }
      for (const caller of w.callers) {
        this.propagate(caller.w, caller.call, kind);
      }
    }
  }

  // checkForward reports whether call forwards w's format and args properly.
  private checkForward(w: Wrapper, call: ast.CallExpr, kind: Kind): boolean {
    if ((kind === Kind.Printf || kind === Kind.Errorf) && (call.args.length < 2 || !match(this.info, call.args[call.args.length - 2], w.format))) {
      return false;
    }
    if (call.ellipsis === token.NoPos) {
      const typ = this.info.types.get(call.fun!)?.type;
      // Adding an ellipsis would not compile with more arguments than parameters.
      if (typ?.$type !== "Signature" || call.args.length > (typ.params()?.len() ?? 0)) {
        return false;
      }
      this.report(rangeOf(call), `missing ... in args forwarded to ${kindNames[kind]}-like function`);
      return false;
    }
    return true;
  }

  // callKind returns the kind of a function, or of a var holding one.
  private callKind(obj: types.Object): Kind {
    let kind = this.funcs.get(obj);
    if (kind === undefined) {
      const name = fullname(obj);
      if (this.isPrint.has(name) || this.isPrint.has(obj.name().toLowerCase())) {
        kind = name === "fmt.Errorf" ? Kind.Errorf : obj.name().endsWith("f") ? Kind.Printf : Kind.Print;
      } else {
        // Facts are associated with generic declarations, not instantiations.
        obj = origin(obj);
        const fact = this.pass.importObjectFact(obj, isWrapper);
        kind = fact === undefined ? Kind.None : wrapperNames[fact];
      }
      this.funcs.set(obj, kind);
    }
    return kind;
  }

  checkCalls(): void {
    // The file's language version, or "" if unknown.
    let fileVersion = "";
    for (const cur of this.pass.resultOf(inspect).root().preorder(ast.File, ast.CallExpr)) {
      const n = cur.node()!;
      if (n.$type === "File") {
        fileVersion = version.lang(this.info.fileVersions.get(n) ?? "");
      } else if (n.$type === "CallExpr") {
        const callee = typeutil.callee(this.info, n);
        if (callee === null) {
          continue;
        }
        const kind = this.callKind(callee);
        if (kind === Kind.Printf || kind === Kind.Errorf) {
          this.checkPrintf(fileVersion, kind, n, fullname(callee));
        } else if (kind === Kind.Print) {
          this.checkPrint(n, fullname(callee));
        }
      }
    }
  }

  // formatStringIndex returns the index of the format string, the last
  // non-variadic parameter, or -1 if unknown.
  private formatStringIndex(call: ast.CallExpr): number {
    const sig = this.info.types.get(call.fun!)?.type;
    if (sig?.$type !== "Signature" || !sig.variadic()) {
      return -1;
    }
    const idx = (sig.params()?.len() ?? 0) - 2;
    return idx < 0 ? -1 : idx;
  }

  private stringConstantExpr(expr: ast.Expr | null): string | null {
    const value = this.info.types.get(expr!)?.value;
    return value && value.kind() === constant.String ? constant.stringVal(value) : null;
  }

  private checkPrintf(fileVersion: string, kind: Kind, call: ast.CallExpr, name: string): void {
    const idx = this.formatStringIndex(call);
    if (idx < 0 || idx >= call.args.length) {
      return;
    }
    const formatArg = call.args[idx]!;
    const format = this.stringConstantExpr(formatArg);
    if (format === null) {
      // A non-constant format with no arguments misformats any "%" in it.
      // Gated on Go 1.24 to avoid breaking existing code (go.dev/issue/71485).
      if (idx === call.args.length - 1 && fileVersion !== "" && atLeast(fileVersion, "go1.24")) {
        this.pass.report({
          pos: formatArg.pos(),
          end: formatArg.end(),
          message: `non-constant format string in call to ${name}`,
          suggestedFixes: [{ message: 'Insert "%s" format string', textEdits: [{ pos: formatArg.pos(), end: formatArg.pos(), newText: '"%s", ' }] }],
        });
      }
      return;
    }
    const firstArg = idx + 1;
    if (!format.includes("%")) {
      if (call.args.length > firstArg) {
        this.report(rangeOf(call.args[firstArg]!), `${name} call has arguments but no formatting directives`);
      }
      return;
    }
    const operations = parseFormat(format, idx);
    if (typeof operations === "string") {
      this.report(rangeOf(formatArg), `${name} ${operations}`);
      return;
    }
    const maxArgIndex = { value: firstArg - 1 };
    let anyIndex = false;
    for (const op of operations) {
      if (op.prec.index !== -1 || op.width.index !== -1 || op.verb.index !== -1) {
        anyIndex = true;
      }
      const rng = opRange(formatArg, format, op);
      if (op.verb.verb === 0x77 /* w */ && kind !== Kind.Errorf) {
        this.report(rng, `${name} does not support error-wrapping directive %w`);
        return;
      }
      if (!this.okPrintfArg(fileVersion, call, rng, maxArgIndex, firstArg, name, op)) {
        return;
      }
    }
    if (call.ellipsis !== token.NoPos && maxArgIndex.value >= call.args.length - 2) {
      return;
    }
    // Extra arguments are ignored if any format is indexed.
    if (anyIndex) {
      return;
    }
    if (maxArgIndex.value + 1 < call.args.length) {
      const expect = maxArgIndex.value + 1 - firstArg;
      const numArgs = call.args.length - firstArg;
      this.report(rangeOf(call), `${name} call needs ${count(expect, "arg")} but has ${count(numArgs, "arg")}`);
    }
  }

  // okPrintfArg checks an operation against the call's arguments, reporting
  // any problem, and raises maxArgIndex to the highest argument it uses.
  private okPrintfArg(
    fileVersion: string,
    call: ast.CallExpr,
    rng: Range,
    maxArgIndex: { value: number },
    firstArg: number,
    name: string,
    op: Operation,
  ): boolean {
    const verb = op.verb.verb;
    const known = printVerbs.find((p) => p.verb === verb);
    // Upstream's loop leaves the last verb in v when none matches.
    const v = { ...(known ?? printVerbs[printVerbs.length - 1]) };
    const verbText = String.fromCodePoint(verb);
    // In go1.26 code, rune and byte are the only %q integers (go.dev/issue/72850).
    if (verbText === "q" && fileVersion !== "" && atLeast(fileVersion, "go1.26")) {
      v.typ = argRune | argByte | argString;
    }
    // In go1.27 code, %d does not accept pointers (go.dev/issue/62595).
    if (verbText === "d" && fileVersion !== "" && atLeast(fileVersion, "go1.27")) {
      v.typ = argInt;
    }

    // Could the verb's argument implement fmt.Formatter? Not for %w, which
    // requires an error.
    let formatter = false;
    if (v.typ !== argError && op.verb.argIndex < call.args.length) {
      const tv = this.info.types.get(call.args[op.verb.argIndex]!);
      if (tv !== undefined) {
        formatter = this.isFormatter(tv.type);
      }
    }
    if (!formatter) {
      if (known === undefined) {
        this.report(rng, `${name} format ${op.text} has unknown verb ${verbText}`);
        return false;
      }
      for (const flag of op.flags) {
        // '0' is allowed everywhere (go.dev/issue/23598).
        if (flag !== "0" && !v.flags.includes(flag)) {
          this.report(rng, `${name} format ${op.text} has unrecognized flag ${flag}`);
          return false;
        }
      }
    }

    const argIndexes: number[] = [];
    if (op.width.dynamic !== -1) {
      argIndexes.push(op.width.dynamic);
    }
    if (op.prec.dynamic !== -1) {
      argIndexes.push(op.prec.dynamic);
    }
    // Each * argument must be an integer.
    for (const argIndex of argIndexes) {
      if (!this.argCanBeChecked(call, rng, argIndex, firstArg, op, name)) {
        return false;
      }
      const arg = call.args[argIndex]!;
      const [reason, ok] = this.matchArgType(argInt, arg);
      if (!ok) {
        const details = reason !== "" ? ` (${reason})` : "";
        this.report(rng, `${name} format ${op.text} uses non-int ${this.format(arg)}${details} as argument of *`);
        return false;
      }
    }
    if (op.verb.argIndex !== -1 && verbText !== "%") {
      argIndexes.push(op.verb.argIndex);
    }
    for (const index of argIndexes) {
      maxArgIndex.value = Math.max(maxArgIndex.value, index);
    }
    // fmt prints "%10.2%" as "%", consuming no argument.
    if (verbText === "%" || formatter) {
      return true;
    }

    const verbArgIndex = op.verb.argIndex;
    if (!this.argCanBeChecked(call, rng, verbArgIndex, firstArg, op, name)) {
      return false;
    }
    const arg = call.args[verbArgIndex]!;
    if (verbText === "w") {
      // A %w operand of type *E, where E is an error, defeats errors.Is
      // (go.dev/issue/61342).
      const typ = this.info.types.get(arg)?.type ?? null;
      const ptr = typ?.underlying();
      if (ptr?.$type === "Pointer" && types.implements_(ptr.elem(), this.errorType) && atLeast(fileVersion, "go1.27")) {
        const qual = (p: types.Package | null): string => (p === this.pass.pkg ? "" : p!.name());
        const want = types.typeString(ptr.elem(), qual);
        this.report(rng, `%w wants operand of error type ${want}, not pointer type ${types.typeString(typ, qual)} (defeats errors.Is)`);
        return false;
      }
    }
    if (this.isFunctionValue(arg) && verbText !== "p" && verbText !== "T") {
      this.report(rng, `${name} format ${op.text} arg ${this.format(arg)} is a func value, not called`);
      return false;
    }
    const [reason, ok] = this.matchArgType(v.typ, arg);
    if (!ok) {
      const typeString = this.info.types.get(arg)?.type?.string() ?? "";
      const details = reason !== "" ? ` (${reason})` : "";
      this.report(rng, `${name} format ${op.text} has arg ${this.format(arg)} of wrong type ${typeString}${details}`);
      return false;
    }
    // Detect recursive formatting via the value's String or Error method.
    // The '#' flag suppresses the methods, except with %x, %X and %q.
    if ((v.typ & argString) !== 0 && verbText !== "T" && (!op.flags.includes("#") || "qxX".includes(verbText))) {
      const methodName = this.recursiveStringer(arg);
      if (methodName !== null) {
        this.report(rng, `${name} format ${op.text} with arg ${this.format(arg)} causes recursive ${methodName} method call`);
        return false;
      }
    }
    return true;
  }

  // argCanBeChecked reports whether the argument is statically present,
  // reporting it if it is past the end of the call's arguments.
  private argCanBeChecked(call: ast.CallExpr, rng: Range, argIndex: number, firstArg: number, op: Operation, name: string): boolean {
    if (argIndex <= 0) {
      throw new Error("negative argIndex");
    }
    if (argIndex < call.args.length - 1) {
      return true;
    }
    // A final slice... argument could hold any number of arguments.
    if (call.ellipsis !== token.NoPos) {
      return false;
    }
    if (argIndex < call.args.length) {
      return true;
    }
    // People think of arguments as 1-indexed.
    const arg = argIndex - firstArg + 1;
    this.report(rng, `${name} format ${op.text} reads arg #${arg}, but call has ${count(call.args.length - firstArg, "arg")}`);
    return false;
  }

  private checkPrint(call: ast.CallExpr, name: string): void {
    let firstArg = 0;
    const typ = this.info.types.get(call.fun!)?.type;
    if (typ === undefined || typ === null) {
      return;
    }
    const sig = typ.underlying();
    if (sig?.$type === "Signature") {
      if (!sig.variadic()) {
        return;
      }
      const params = sig.params()!;
      firstArg = params.len() - 1;
      const slice = params.at(firstArg)!.type();
      const elem = types.unalias(slice?.$type === "Slice" ? slice.elem() : null);
      // Skip variadic functions accepting non-interface{} args.
      if (elem?.$type !== "Interface" || !elem.empty()) {
        return;
      }
    }
    if (call.args.length <= firstArg) {
      return;
    }
    const args = call.args.slice(firstArg);
    if (firstArg === 0) {
      const sel = call.args[0];
      if (sel?.$type === "SelectorExpr" && sel.x?.$type === "Ident" && sel.x.name === "os" && sel.sel!.name.startsWith("Std")) {
        this.report(rangeOf(call), `${name} does not take io.Writer but has first arg ${this.format(sel)}`);
      }
    }
    let s = this.stringConstantExpr(args[0]);
    if (s !== null) {
      // A trailing % such as in "abc 0.0%" cannot be a directive.
      if (s.endsWith("%")) {
        s = s.slice(0, -1);
      }
      if (s.includes("%")) {
        for (const [m] of s.matchAll(printFormatRE)) {
          // Allow %XX where XX are hex digits, as is common in URLs.
          if (m.length >= 3 && isHex(m[1]) && isHex(m[2])) {
            continue;
          }
          this.report(rangeOf(call), `${name} call has possible Printf formatting directive ${m}`);
          break;
        }
      }
    }
    for (const arg of args) {
      if (this.isFunctionValue(arg!)) {
        this.report(rangeOf(call), `${name} arg ${this.format(arg!)} is a func value, not called`);
      }
      const methodName = this.recursiveStringer(arg!);
      if (methodName !== null) {
        this.report(rangeOf(call), `${name} arg ${this.format(arg!)} causes recursive call to ${methodName} method`);
      }
    }
  }

  private format(node: ast.Node): string {
    return formatNode(node, this.pass.fset);
  }

  // isFunctionValue reports whether e is a function rather than a call. A
  // named func type, which may have a String method, is not.
  private isFunctionValue(e: ast.Expr): boolean {
    return this.info.types.get(e)?.type?.$type === "Signature";
  }

  // recursiveStringer returns the String or Error method if e is its
  // receiver r, or &r, inside the method, and null otherwise.
  private recursiveStringer(e: ast.Expr | null): string | null {
    const typ = this.info.types.get(e!)?.type ?? null;
    if (typ === null || this.isFormatter(typ)) {
      return null;
    }
    const [strObj] = types.lookupFieldOrMethod(typ, false, this.pass.pkg, "String");
    const [errObj] = types.lookupFieldOrMethod(typ, false, this.pass.pkg, "Error");
    const inScope = (f: types.Func): boolean => f.scope()?.contains(e!.pos()) ?? false;
    let method: types.Func;
    if (strObj?.$type === "Func" && strObj.pkg() === this.pass.pkg && inScope(strObj)) {
      method = strObj;
    } else if (errObj?.$type === "Func" && errObj.pkg() === this.pass.pkg && inScope(errObj)) {
      method = errObj;
    } else {
      return null;
    }
    const sig = method.type() as types.Signature;
    if (!isStringer(sig)) {
      return null;
    }
    let x = e;
    if (x?.$type === "UnaryExpr" && x.op === token.AND) {
      x = x.x;
    }
    // Uses refers to the declared receiver, which an instantiated receiver
    // type's method does not share, so compare with the origin.
    if (x?.$type === "Ident" && this.info.uses.get(x) === sig.recv()!.origin()) {
      return method.fullName();
    }
    return null;
  }

  // isFormatter reports whether typ could satisfy fmt.Formatter.
  isFormatter(typ: types.Type | null): boolean {
    if (typ === null) {
      return false;
    }
    // An interface value might hold a Formatter; a type parameter is not
    // assumed to.
    if (typ.underlying()?.$type === "Interface" && types.unalias(typ)?.$type !== "TypeParam") {
      return true;
    }
    const [obj] = types.lookupFieldOrMethod(typ, false, null, "Format");
    if (obj?.$type !== "Func") {
      return false;
    }
    const sig = obj.type() as types.Signature;
    const params = sig.params();
    return (
      params?.len() === 2 &&
      (sig.results()?.len() ?? 0) === 0 &&
      isTypeNamed(params.at(0)!.type(), "fmt", "State") &&
      types.identical(params.at(1)!.type(), types.Typ[types.Rune])
    );
  }

  isConvertibleToString(typ: types.Type | null): boolean {
    const basic = types.unalias(typ);
    // Untyped nil converts to both interfaces, but would just panic.
    if (basic?.$type === "Basic" && basic.kind() === types.UntypedNil) {
      return false;
    }
    if (types.convertibleTo(typ, this.errorType)) {
      return true;
    }
    const [obj] = types.lookupFieldOrMethod(typ, false, null, "String");
    return obj?.$type === "Func" && isStringer(obj.type() as types.Signature);
  }

  // matchArgType returns whether a verb accepting t accepts arg, and if not
  // possibly why. A type parameter must match in its whole type set.
  private matchArgType(t: number, arg: ast.Expr): [string, boolean] {
    if (t === anyType) {
      return ["", true];
    }
    const typ = this.info.types.get(arg)?.type ?? null;
    if (typ === null) {
      return ["", true];
    }
    const m = new ArgMatcher(this, t);
    const ok = m.match(typ, true);
    return [m.reason, ok];
  }
}

// ArgMatcher matches types against a verb's argument types, recursing into
// compound types and type sets. Seen types stop the recursion.
class ArgMatcher {
  private readonly seen = new Set<types.Type>();
  reason = "";

  constructor(
    private readonly checker: Checker,
    private readonly t: number,
  ) {}

  // match reports whether typ matches. topLevel is true for the argument's
  // own type, and for the terms of a top-level type parameter.
  match(typ: types.Type, topLevel: boolean): boolean {
    const t = this.t;
    if (t === argError) {
      return types.convertibleTo(typ, this.checker.errorType);
    }
    if (this.checker.isFormatter(typ)) {
      return true;
    }
    // A String or Error method may provide the string.
    if ((t & argString) !== 0 && this.checker.isConvertibleToString(typ)) {
      return true;
    }
    const tparam = types.unalias(typ);
    if (tparam?.$type === "TypeParam") {
      if (this.seen.has(tparam)) {
        return true;
      }
      this.seen.add(tparam);
      const terms = structuralTerms(tparam);
      if (terms === null) {
        return true; // invalid type, possibly an empty type set
      }
      // Some type in an unrestricted type set fails the checks below.
      if (terms.length === 0) {
        return false;
      }
      // A reason only makes sense for the argument's own type parameter.
      const reportReason = this.seen.size === 1;
      for (const term of terms) {
        if (!this.match(term.type()!, topLevel)) {
          if (reportReason) {
            this.reason = `contains ${term.tilde() ? "~" : ""}${term.type()!.string()}`;
          }
          return false;
        }
      }
      return true;
    }

    const u = typ.underlying()!;
    // Already matched, or being matched. Wrong for some pathological types
    // such as type R struct { F []R }, an acceptable false negative.
    if (this.seen.has(u)) {
      return true;
    }
    this.seen.add(u);
    switch (u.$type) {
      case "Signature":
        return t === argPointer;
      case "Map":
        return t === argPointer || (this.match(u.key()!, false) && this.match(u.elem()!, false));
      case "Chan":
        return (t & argPointer) !== 0;
      case "Array":
      case "Slice":
        if (types.identical(u.elem()!.underlying(), types.Typ[types.Byte]) && (t & argString) !== 0) {
          return true; // %s matches []byte
        }
        if (u.$type === "Slice" && t === argPointer) {
          return true; // %p prints a slice's 0th element
        }
        return this.match(u.elem()!, false);
      case "Pointer": {
        // A pointer to an invalid type, probably from a failed import.
        if (u.elem() === types.Typ[types.Invalid]) {
          return true;
        }
        if (t === argPointer) {
          return true;
        }
        if (types.unalias(u.elem())?.$type === "TypeParam") {
          return true;
        }
        const under = u.elem()!.underlying()!;
        switch (under.$type) {
          case "Struct":
          case "Array":
          case "Slice":
          case "Map":
            break;
          default:
            if ((t & argPointer) === 0 && (t & argInt) !== 0) {
              this.reason = "use %p for a pointer";
            }
            return (t & argPointer) !== 0;
        }
        // A top-level pointer to a struct, array, slice or map prints as
        // its target; nested ones do not, to keep fmt out of loops.
        return topLevel && this.match(under, false);
      }
      case "Struct":
        for (const field of u.fields()) {
          if (!this.match(field!.type()!, false)) {
            return false;
          }
          // An unexported Stringer or error cannot be formatted (go.dev/issue/17798).
          if ((t & argString) !== 0 && !field!.exported() && this.checker.isConvertibleToString(field!.type()!)) {
            return false;
          }
        }
        return true;
      case "Interface":
        // Whether a verb suits depends on the dynamic value.
        return true;
      case "Basic":
        return matchBasic(u.kind(), t, this);
    }
    return false;
  }
}

function matchBasic(kind: types.BasicKind, t: number, m: ArgMatcher): boolean {
  switch (kind) {
    case types.UntypedBool:
    case types.Bool:
      return (t & argBool) !== 0;
    case types.Byte:
      return (t & (argInt | argByte)) !== 0;
    case types.Rune:
    case types.UntypedRune:
      return (t & (argInt | argRune)) !== 0;
    case types.UntypedInt:
    case types.Int:
    case types.Int8:
    case types.Int16:
    case types.Int64:
    case types.Uint:
    case types.Uint16:
    case types.Uint32:
    case types.Uint64:
    case types.Uintptr:
      return (t & argInt) !== 0;
    case types.UntypedFloat:
    case types.Float32:
    case types.Float64:
      return (t & argFloat) !== 0;
    case types.UntypedComplex:
    case types.Complex64:
    case types.Complex128:
      return (t & argComplex) !== 0;
    case types.UntypedString:
    case types.String:
      return (t & argString) !== 0;
    case types.UnsafePointer:
      if ((t & argPointer) === 0 && (t & argInt) !== 0) {
        m.reason = "use %p for a pointer";
      }
      return (t & argPointer) !== 0;
    case types.UntypedNil:
      return false;
    case types.Invalid:
      return true; // probably a type check problem
  }
  return false;
}

// formatArgsParams returns the "format string" (if any) and "args ...any"
// parameters of a potential print or printf wrapper, or null.
function formatArgsParams(sig: types.Signature): [types.Var | null, types.Var] | null {
  if (!sig.variadic()) {
    return null;
  }
  const params = sig.params()!;
  const n = params.len();
  let format: types.Var | null = null;
  if (n >= 2) {
    const p = params.at(n - 2)!;
    if (p.type() === types.Typ[types.String]) {
      format = p;
    }
  }
  const args = params.at(n - 1)!;
  const slice = args.type();
  const elem = types.unalias(slice?.$type === "Slice" ? slice.elem() : null);
  if (elem?.$type !== "Interface" || !elem.empty()) {
    return null;
  }
  return [format, args];
}

// variadicDecls returns, in preorder, the function declarations, function
// literals and interface types with a variadic parameter list. Upstream
// visits every one; candidates must be variadic, and this is far cheaper.
function variadicDecls(root: inspector.Cursor): inspector.Cursor[] {
  const found = new Map<number, inspector.Cursor>();
  for (const cur of root.preorder(ast.Ellipsis)) {
    if (cur.parentEdgeKind() !== edge.Field_Type) {
      continue;
    }
    const list = cur.parent().parent();
    if (list.parentEdgeKind() !== edge.FuncType_Params) {
      continue;
    }
    const funcType = list.parent();
    const kind = funcType.parentEdgeKind();
    if (kind === edge.FuncDecl_Type || kind === edge.FuncLit_Type) {
      const decl = funcType.parent();
      found.set(decl.index(), decl);
    } else if (kind === edge.Field_Type) {
      const methods = funcType.parent().parent();
      if (methods.parentEdgeKind() === edge.InterfaceType_Methods) {
        const iface = methods.parent();
        found.set(iface.index(), iface);
      }
    }
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, cur]) => cur);
}

function match(info: types.Info, arg: ast.Expr | null, param: types.Var | null): boolean {
  return arg?.$type === "Ident" && info.objectOf(arg) === param;
}

function origin(obj: types.Object): types.Object {
  if (obj.$type === "Func" || obj.$type === "Var") {
    return obj.origin()!;
  }
  return obj;
}

function fullname(obj: types.Object): string {
  return obj.$type === "Func" ? obj.fullName() : obj.name();
}

function isStringer(sig: types.Signature): boolean {
  return (sig.params()?.len() ?? 0) === 0 && sig.results()?.len() === 1 && sig.results()!.at(0)!.type() === types.Typ[types.String];
}

// count returns "1 what" or "N whats".
function count(n: number, what: string): string {
  return n === 1 ? `1 ${what}` : `${n} ${what}s`;
}

function isHex(c: string): boolean {
  return /^[0-9A-Fa-f]$/.test(c);
}

// A possible format string in the first argument to an unformatted print.
// The space flag is excluded, so "x % y" does not match.
const printFormatRE = /%[+\-#]*([0-9]+|(\[[0-9]+\])?\*)?\.?([0-9]+|(\[[0-9]+\])?\*)?(\[[0-9]+\])?[bcdefgopqstvxEFGTUX]/g;

// The types of argument a verb accepts, as a bit mask.
const argBool = 1 << 0;
const argByte = 1 << 1;
const argInt = 1 << 2;
const argRune = 1 << 3;
const argString = 1 << 4;
const argFloat = 1 << 5;
const argComplex = 1 << 6;
const argPointer = 1 << 7;
const argError = 1 << 8;
const anyType = ~0;

interface PrintVerb {
  verb: number;
  flags: string;
  typ: number;
}

const noFlag = "";
const numFlag = " -+.0";
const sharpNumFlag = " -+.0#";
const allFlags = " -+.0#";

const printVerb = (v: string, flags: string, typ: number): PrintVerb => ({ verb: v.codePointAt(0)!, flags, typ });

// The flags and argument types each verb accepts.
const printVerbs: readonly PrintVerb[] = [
  printVerb("%", noFlag, 0),
  printVerb("b", sharpNumFlag, argInt | argFloat | argComplex | argPointer),
  printVerb("c", "-", argRune | argInt),
  printVerb("d", numFlag, argInt | argPointer),
  printVerb("e", sharpNumFlag, argFloat | argComplex),
  printVerb("E", sharpNumFlag, argFloat | argComplex),
  printVerb("f", sharpNumFlag, argFloat | argComplex),
  printVerb("F", sharpNumFlag, argFloat | argComplex),
  printVerb("g", sharpNumFlag, argFloat | argComplex),
  printVerb("G", sharpNumFlag, argFloat | argComplex),
  printVerb("o", sharpNumFlag, argInt | argPointer),
  printVerb("O", sharpNumFlag, argInt | argPointer),
  printVerb("p", "-#", argPointer),
  printVerb("q", " -+.0#", argRune | argInt | argString),
  printVerb("s", " -+.0", argString),
  printVerb("t", "-", argBool),
  printVerb("T", "-", anyType),
  printVerb("U", "-#", argRune | argInt),
  printVerb("v", allFlags, anyType),
  printVerb("w", allFlags, argError),
  printVerb("x", sharpNumFlag, argRune | argInt | argString | argPointer | argFloat | argComplex),
  printVerb("X", sharpNumFlag, argRune | argInt | argString | argPointer | argFloat | argComplex),
];

// opRange returns the range of an operation such as %v within a literal
// format string, or the whole format argument.
function opRange(formatArg: ast.Expr, format: string, op: Operation): Range {
  if (formatArg.$type === "BasicLit") {
    const pos = posInStringLiteral(formatArg, byteLength(format.slice(0, op.range.start)));
    const end = posInStringLiteral(formatArg, byteLength(format.slice(0, op.range.end)));
    if (pos !== null && end !== null) {
      return { pos, end };
    }
  }
  return rangeOf(formatArg);
}

// -- Port of internal/astutil's string literal positions. --

// posInStringLiteral returns the position in a string literal of a byte
// offset in the string it denotes, or null.
function posInStringLiteral(lit: ast.BasicLit, offset: number): token.Pos | null {
  const value = unquote(lit.value);
  if (value === null || offset < 0 || offset > byteLength(value)) {
    return null;
  }
  let raw = lit.value;
  // Carriage returns removed from a raw string still occupy the source.
  const norm = lit.end() - lit.pos() > byteLength(raw);
  const quote = raw[0];
  raw = raw.slice(1, -1);
  let i = 0;
  let pos = lit.pos() + 1;
  for (let k = 0; k < raw.length; ) {
    const [r, next] = unquoteChar(raw, k, quote);
    let nextPos = pos + byteLength(raw.slice(k, next));
    if (norm && r === 0x0a) {
      nextPos++;
    }
    const nextI = i + runeLen(r);
    if (nextPos > lit.end() || nextI > offset) {
      break;
    }
    k = next;
    i = nextI;
    pos = nextPos;
  }
  return pos;
}

const charEscapes: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, "'": 39, '"': 34 };

// unquoteChar decodes the character or escape at raw[k] in a valid literal,
// returning its value and the index after it.
function unquoteChar(raw: string, k: number, quote: string): [number, number] {
  if (quote === "`" || raw[k] !== "\\") {
    const cp = raw.codePointAt(k)!;
    return [cp, k + (cp > 0xffff ? 2 : 1)];
  }
  const c = raw[k + 1];
  if (c in charEscapes) {
    return [charEscapes[c], k + 2];
  }
  switch (c) {
    case "x":
      return [Number.parseInt(raw.slice(k + 2, k + 4), 16), k + 4];
    case "u":
      return [Number.parseInt(raw.slice(k + 2, k + 6), 16), k + 6];
    case "U":
      return [Number.parseInt(raw.slice(k + 2, k + 10), 16), k + 10];
  }
  return [Number.parseInt(raw.slice(k + 1, k + 4), 8), k + 4];
}

// runeLen is utf8.RuneLen, which upstream also applies to byte escapes.
function runeLen(r: number): number {
  if (r < 0) {
    return -1;
  }
  if (r < 0x80) {
    return 1;
  }
  if (r < 0x800) {
    return 2;
  }
  if (r >= 0xd800 && r <= 0xdfff) {
    return -1;
  }
  return r < 0x10000 ? 3 : r <= 0x10ffff ? 4 : -1;
}

// -- Port of internal/fmtstr. Offsets are UTF-16 indexes into the format. --

interface FmtRange {
  start: number;
  end: number;
}

// A Size is an optional width or precision. At most one of fixed and
// dynamic, the index of the argument giving the size, is non-negative.
interface Size {
  fixed: number;
  dynamic: number;
  index: number; // n in %[n]*d, otherwise -1
  range: FmtRange;
}

interface FmtVerb {
  verb: number;
  range: FmtRange;
  index: number; // n in %[n]d, otherwise -1
  argIndex: number; // the argument's index in the call
}

interface Operation {
  text: string;
  verb: FmtVerb;
  range: FmtRange;
  flags: string;
  width: Size;
  prec: Size;
}

const noSize = (): Size => ({ fixed: -1, dynamic: -1, index: -1, range: { start: 0, end: 0 } });

// parseFormat parses a format string whose index in the call is idx,
// returning its operations or an error in predicate form, such as "call
// has a problem".
function parseFormat(format: string, idx: number): Operation[] | string {
  if (!format.includes("%")) {
    return "call has arguments but no formatting directives";
  }
  const firstArg = idx + 1;
  let argNum = firstArg;
  const operations: Operation[] = [];
  for (let i = 0, w = 0; i < format.length; i += w) {
    w = 1;
    if (format[i] !== "%") {
      continue;
    }
    const state = new FmtState(format.slice(i), firstArg, argNum);
    const err = state.parseOperation();
    if (err !== null) {
      return err;
    }
    const op = state.operation;
    addOffset(op, i);
    operations.push(op);
    w = op.text.length;
    // A '%' verb consumes no argument.
    if (op.verb.verb !== 0x25) {
      argNum = state.argNum + 1;
    }
  }
  return operations;
}

function addOffset(op: Operation, offset: number): void {
  op.verb.range.start += offset;
  op.verb.range.end += offset;
  op.range = { start: offset, end: op.verb.range.end };
  for (const size of [op.prec, op.width]) {
    if (size.fixed !== -1 || size.dynamic !== -1) {
      size.range.start += offset;
      size.range.end += offset;
    }
  }
}

class FmtState {
  readonly operation: Operation;
  private index = 0;
  private indexPos = 0;
  // Whether an argument index awaits a '*' or verb.
  private indexPending = false;
  private nbytes = 1; // past the '%'

  constructor(
    text: string,
    private readonly firstArg: number,
    public argNum: number,
  ) {
    this.operation = {
      text,
      verb: { verb: 0, range: { start: 0, end: 0 }, index: -1, argIndex: 0 },
      range: { start: 0, end: 0 },
      flags: "",
      width: noSize(),
      prec: noSize(),
    };
  }

  // parseOperation parses '%', flags, [n]* or width, .[n]* or precision,
  // [n], then the verb.
  parseOperation(): string | null {
    const op = this.operation;
    this.parseFlags();
    let err = this.parseIndex();
    if (err !== null) {
      return err;
    }
    this.parseSize(false);
    err = this.parsePrecision();
    if (err !== null) {
      return err;
    }
    // The verb may have an index, unless one is pending already.
    if (!this.indexPending) {
      err = this.parseIndex();
      if (err !== null) {
        return err;
      }
    }
    if (this.nbytes === op.text.length) {
      return `format ${op.text} is missing verb at end of string`;
    }
    const verb = op.text.codePointAt(this.nbytes)!;
    const w = verb > 0xffff ? 2 : 1;
    if (this.indexPending) {
      op.verb = { verb, range: { start: this.indexPos, end: this.nbytes + w }, index: this.index, argIndex: this.argNum };
    } else {
      op.verb = { verb, range: { start: this.nbytes, end: this.nbytes + w }, index: -1, argIndex: this.argNum };
    }
    this.nbytes += w;
    op.text = op.text.slice(0, this.nbytes);
    return null;
  }

  private parseFlags(): void {
    const text = this.operation.text;
    let end = this.nbytes;
    while (end < text.length && "#0+- ".includes(text[end])) {
      end++;
    }
    this.operation.flags = text.slice(this.nbytes, end);
    this.nbytes = end;
  }

  // parseIndex parses an argument index such as [2].
  private parseIndex(): string | null {
    const text = this.operation.text;
    if (this.nbytes === text.length || text[this.nbytes] !== "[") {
      return null;
    }
    this.nbytes++;
    const start = this.nbytes;
    const num = this.scanNum();
    if (num !== null) {
      this.index = num;
      this.indexPos = start - 1;
    }
    let ok = true;
    if (this.nbytes === text.length || this.nbytes === start || text[this.nbytes] !== "]") {
      // Either the ] is missing or the index is invalid.
      ok = false;
      const close = text.slice(start).indexOf("]");
      if (close < 0) {
        return `format ${text} is missing closing ]`;
      }
      this.nbytes = close + start;
    }
    const digits = text.slice(start, this.nbytes);
    const arg = /^[0-9]+$/.test(digits) ? Number(digits) : Number.NaN;
    if (!ok || !(arg > 0 && arg <= maxInt32)) {
      return `format has invalid argument index [${digits}]`;
    }
    this.nbytes++;
    this.argNum = arg + this.firstArg - 1;
    this.indexPending = true;
    return null;
  }

  // scanNum consumes a decimal number, returning null if there is none or
  // it runs to the end of the text.
  private scanNum(): number | null {
    const text = this.operation.text;
    const start = this.nbytes;
    for (; this.nbytes < text.length; this.nbytes++) {
      const c = text.charCodeAt(this.nbytes);
      if (c < 0x30 || c > 0x39) {
        return start < this.nbytes ? Math.min(Number(text.slice(start, this.nbytes)), maxInt32) : null;
      }
    }
    return null;
  }

  // parseSize parses a width or precision: a number, *, or [n]*.
  private parseSize(precision: boolean): void {
    const text = this.operation.text;
    let size: Size | null = null;
    if (this.nbytes < text.length && text[this.nbytes] === "*") {
      this.nbytes++;
      if (this.indexPending) {
        this.indexPending = false;
        size = { fixed: -1, dynamic: this.argNum, index: this.index, range: { start: this.indexPos, end: this.nbytes } };
      } else {
        size = { fixed: -1, dynamic: this.argNum, index: -1, range: { start: this.nbytes - 1, end: this.nbytes } };
      }
      this.argNum++;
    } else {
      const start = this.nbytes;
      const num = this.scanNum();
      if (num !== null) {
        size = { fixed: num, dynamic: -1, index: -1, range: { start, end: this.nbytes } };
      }
    }
    if (size === null) {
      return;
    }
    if (precision) {
      // Include the leading '.'.
      size.range.start--;
      this.operation.prec = size;
    } else {
      this.operation.width = size;
    }
  }

  private parsePrecision(): string | null {
    const text = this.operation.text;
    if (this.nbytes < text.length && text[this.nbytes] === ".") {
      this.nbytes++;
      const err = this.parseIndex();
      if (err !== null) {
        return err;
      }
      this.parseSize(true);
    }
    return null;
  }
}

const maxInt32 = 2147483647;

// -- Port of refactor/satisfy's Finder. --

// SatisfyFinder finds the pairs of types (lhs, rhs) where rhs must be
// assignable to the interface lhs, both having methods, for a package to
// compile. It requires well-typed input.
class SatisfyFinder {
  readonly result = new Map<types.Type, Set<types.Type>>();
  private readonly msetLens = new Map<types.Type, number>();
  private sig: types.Signature | null = null;
  private readonly tInvalid = types.Typ[types.Invalid]!;
  private readonly tUntypedBool = types.Typ[types.UntypedBool]!;
  private readonly tUntypedNil = types.Typ[types.UntypedNil]!;

  constructor(private readonly info: types.Info) {}

  find(files: readonly (ast.File | null)[]): void {
    for (const file of files) {
      for (const d of file!.decls) {
        if (d?.$type === "GenDecl") {
          if (d.tok === token.VAR) {
            for (const spec of d.specs) {
              this.valueSpec(spec as ast.ValueSpec);
            }
          }
        } else if (d?.$type === "FuncDecl" && d.body !== null) {
          const obj = this.info.defs.get(d.name!);
          if (obj) {
            const sig = obj.type();
            this.sig = sig?.$type === "Signature" ? sig : null;
          }
          this.stmt(d.body);
          this.sig = null;
        }
      }
    }
  }

  private typeOf(e: ast.Expr | null): types.Type | null {
    return e === null ? null : (this.info.types.get(e)?.type ?? null);
  }

  // exprN visits an expression in a multi-value context.
  private exprN(e: ast.Expr): types.Type {
    const t = this.typeOf(e);
    const tuple = t?.$type === "Tuple" ? t : null;
    switch (e.$type) {
      case "ParenExpr":
        return this.exprN(e.x!);
      case "CallExpr": {
        const sig = underlyingTerm(this.expr(e.fun!), "Signature");
        if (sig !== null) {
          this.call(sig, e.args);
        }
        break;
      }
      case "IndexExpr": {
        const m = underlyingTerm(this.expr(e.x!), "Map");
        if (m !== null) {
          this.assign(this.expr(e.index!), m.key());
        }
        break;
      }
      case "TypeAssertExpr":
        if (tuple !== null && tuple.len() > 0) {
          this.typeAssert(this.expr(e.x!), tuple.at(0)!.type());
        } else {
          this.expr(e.x!);
        }
        break;
      case "UnaryExpr":
        this.expr(e.x!);
        break;
    }
    return tuple ?? this.tInvalid;
  }

  private call(sig: types.Signature, args: readonly (ast.Expr | null)[]): void {
    if (args.length === 0) {
      return;
    }
    const params = sig.params();
    const param = (i: number): types.Type | null => (params !== null && i < params.len() ? params.at(i)!.type() : null);
    const argtypes: types.Type[] = [];
    const first = this.typeOf(args[0]);
    if (first?.$type === "Tuple") {
      // f(g()) where g has multiple results.
      this.expr(args[0]!);
      for (const v of first.variables()) {
        argtypes.push(v!.type()!);
      }
    } else {
      for (const arg of args) {
        argtypes.push(this.expr(arg!));
      }
    }
    if (!sig.variadic()) {
      argtypes.forEach((argtype, i) => {
        this.assign(param(i), argtype);
      });
      return;
    }
    const nnormals = (params?.len() ?? 1) - 1;
    const variadic = param(nnormals);
    const tElem = variadic?.$type === "Slice" ? variadic.elem() : null;
    argtypes.forEach((argtype, i) => {
      this.assign(i < nnormals ? param(i) : tElem, argtype);
    });
  }

  private builtin(obj: types.Builtin, sig: types.Signature | null, args: readonly (ast.Expr | null)[]): void {
    switch (obj.name()) {
      case "make":
      case "new":
        args.forEach((arg, i) => {
          if (i !== 0 || !this.info.types.get(arg!)?.isType()) {
            this.expr(arg!);
          }
        });
        break;
      case "append": {
        // Upstream's special case for append(x, y...) never matches, as
        // call arguments are never Ellipsis nodes.
        const s = underlyingTerm(this.expr(args[0]!), "Slice");
        if (s !== null) {
          for (const arg of args.slice(1)) {
            this.assign(s.elem(), this.expr(arg!));
          }
        }
        break;
      }
      case "delete": {
        const m = this.expr(args[0]!);
        const k = this.expr(args[1]!);
        const mt = underlyingTerm(m, "Map");
        if (mt !== null) {
          this.assign(mt.key(), k);
        }
        break;
      }
      default:
        if (sig !== null) {
          this.call(sig, args);
        }
    }
  }

  private extract(tuple: types.Type, i: number): types.Type {
    return tuple.$type === "Tuple" && i < tuple.len() ? tuple.at(i)!.type()! : this.tInvalid;
  }

  private valueSpec(spec: ast.ValueSpec): void {
    const T = this.typeOf(spec.type);
    if (spec.values.length === spec.names.length) {
      for (const value of spec.values) {
        const v = this.expr(value!);
        if (T !== null) {
          this.assign(T, v);
        }
      }
    } else if (spec.values.length === 1) {
      const tuple = this.exprN(spec.values[0]!);
      if (T !== null) {
        for (let i = 0; i < spec.names.length; i++) {
          this.assign(T, this.extract(tuple, i));
        }
      }
    }
  }

  private msetLen(t: types.Type): number {
    let n = this.msetLens.get(t);
    if (n === undefined) {
      n = types.newMethodSet(t)!.len();
      this.msetLens.set(t, n);
    }
    return n;
  }

  // assign records lhs and rhs if lhs is an interface and both have methods.
  private assign(lhs: types.Type | null, rhs: types.Type | null): void {
    if (lhs === null || rhs === null || !types.isInterface(lhs) || types.identical(lhs, rhs)) {
      return;
    }
    if (this.msetLen(lhs) === 0 || this.msetLen(rhs) === 0) {
      return;
    }
    let set = this.result.get(lhs);
    if (set === undefined) {
      set = new Set();
      this.result.set(lhs, set);
    }
    set.add(rhs);
  }

  // typeAssert handles x.(T), which may be impossible: T need not be
  // assignable to x's type I.
  private typeAssert(I: types.Type | null, T: types.Type | null): void {
    if (I !== null && T !== null && types.assignableTo(T, I)) {
      this.assign(I, T);
    }
  }

  private compare(x: types.Type | null, y: types.Type | null): void {
    if (x === null || y === null) {
      return;
    }
    if (types.assignableTo(x, y)) {
      this.assign(y, x);
    } else if (types.assignableTo(y, x)) {
      this.assign(x, y);
    }
  }

  // expr visits an expression that is not a type or defining identifier,
  // returning its type.
  private expr(e: ast.Expr): types.Type {
    const tv = this.info.types.get(e);
    const typ = tv?.type ?? null;
    // Constant expressions are not descended into.
    if (tv?.value) {
      return typ ?? this.tInvalid;
    }
    switch (e.$type) {
      case "Ident": {
        const obj = this.info.uses.get(e);
        return obj ? (obj.type() ?? this.tInvalid) : this.tInvalid;
      }
      case "Ellipsis":
        if (e.elt !== null) {
          this.expr(e.elt);
        }
        break;
      case "FuncLit": {
        const saved = this.sig;
        this.sig = typ?.$type === "Signature" ? typ : null;
        this.stmt(e.body!);
        this.sig = saved;
        break;
      }
      case "CompositeLit":
        if (typ !== null) {
          this.compositeLit(e, typ);
        }
        break;
      case "ParenExpr":
      case "StarExpr":
      case "UnaryExpr":
        this.expr(e.x!);
        break;
      case "SelectorExpr": {
        const seln = this.info.selections.get(e);
        if (seln) {
          // e.X is a type in a method expression such as T.m.
          if (seln.kind() !== types.MethodExpr) {
            this.expr(e.x!);
          }
        } else {
          // A qualified identifier.
          const obj = this.info.uses.get(e.sel!);
          return obj ? (obj.type() ?? this.tInvalid) : this.tInvalid;
        }
        break;
      }
      case "IndexExpr":
        // Not a generic instantiation f[T] or C[T].
        if (!this.instance(e.x)) {
          const x = this.expr(e.x!);
          const i = this.expr(e.index!);
          const m = underlyingTerm(x, "Map");
          if (m !== null) {
            this.assign(m.key(), i);
          }
        }
        break;
      case "SliceExpr":
        for (const sub of [e.x, e.low, e.high, e.max]) {
          if (sub !== null) {
            this.expr(sub);
          }
        }
        break;
      case "TypeAssertExpr":
        this.typeAssert(this.expr(e.x!), this.typeOf(e.type));
        break;
      case "CallExpr":
        return this.callExpr(e, typ);
      case "BinaryExpr": {
        const x = this.expr(e.x!);
        const y = this.expr(e.y!);
        if (e.op === token.EQL || e.op === token.NEQ) {
          this.compare(x, y);
        }
        break;
      }
      case "KeyValueExpr":
        this.expr(e.key!);
        this.expr(e.value!);
        break;
    }
    return typ ?? this.tInvalid;
  }

  private callExpr(e: ast.CallExpr, typ: types.Type | null): types.Type {
    const tvFun = this.info.types.get(e.fun!);
    if (tvFun?.isType()) {
      // A conversion.
      this.assign(tvFun.type, this.expr(e.args[0]!));
      return typ ?? this.tInvalid;
    }
    const fun = ast.unparen(e.fun);
    // Functions in unsafe have no signature object.
    if (fun?.$type === "SelectorExpr") {
      const obj = this.info.uses.get(fun.sel!);
      if (obj?.$type === "Builtin" && obj.pkg()?.path() === "unsafe") {
        const sig = tvFun?.type;
        if (sig?.$type === "Signature") {
          this.call(sig, e.args);
        }
        return typ ?? this.tInvalid;
      }
    }
    if (fun?.$type === "Ident") {
      const obj = this.info.uses.get(fun);
      if (obj?.$type === "Builtin") {
        const sig = this.typeOf(fun);
        this.builtin(obj, sig?.$type === "Signature" ? sig : null, e.args);
        return typ ?? this.tInvalid;
      }
    }
    const sig = underlyingTerm(this.expr(e.fun!), "Signature");
    if (sig !== null) {
      this.call(sig, e.args);
    }
    return typ ?? this.tInvalid;
  }

  private compositeLit(e: ast.CompositeLit, typ: types.Type): void {
    for (const term of termTypes(deref(typ))) {
      const T = term.underlying()!;
      switch (T.$type) {
        case "Struct":
          e.elts.forEach((elem, i) => {
            if (elem?.$type === "KeyValueExpr") {
              const id = elem.key;
              const field = id?.$type === "Ident" ? this.info.uses.get(id) : null;
              if (!field) {
                this.expr(elem.value!);
              } else {
                this.assign(field.type(), this.expr(elem.value!));
              }
            } else {
              this.assign(T.field(i)?.type() ?? null, this.expr(elem!));
            }
          });
          break;
        case "Map":
          for (const elem of e.elts) {
            const kv = elem as ast.KeyValueExpr;
            this.assign(T.key(), this.expr(kv.key!));
            this.assign(T.elem(), this.expr(kv.value!));
          }
          break;
        case "Array":
        case "Slice":
          for (const elem of e.elts) {
            this.assign(T.elem(), this.expr(elem?.$type === "KeyValueExpr" ? elem.value! : elem!));
          }
          break;
        case "Basic":
          if (T.kind() === types.Invalid) {
            for (const elem of e.elts) {
              if (elem?.$type === "KeyValueExpr") {
                this.expr(elem.key!);
                this.expr(elem.value!);
              } else {
                this.expr(elem!);
              }
            }
          }
          break;
      }
    }
  }

  private instance(expr: ast.Expr | null): boolean {
    const id = expr?.$type === "Ident" ? expr : expr?.$type === "SelectorExpr" ? expr.sel : null;
    return id !== null && this.info.instances.has(id);
  }

  private stmts(list: readonly (ast.Stmt | null)[]): void {
    for (const s of list) {
      this.stmt(s!);
    }
  }

  private stmt(s: ast.Stmt): void {
    switch (s.$type) {
      case "DeclStmt": {
        const d = s.decl as ast.GenDecl;
        if (d.tok === token.VAR) {
          for (const spec of d.specs) {
            this.valueSpec(spec as ast.ValueSpec);
          }
        }
        break;
      }
      case "LabeledStmt":
        this.stmt(s.stmt!);
        break;
      case "ExprStmt":
        this.expr(s.x!);
        break;
      case "SendStmt": {
        const ch = this.expr(s.chan!);
        const val = this.expr(s.value!);
        const c = underlyingTerm(ch, "Chan");
        if (c !== null) {
          this.assign(c.elem(), val);
        }
        break;
      }
      case "IncDecStmt":
        this.expr(s.x!);
        break;
      case "AssignStmt":
        this.assignStmt(s);
        break;
      case "GoStmt":
      case "DeferStmt":
        this.expr(s.call!);
        break;
      case "ReturnStmt": {
        if (this.sig === null) {
          for (const result of s.results) {
            this.expr(result!);
          }
          break;
        }
        const formals = this.sig.results();
        const n = formals?.len() ?? 0;
        if (s.results.length === n) {
          s.results.forEach((result, i) => {
            this.assign(formals!.at(i)!.type(), this.expr(result!));
          });
        } else if (s.results.length === 1) {
          const tuple = this.exprN(s.results[0]!);
          for (let i = 0; i < n; i++) {
            this.assign(formals!.at(i)!.type(), this.extract(tuple, i));
          }
        }
        break;
      }
      case "SelectStmt":
        this.stmt(s.body!);
        break;
      case "BlockStmt":
        this.stmts(s.list);
        break;
      case "IfStmt":
        if (s.init !== null) {
          this.stmt(s.init);
        }
        this.expr(s.cond!);
        this.stmt(s.body!);
        if (s.else !== null) {
          this.stmt(s.else);
        }
        break;
      case "SwitchStmt": {
        if (s.init !== null) {
          this.stmt(s.init);
        }
        const tag = s.tag !== null ? this.expr(s.tag) : this.tUntypedBool;
        for (const cc of s.body!.list as ast.CaseClause[]) {
          for (const cond of cc.list) {
            this.compare(tag, this.typeOf(cond));
          }
          this.stmts(cc.body);
        }
        break;
      }
      case "TypeSwitchStmt": {
        if (s.init !== null) {
          this.stmt(s.init);
        }
        let I: types.Type | null = null;
        const assign = s.assign;
        if (assign?.$type === "ExprStmt") {
          I = this.expr((ast.unparen(assign.x) as ast.TypeAssertExpr).x!);
        } else if (assign?.$type === "AssignStmt") {
          I = this.expr((ast.unparen(assign.rhs[0]) as ast.TypeAssertExpr).x!);
        }
        for (const cc of s.body!.list as ast.CaseClause[]) {
          for (const cond of cc.list) {
            const tCase = this.typeOf(cond);
            if (tCase !== this.tUntypedNil) {
              this.typeAssert(I, tCase);
            }
          }
          this.stmts(cc.body);
        }
        break;
      }
      case "CommClause":
        if (s.comm !== null) {
          this.stmt(s.comm);
        }
        this.stmts(s.body);
        break;
      case "ForStmt":
        if (s.init !== null) {
          this.stmt(s.init);
        }
        if (s.cond !== null) {
          this.expr(s.cond);
        }
        if (s.post !== null) {
          this.stmt(s.post);
        }
        this.stmt(s.body!);
        break;
      case "RangeStmt":
        this.rangeStmt(s);
        break;
    }
  }

  private assignStmt(s: ast.AssignStmt): void {
    if (s.tok !== token.ASSIGN && s.tok !== token.DEFINE) {
      // y op= x
      this.expr(s.lhs[0]!);
      this.expr(s.rhs[0]!);
      return;
    }
    const rhsTuple = s.lhs.length !== s.rhs.length ? this.exprN(s.rhs[0]!) : null;
    s.lhs.forEach((lhsExpr, i) => {
      const rhs = rhsTuple === null ? this.expr(s.rhs[i]!) : this.extract(rhsTuple, i);
      let lhs: types.Type | null = null;
      if (lhsExpr?.$type === "Ident" && lhsExpr.name !== "_") {
        const obj = this.info.defs.get(lhsExpr);
        if (obj) {
          lhs = obj.type();
        }
      }
      this.assign(lhs ?? this.expr(lhsExpr!), rhs);
    });
  }

  private rangeStmt(s: ast.RangeStmt): void {
    const x = this.expr(s.x!);
    // No conversions are involved when Tok is DEFINE.
    if (s.tok === token.ASSIGN) {
      if (s.key !== null) {
        // Keys of arrays, slices and strings are just ints.
        const k = this.expr(s.key);
        for (const term of termTypes(x)) {
          const u = term.underlying();
          if (u?.$type === "Chan") {
            this.assign(k, u.elem());
          } else if (u?.$type === "Map") {
            this.assign(k, u.key());
          }
        }
      }
      if (s.value !== null) {
        // Values of strings are just runes.
        const val = this.expr(s.value);
        for (const term of termTypes(x)) {
          const u = term.underlying();
          if (u?.$type === "Pointer") {
            for (const elem of termTypes(u.elem()!)) {
              const array = elem.underlying();
              if (array?.$type === "Array") {
                this.assign(val, array.elem());
              }
            }
          } else if (u?.$type === "Array" || u?.$type === "Map" || u?.$type === "Slice") {
            this.assign(val, u.elem());
          }
        }
      }
    }
    this.stmt(s.body!);
  }
}

// termTypes returns the types of the terms in t's type set, as
// typeparams.NormalTerms gives them, avoiding Go calls for plain types.
function termTypes(t: types.Type): types.Type[] {
  const u = types.unalias(t);
  const base = u?.$type === "Named" ? u.underlying() : u;
  if (base?.$type !== "TypeParam" && base?.$type !== "Union" && base?.$type !== "Interface") {
    return [t];
  }
  return normalTerms(t)?.map((term) => term.type()!) ?? [];
}

// underlyingTerm returns an underlying type of the given kind among the
// terms of t's type set, or null.
function underlyingTerm<K extends types.Type["$type"]>(t: types.Type, kind: K): Extract<types.Type, { $type: K }> | null {
  for (const term of termTypes(t)) {
    const u = term.underlying();
    if (u?.$type === kind) {
      return u as Extract<types.Type, { $type: K }>;
    }
  }
  return null;
}
