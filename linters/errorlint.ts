import * as ast from "go/ast";
import * as constant from "go/constant";
import * as token from "go/token";
import * as types from "go/types";
import type * as inspector from "golang.org/x/tools/go/ast/inspector";
import { type Diagnostic, defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface AllowPair {
  /** The error, as `io.EOF`. */
  err: string;
  /** The function returning it, as `(*bufio.Reader).Read` or `io.ReadFull`. */
  fun: string;
}

interface Config {
  /** Check that fmt.Errorf formats errors with %w. */
  errorf: boolean;
  /** Permit more than one %w verb in a format string, as Go 1.20 does. */
  errorfMulti: boolean;
  /** Check type assertions and type switches on errors. */
  asserts: boolean;
  /** Check comparisons and value switches on errors. */
  comparison: boolean;
  /** Errors that functions return unwrapped, so comparing them directly is fine. */
  allowedErrors: AllowPair[];
  /** As allowedErrors, matching errors and functions by prefix. */
  allowedErrorsWildcard: AllowPair[];
}

// defaultAllowedErrors are standard library functions documented to return
// these errors unwrapped.
const defaultAllowedErrors: [string, string][] = [
  ["io.EOF", "(*archive/tar.Reader).Next"],
  ["io.EOF", "(*archive/tar.Reader).Read"],
  ["io.EOF", "(*bufio.Reader).Discard"],
  ["io.EOF", "(*bufio.Reader).Peek"],
  ["io.EOF", "(*bufio.Reader).Read"],
  ["io.EOF", "(*bufio.Reader).ReadByte"],
  ["io.EOF", "(*bufio.Reader).ReadBytes"],
  ["io.EOF", "(*bufio.Reader).ReadLine"],
  ["io.EOF", "(*bufio.Reader).ReadSlice"],
  ["io.EOF", "(*bufio.Reader).ReadString"],
  ["io.EOF", "(*bufio.Scanner).Scan"],
  ["io.EOF", "(*bytes.Buffer).Read"],
  ["io.EOF", "(*bytes.Buffer).ReadByte"],
  ["io.EOF", "(*bytes.Buffer).ReadBytes"],
  ["io.EOF", "(*bytes.Buffer).ReadRune"],
  ["io.EOF", "(*bytes.Buffer).ReadString"],
  ["io.EOF", "(*bytes.Reader).Read"],
  ["io.EOF", "(*bytes.Reader).ReadAt"],
  ["io.EOF", "(*bytes.Reader).ReadByte"],
  ["io.EOF", "(*bytes.Reader).ReadRune"],
  ["io.EOF", "(*bytes.Reader).ReadString"],
  ["database/sql.ErrNoRows", "(*database/sql.Row).Scan"],
  ["io.EOF", "debug/elf.Open"],
  ["io.EOF", "debug/elf.NewFile"],
  ["io.EOF", "(io.ReadCloser).Read"],
  ["io.EOF", "(io.Reader).Read"],
  ["io.EOF", "(io.ReaderAt).ReadAt"],
  ["io.EOF", "(*io.LimitedReader).Read"],
  ["io.EOF", "(*io.SectionReader).Read"],
  ["io.EOF", "(*io.SectionReader).ReadAt"],
  ["io.ErrClosedPipe", "(*io.PipeWriter).Write"],
  ["io.EOF", "io.ReadAtLeast"],
  ["io.ErrShortBuffer", "io.ReadAtLeast"],
  ["io.ErrUnexpectedEOF", "io.ReadAtLeast"],
  ["io.EOF", "io.ReadFull"],
  ["io.ErrUnexpectedEOF", "io.ReadFull"],
  ["mime.ErrInvalidMediaParameter", "mime.ParseMediaType"],
  ["net/http.ErrServerClosed", "(*net/http.Server).ListenAndServe"],
  ["net/http.ErrServerClosed", "(*net/http.Server).ListenAndServeTLS"],
  ["net/http.ErrServerClosed", "(*net/http.Server).Serve"],
  ["net/http.ErrServerClosed", "(*net/http.Server).ServeTLS"],
  ["net/http.ErrServerClosed", "net/http.ListenAndServe"],
  ["net/http.ErrServerClosed", "net/http.ListenAndServeTLS"],
  ["net/http.ErrServerClosed", "net/http.Serve"],
  ["net/http.ErrServerClosed", "net/http.ServeTLS"],
  ["io.EOF", "(*os.File).Read"],
  ["io.EOF", "(*os.File).ReadAt"],
  ["io.EOF", "(*os.File).ReadDir"],
  ["io.EOF", "(*os.File).Readdir"],
  ["io.EOF", "(*os.File).Readdirnames"],
  ["io.EOF", "(*strings.Reader).Read"],
  ["io.EOF", "(*strings.Reader).ReadAt"],
  ["io.EOF", "(*strings.Reader).ReadByte"],
  ["io.EOF", "(*strings.Reader).ReadRune"],
  ["context.DeadlineExceeded", "(context.Context).Err"],
  ["context.Canceled", "(context.Context).Err"],
  ["io.EOF", "(*encoding/json.Decoder).Decode"],
  ["io.EOF", "(*encoding/json.Decoder).Token"],
  ["io.EOF", "(*encoding/csv.Reader).Read"],
  ["io.EOF", "(*mime/multipart.Reader).NextPart"],
  ["io.EOF", "(*mime/multipart.Reader).NextRawPart"],
  ["mime/multipart.ErrMessageTooLarge", "(*mime/multipart.Reader).ReadForm"],
];

const defaultAllowedWildcards: [string, string][] = [
  ["syscall.E", "syscall."],
  ["golang.org/x/sys/unix.E", "golang.org/x/sys/unix."],
];

const wrapMessage = "non-wrapping format verb for fmt.Errorf. Use `%w` to format errors";

export default defineAnalyzer<Config>({
  name: "errorlint",
  doc: `find code that will fail on errors wrapped as Go 1.13 introduced

Reports fmt.Errorf calls that format errors without %w, comparisons and value
switches on errors instead of errors.Is, and type assertions and type switches
on errors instead of errors.As. Errors that standard library functions return
unwrapped, such as io.EOF from io.Reader.Read, may be compared directly.`,
  url: "https://codeberg.org/polyfloyd/go-errorlint",
  requires: [inspect],
  config: { errorf: true, errorfMulti: true, asserts: true, comparison: true, allowedErrors: [], allowedErrorsWildcard: [] },
  run(pass) {
    const linter = new Linter(pass);
    const diagnostics: Diagnostic[] = [];
    if (pass.config.comparison) {
      diagnostics.push(...linter.comparisons());
    }
    if (pass.config.asserts) {
      diagnostics.push(...linter.typeAssertions());
    }
    if (pass.config.errorf) {
      diagnostics.push(...linter.errorfCalls());
    }
    diagnostics.sort((a, b) => a.pos - b.pos);
    for (const diagnostic of diagnostics) {
      pass.report(diagnostic);
    }
  },
});

class Linter {
  private readonly root: inspector.Cursor;
  private readonly allowed = new Map<string, Set<string>>();
  private readonly wildcards: [string, string][];
  private identifiers: Map<types.Object, ast.Ident[]> | undefined;

  constructor(private readonly pass: Pass<Config>) {
    this.root = pass.resultOf(inspect).root();
    const pairs = [...defaultAllowedErrors, ...pass.config.allowedErrors.map((p): [string, string] => [p.err, p.fun])];
    for (const [err, fun] of pairs) {
      this.allowed.set(err, (this.allowed.get(err) ?? new Set()).add(fun));
    }
    this.wildcards = [...defaultAllowedWildcards, ...pass.config.allowedErrorsWildcard.map((p): [string, string] => [p.err, p.fun])];
  }

  errorfCalls(): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const info = this.pass.typesInfo;
    for (const cursor of this.root.preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      if (info.types.get(call)?.type?.string() !== "error" || !this.isFmtErrorf(call)) {
        continue;
      }
      const verbs = this.formatVerbs(call);
      if (verbs === null) {
        continue;
      }
      const args = call.args.slice(1);
      const diagnostic = this.pass.config.errorfMulti ? this.checkVerbs(call, args, verbs) : checkSingleWrap(info, args, verbs);
      if (diagnostic !== null) {
        diagnostics.push(diagnostic);
      }
    }
    return diagnostics;
  }

  // checkVerbs reports the first error argument formatted without %w, with
  // one fix changing every such verb. Upstream offers a fix per verb, which
  // golangci-lint applies together; drivers that apply one fix need one.
  private checkVerbs(call: ast.CallExpr, args: (ast.Expr | null)[], verbs: Verb[]): Diagnostic | null {
    let pos: token.Pos | null = null;
    const edits: { pos: token.Pos; end: token.Pos; newText: string }[] = [];
    let argIndex = 0;
    for (const verb of verbs) {
      argIndex = verb.index !== -1 ? verb.index : argIndex + 1;
      if (verb.format === "w" || verb.format === "T" || argIndex < 1 || argIndex - 1 >= args.length) {
        continue;
      }
      const arg = args[argIndex - 1]!;
      if (!implementsError(this.pass.typesInfo.types.get(arg)?.type ?? null)) {
        continue;
      }
      if (pos === null) {
        pos = arg.pos();
      }
      // The offset counts from the unquoted string, so escapes shift it.
      const at = call.args[0]!.pos() + verb.formatOffset + 1;
      edits.push({ pos: at, end: at + 1, newText: "w" });
    }
    return pos === null ? null : { pos, message: wrapMessage, suggestedFixes: [{ message: "Use `%w` to format errors", textEdits: edits }] };
  }

  private formatVerbs(call: ast.CallExpr): Verb[] | null {
    const format = call.args[0];
    if (call.args.length <= 1 || format?.$type !== "BasicLit") {
      return null;
    }
    const value = this.pass.typesInfo.types.get(format)?.value ?? null;
    return value === null ? null : parseVerbs(constant.stringVal(value));
  }

  private isFmtErrorf(call: ast.CallExpr): boolean {
    if (call.fun?.$type !== "SelectorExpr") {
      return false;
    }
    const object = this.pass.typesInfo.uses.get(call.fun.sel!);
    return object?.pkg()?.name() === "fmt" && object.name() === "Errorf";
  }

  comparisons(): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    for (const cursor of this.root.preorder(ast.BinaryExpr, ast.SwitchStmt)) {
      const node = cursor.node()!;
      if (node.$type === "BinaryExpr") {
        const diagnostic = this.checkComparison(cursor, node);
        if (diagnostic !== null) {
          diagnostics.push(diagnostic);
        }
      } else if (node.$type === "SwitchStmt") {
        const diagnostic = this.checkSwitch(cursor, node);
        if (diagnostic !== null) {
          diagnostics.push(diagnostic);
        }
      }
    }
    return diagnostics;
  }

  private checkComparison(cursor: inspector.Cursor, expr: ast.BinaryExpr): Diagnostic | null {
    const [x, y] = [expr.x!, expr.y!];
    if ((expr.op !== token.EQL && expr.op !== token.NEQ) || isNil(x) || isNil(y)) {
      return null;
    }
    const xError = this.isErrorType(x);
    const yError = this.isErrorType(y);
    if ((!xError && !yError) || this.isAllowedComparison(x, y) || this.inErrorIsMethod(cursor)) {
      return null;
    }
    const [errVar, target] = yError && !xError ? [y, x] : [x, y];
    const replacement = `${expr.op === token.NEQ ? "!" : ""}errors.Is(${exprToString(errVar)}, ${exprToString(target)})`;
    return {
      pos: expr.pos(),
      message: `comparing with ${token.Token.string(expr.op)} will fail on wrapped errors. Use errors.Is to check for a specific error`,
      suggestedFixes: [{ message: "Use errors.Is() to compare errors", textEdits: [{ pos: expr.pos(), end: expr.end(), newText: replacement }] }],
    };
  }

  // checkSwitch reports a value switch on an error. Upstream also suggests a
  // rewrite by building and printing a new switch, which this port omits.
  private checkSwitch(cursor: inspector.Cursor, stmt: ast.SwitchStmt): Diagnostic | null {
    if (stmt.tag === null || !this.isErrorType(stmt.tag)) {
      return null;
    }
    let problem: ast.CaseClause | null = null;
    outer: for (const clause of stmt.body!.list) {
      for (const expr of (clause as ast.CaseClause).list) {
        if (!isNil(expr!) && !this.isAllowedComparison(stmt.tag, expr!)) {
          problem = clause as ast.CaseClause;
          break outer;
        }
      }
    }
    if (problem === null || this.inErrorIsMethod(cursor) || !switchComparesNonNil(stmt)) {
      return null;
    }
    return { pos: problem.pos(), message: "switch on an error will fail on wrapped errors. Use errors.Is to check for specific errors" };
  }

  typeAssertions(): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    for (const cursor of this.root.preorder(ast.TypeAssertExpr, ast.TypeSwitchStmt)) {
      const node = cursor.node()!;
      if (node.$type === "TypeAssertExpr") {
        const diagnostic = this.checkTypeAssertion(cursor, node);
        if (diagnostic !== null) {
          diagnostics.push(diagnostic);
        }
      } else if (node.$type === "TypeSwitchStmt") {
        const assign = node.assign;
        const assertion = assign?.$type === "ExprStmt" ? assign.x : assign?.$type === "AssignStmt" ? assign.rhs[0] : null;
        // Upstream also suggests a rewrite by building and printing new
        // syntax, renaming identifiers in place, which this port omits.
        if (assertion?.$type === "TypeAssertExpr" && this.isErrorType(assertion.x!) && !this.inErrorIsMethod(cursor)) {
          diagnostics.push({
            pos: assertion.pos(),
            message: "type switch on error will fail on wrapped errors. Use errors.As to check for specific errors",
          });
        }
      }
    }
    return diagnostics;
  }

  private checkTypeAssertion(cursor: inspector.Cursor, assertion: ast.TypeAssertExpr): Diagnostic | null {
    // A type switch's x.(type) has no type, and is checked with its switch.
    if (assertion.type === null || !this.isErrorType(assertion.x!) || this.inErrorIsMethod(cursor)) {
      return null;
    }
    if (!implementsError(this.pass.typesInfo.types.get(assertion.type)?.type ?? null)) {
      return null;
    }
    const targetType = exprToString(assertion.type);
    const errExpr = exprToString(assertion.x!);
    const isPointer = targetType.startsWith("*");
    const baseType = isPointer ? targetType.slice(1) : targetType;
    const declare = (name: string) => (isPointer ? `${name} := &${baseType}{}` : `var ${name} ${baseType}`);
    const fix = (pos: token.Pos, end: token.Pos, newText: string): Diagnostic => ({
      pos: assertion.pos(),
      message: "type assertion on error will fail on wrapped errors. Use errors.As to check for specific errors",
      suggestedFixes: [{ message: "Use errors.As() for type assertions on errors", textEdits: [{ pos, end, newText }] }],
    });
    const parent = cursor.parent();
    const parentNode = parent.node();
    if (parentNode?.$type === "AssignStmt" && parentNode.lhs.length === 2 && parentNode.lhs[0]?.$type === "Ident") {
      const name = errorVarName(parentNode.lhs[0].name, baseType);
      const grandparent = parent.parent().node();
      if (grandparent?.$type === "IfStmt" && grandparent.init === parentNode) {
        return fix(grandparent.pos(), grandparent.body!.pos(), `${declare(name)}\nif errors.As(${errExpr}, &${name})`);
      }
      const ok = parentNode.lhs[1];
      const okName = ok?.$type === "Ident" && ok.name !== "_" ? ok.name : "ok";
      return fix(parentNode.pos(), parentNode.end(), `${declare(name)}\n${okName} := errors.As(${errExpr}, &${name})`);
    }
    const name = errorVarName("target", baseType);
    if (parentNode?.$type === "IfStmt") {
      return fix(assertion.pos(), assertion.end(), `${declare(name)}\nif errors.As(${errExpr}, &${name})`);
    }
    const replacement = `func() ${targetType} {\n\t${declare(name)}\n\t_ = errors.As(${errExpr}, &${name})\n\treturn ${name}\n}()`;
    return fix(assertion.pos(), assertion.end(), replacement);
  }

  private isErrorType(expr: ast.Expr): boolean {
    return this.pass.typesInfo.types.get(expr)?.type?.string() === "error";
  }

  // inErrorIsMethod reports whether a node is inside a method Is(error) bool,
  // where comparing errors directly is the point.
  private inErrorIsMethod(cursor: inspector.Cursor): boolean {
    const found = cursor.enclosing(ast.FuncDecl).toArray()[0];
    const fn = found?.node() as ast.FuncDecl | undefined;
    if (fn === undefined || fn.name!.name !== "Is" || fn.recv === null) {
      return false;
    }
    const typeOf = (field: ast.Field | null) => this.pass.typesInfo.types.get(field!.type!)?.type?.string();
    const params = fn.type!.params!.list;
    const results = fn.type!.results?.list ?? [];
    return params.length === 1 && typeOf(params[0]) === "error" && results.length === 1 && typeOf(results[0]) === "bool";
  }

  // isAllowedComparison reports whether a comparison is of an error with the
  // calls producing it, all of which the allow lists say return it unwrapped.
  private isAllowedComparison(a: ast.Expr, b: ast.Expr): boolean {
    let errName = "";
    let calls: ast.CallExpr[] = [];
    for (const expr of [a, b]) {
      if (expr.$type === "SelectorExpr") {
        errName = this.selectorToString(expr);
      } else if (expr.$type === "Ident") {
        calls = this.assigningCalls(expr, new Set());
      } else if (expr.$type === "CallExpr") {
        calls.push(expr);
      }
    }
    if (errName === "" || calls.length === 0) {
      return false;
    }
    const names: string[] = [];
    for (const call of calls) {
      if (call.fun?.$type !== "SelectorExpr") {
        return false;
      }
      const selection = this.pass.typesInfo.selections.get(call.fun);
      names.push(selection != null ? `(${selection.recv()!.string()}).${selection.obj()!.name()}` : this.selectorToString(call.fun));
    }
    return names.every((name) => this.isAllowed(errName, name));
  }

  private isAllowed(err: string, fun: string): boolean {
    return this.allowed.get(err)?.has(fun) === true || this.wildcards.some(([e, f]) => fun.startsWith(f) && err.startsWith(e));
  }

  // assigningCalls finds the calls assigned to the variable an identifier
  // refers to, following assignments from other variables.
  private assigningCalls(subject: ast.Ident, visited: Set<types.Object>): ast.CallExpr[] {
    const object = this.pass.typesInfo.objectOf(subject);
    if (subject.obj === null || object === null || visited.has(object)) {
      return [];
    }
    visited.add(object);
    const calls: ast.CallExpr[] = [];
    for (const ident of this.identifiersFor(object)) {
      if (ident.pos() === subject.pos()) {
        continue;
      }
      const assign = this.root.findNode(ident)?.parent().node();
      if (assign?.$type !== "AssignStmt") {
        continue;
      }
      let value = assign.rhs[0];
      if (assign.lhs.length === assign.rhs.length) {
        const i = assign.lhs.findIndex((lhs) => lhs?.$type === "Ident" && lhs.name === subject.name);
        if (i !== -1) {
          value = assign.rhs[i];
        }
      }
      if (value?.$type === "CallExpr") {
        calls.push(value);
      } else if (value?.$type === "Ident" && value.obj !== subject.obj) {
        calls.push(...this.assigningCalls(value, visited));
      }
    }
    return calls;
  }

  // identifiersFor lists the identifiers defining or using an object.
  private identifiersFor(object: types.Object): ast.Ident[] {
    if (this.identifiers === undefined) {
      this.identifiers = new Map();
      for (const map of [this.pass.typesInfo.defs, this.pass.typesInfo.uses]) {
        for (const [ident, obj] of map.entries()) {
          if (obj !== null) {
            this.identifiers.set(obj, [...(this.identifiers.get(obj) ?? []), ident]);
          }
        }
      }
    }
    return this.identifiers.get(object) ?? [];
  }

  private selectorToString(sel: ast.SelectorExpr): string {
    const object = this.pass.typesInfo.uses.get(sel.sel!);
    return object == null ? "" : `${object.pkg()?.path()}.${object.name()}`;
  }
}

// checkSingleWrap reports an error formatted without %w, or a second %w,
// when only one %w is allowed. It mirrors upstream, which stops at the first
// error argument either way.
function checkSingleWrap(info: types.Info, args: (ast.Expr | null)[], verbs: Verb[]): Diagnostic | null {
  let wraps = 0;
  for (let i = 0; i < args.length && i < verbs.length; i++) {
    const arg = args[i]!;
    if (!implementsError(info.types.get(arg)?.type ?? null)) {
      continue;
    }
    if (verbs[i].format === "w") {
      wraps++;
      if (wraps > 1) {
        return { pos: arg.pos(), message: "only one %w verb is permitted per format string" };
      }
    }
    if (wraps === 0) {
      return { pos: arg.pos(), message: wrapMessage };
    }
  }
  return null;
}

interface Verb {
  format: string;
  formatOffset: number;
  index: number;
}

// parseVerbs lists a format string's verbs, with explicit argument indexes
// such as %[2]v, or null if it is malformed. It follows upstream's parser.
function parseVerbs(format: string): Verb[] | null {
  const verbs: Verb[] = [];
  let at = 0;
  for (;;) {
    const percent = format.indexOf("%", at);
    if (percent === -1) {
      return verbs;
    }
    at = percent + 1;
    let index = -1;
    let verb: string | undefined;
    for (;;) {
      const c = format[at];
      if (c === "%") {
        at++;
        verb = undefined;
        break;
      }
      if (c === "+" || c === "#") {
        at++;
        continue;
      }
      if (c === "[") {
        const end = format.indexOf("]", at);
        if (end === -1) {
          return null;
        }
        // Upstream parses the text before "]" from the remaining string,
        // after the "[" is consumed, as the index.
        const text = format.slice(at + 1, end);
        if (!/^[+-]?\d+$/.test(text)) {
          return null;
        }
        index = Number(text);
        at = end + 1;
      } else if (c !== undefined && /[0-9.]/.test(c)) {
        while (at < format.length && /[0-9.]/.test(format[at])) {
          at++;
        }
      } else if (c === undefined) {
        return verbs;
      }
      verb = format[at] ?? "";
      at++;
      break;
    }
    if (verb !== undefined) {
      verbs.push({ format: verb, formatOffset: utf8Length(format.slice(0, at - 1)), index });
    }
  }
}

// utf8Length counts a string's UTF-8 bytes, which positions count.
function utf8Length(text: string): number {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return length;
}

function implementsError(t: types.Type | null): boolean {
  if (t === null) {
    return false;
  }
  const methods = types.newMethodSet(t)!;
  for (let i = 0; i < methods.len(); i++) {
    const selection = methods.at(i)!;
    const object = selection.obj()!;
    if (selection.kind() === types.MethodVal && object.name() === "Error" && object.type()?.string() === "func() string") {
      return true;
    }
  }
  return false;
}

function isNil(expr: ast.Expr): boolean {
  return expr.$type === "Ident" && expr.name === "nil";
}

// switchComparesNonNil reports whether a switch has a case other than nil.
function switchComparesNonNil(stmt: ast.SwitchStmt): boolean {
  return stmt.body!.list.some((clause) => clause?.$type === "CaseClause" && clause.list.some((expr) => !isNil(expr!)));
}

// exprToString renders the expressions upstream's fixes handle.
function exprToString(expr: ast.Expr | null): string {
  switch (expr?.$type) {
    case "Ident":
      return expr.name;
    case "SelectorExpr":
      return `${exprToString(expr.x)}.${expr.sel!.name}`;
    case "StarExpr":
      return `*${exprToString(expr.x)}`;
    case "UnaryExpr":
      return token.Token.string(expr.op) + exprToString(expr.x);
    case "BinaryExpr":
      return `${exprToString(expr.x)} ${token.Token.string(expr.op)} ${exprToString(expr.y)}`;
    case "CallExpr":
      return `${exprToString(expr.fun)}(${expr.args.map(exprToString).join(", ")})`;
    case "ParenExpr":
      return `(${exprToString(expr.x)})`;
    case "IndexExpr":
      return `${exprToString(expr.x)}[${exprToString(expr.index)}]`;
    case "BasicLit":
      return expr.value;
    case "TypeAssertExpr":
      return `${exprToString(expr.x)}.(${exprToString(expr.type)})`;
  }
  return "/* complex expression */";
}

// errorVarName names the variable errors.As fills, from the type when the
// original name is _, as myError for pkg.MyError.
function errorVarName(original: string, typeName: string): string {
  if (original !== "_") {
    return original;
  }
  const name = typeName.slice(typeName.lastIndexOf(".") + 1);
  return name === "" ? "anErr" : name[0].toLowerCase() + name.slice(1);
}
