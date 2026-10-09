import * as ast from "go/ast";
import * as constant from "go/constant";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, formatNode, type Pass, type SuggestedFix, type TextEdit } from "tsk";
import { inspect } from "tsk/passes";
import { quote } from "./internal/strconv";

interface Config {
  /** Optimize integer formatting. */
  integerFormat: boolean;
  /** Optimize integer formatting even if it needs a cast to int or uint64. */
  intConversion: boolean;
  /** Optimize error formatting. */
  errorFormat: boolean;
  /** Optimize into err.Error(), which only matches fmt for non-nil errors. */
  errError: boolean;
  /** Optimize fmt.Errorf. */
  errorf: boolean;
  /** Optimize string formatting. */
  stringFormat: boolean;
  /** Optimize fmt.Sprintf with only one argument. */
  sprintf1: boolean;
  /** Optimize into string concatenation. */
  strconcat: boolean;
  /** Optimize bool formatting. */
  boolFormat: boolean;
  /** Optimize hexadecimal formatting. */
  hexFormat: boolean;
  /** Report string concatenation in loops. */
  concatLoop: boolean;
  /** Report concatenation in loops that also use the string in other ways. */
  loopOtherOps: boolean;
}

export default defineAnalyzer<Config>({
  name: "perfsprint",
  doc: "Checks that fmt.Sprintf can be replaced with a faster alternative.",
  requires: [inspect],
  config: {
    integerFormat: true,
    intConversion: true,
    errorFormat: true,
    errError: false,
    errorf: true,
    stringFormat: true,
    sprintf1: true,
    strconcat: true,
    boolFormat: true,
    hexFormat: true,
    concatLoop: true,
    loopOtherOps: false,
  },
  run(pass) {
    const root = pass.resultOf(inspect).root();
    if (pass.config.concatLoop) {
      for (const cursor of root.preorder(ast.RangeStmt, ast.ForStmt)) {
        checkConcatLoop(pass, cursor.node() as ast.RangeStmt | ast.ForStmt);
      }
    }
    const fmt = pass.pkg
      .imports()
      .find((pkg) => pkg!.path() === "fmt")
      ?.scope();
    if (fmt === undefined || fmt === null) {
      return;
    }
    const checker = new SprintChecker(pass, fmt);
    for (const cursor of root.preorder(ast.CallExpr)) {
      checker.check(cursor.node() as ast.CallExpr);
    }
  },
});

// Diagnostic is a finding, named by the setting that enables it.
interface Diagnostic {
  checker: string;
  message: string;
  fix: string;
  edits: TextEdit[];
}

class SprintChecker {
  private readonly sprint: types.Object | null;
  private readonly sprintf: types.Object | null;
  private readonly errorf: types.Object | null;
  private readonly errorType = types.Universe!.lookup("error")!.type()!.underlying() as types.Interface;
  // Sub-options only apply while their parent option is on.
  private readonly intConversion: boolean;
  private readonly errError: boolean;
  private readonly errorfEnabled: boolean;
  private readonly sprintf1: boolean;
  private readonly strconcat: boolean;

  constructor(
    private readonly pass: Pass<Config>,
    fmt: types.Scope,
  ) {
    this.sprint = fmt.lookup("Sprint");
    this.sprintf = fmt.lookup("Sprintf");
    this.errorf = fmt.lookup("Errorf");
    const c = pass.config;
    this.intConversion = c.integerFormat && c.intConversion;
    this.errError = c.errorFormat && c.errError;
    this.errorfEnabled = c.errorFormat && c.errorf;
    this.sprintf1 = c.stringFormat && c.sprintf1;
    this.strconcat = c.stringFormat && c.strconcat;
  }

  check(call: ast.CallExpr): void {
    if (call.fun?.$type !== "SelectorExpr") {
      return;
    }
    const called = this.pass.typesInfo.objectOf(call.fun.sel!);
    const parsed = this.parse(call, called);
    if (parsed === null) {
      return;
    }
    const { fn, value } = parsed;
    const verb = parsed.verb;
    const concatable = fn === "fmt.Sprintf" && isConcatable(verb) && this.strconcat;
    if (!["%d", "%v", "%x", "%t", "%s"].includes(verb) && !concatable) {
      return;
    }
    const d = this.diagnose(call, fn, verb, value);
    if (d !== null) {
      this.pass.report({
        pos: call.pos(),
        end: call.end(),
        message: `${d.checker}: ${fn} ${d.message}`,
        suggestedFixes: [{ message: d.fix, textEdits: d.edits }],
      });
    }
  }

  // parse returns the function, verb, and formatted value of a call this
  // linter handles.
  private parse(call: ast.CallExpr, called: types.Object | null): { fn: string; verb: string; value: ast.Expr } | null {
    if (called === null) {
      return null;
    }
    const args = call.args as ast.Expr[];
    if (called === this.errorf && args.length === 1 && this.errorfEnabled) {
      return { fn: "fmt.Errorf", verb: "%s", value: args[0] };
    }
    if (called === this.sprint && args.length === 1) {
      return { fn: "fmt.Sprint", verb: "%v", value: args[0] };
    }
    if (called === this.sprintf && args.length === 1 && this.sprintf1) {
      return { fn: "fmt.Sprintf", verb: "%s", value: args[0] };
    }
    if (called === this.sprintf && args.length === 2) {
      const format = args[0];
      const tv = this.pass.typesInfo.types.get(format);
      if (format.$type !== "BasicLit" || format.kind !== token.STRING || !tv?.value) {
        return null;
      }
      let verb = constant.stringVal(tv.value);
      // A single explicit argument index is the same as none.
      if (verb.startsWith("%[1]")) {
        verb = `%${verb.slice(4)}`;
      }
      return { fn: "fmt.Sprintf", verb, value: args[1] };
    }
    return null;
  }

  private diagnose(call: ast.CallExpr, fn: string, verb: string, value: ast.Expr): Diagnostic | null {
    const c = this.pass.config;
    const t = this.pass.typesInfo.typeOf(value);
    const is = (...kinds: types.BasicKind[]) => kinds.some((kind) => types.identical(t, types.Typ[kind]));
    const verbIs = (...verbs: string[]) => verbs.includes(verb);
    const elem = t?.$type === "Array" || t?.$type === "Slice" ? t.elem() : null;
    const isBytes = elem !== null && types.identical(elem, types.Typ[types.Uint8]);
    // wrap replaces the call up to the value with before, and appends after.
    const wrap = (before: string, after = ""): TextEdit[] => [
      { pos: call.pos(), end: value.pos(), newText: before },
      ...(after === "" ? [] : [{ pos: value.end(), end: value.end(), newText: after }]),
    ];
    const replace = (text: string): TextEdit[] => [{ pos: call.pos(), end: call.end(), newText: text }];
    const source = () => formatNode(value, this.pass.fset);

    if (is(types.String) && verbIs("%v", "%s")) {
      if (fn === "fmt.Errorf") {
        return c.errorFormat ? diagnostic("error-format", "can be replaced with errors.New", "Use errors.New", wrap("errors.New(")) : null;
      }
      return c.stringFormat ? diagnostic("string-format", "can be replaced with just using the string", "Just use string value", replace(source())) : null;
    }
    if (types.implements_(t, this.errorType) && verbIs("%v", "%s") && this.errError) {
      const errorCall = `${source()}.Error()`;
      return diagnostic("error-format", `can be replaced with ${errorCall}`, `Use ${errorCall}`, replace(errorCall));
    }
    if (is(types.Bool) && verbIs("%v", "%t") && c.boolFormat) {
      return diagnostic("bool-format", "can be replaced with faster strconv.FormatBool", "Use strconv.FormatBool", wrap("strconv.FormatBool("));
    }
    if (t?.$type === "Array" && isBytes && verbIs("%x") && c.hexFormat) {
      // Array literals cannot be sliced.
      if (value.$type !== "Ident") {
        return null;
      }
      return diagnostic("hex-format", "can be replaced with faster hex.EncodeToString", "Use hex.EncodeToString", wrap("hex.EncodeToString(", "[:]"));
    }
    if (t?.$type === "Slice" && isBytes && verbIs("%x") && c.hexFormat) {
      return diagnostic("hex-format", "can be replaced with faster hex.EncodeToString", "Use hex.EncodeToString", wrap("hex.EncodeToString("));
    }
    if (is(types.Int8, types.Int16, types.Int32) && verbIs("%v", "%d") && this.intConversion) {
      return diagnostic("integer-format", "can be replaced with faster strconv.Itoa", "Use strconv.Itoa", wrap("strconv.Itoa(int(", ")"));
    }
    if (is(types.Int) && verbIs("%v", "%d") && c.integerFormat) {
      return diagnostic("integer-format", "can be replaced with faster strconv.Itoa", "Use strconv.Itoa", wrap("strconv.Itoa("));
    }
    if (is(types.Int64) && verbIs("%v", "%d") && c.integerFormat) {
      return diagnostic("integer-format", "can be replaced with faster strconv.FormatInt", "Use strconv.FormatInt", wrap("strconv.FormatInt(", ", 10"));
    }
    const base = verb === "%x" ? "16" : "10";
    if (is(types.Uint8, types.Uint16, types.Uint32, types.Uint) && verbIs("%v", "%d", "%x") && this.intConversion) {
      return diagnostic(
        "integer-format",
        "can be replaced with faster strconv.FormatUint",
        "Use strconv.FormatUint",
        wrap("strconv.FormatUint(uint64(", `), ${base}`),
      );
    }
    if (is(types.Uint64) && verbIs("%v", "%d", "%x") && c.integerFormat) {
      return diagnostic("integer-format", "can be replaced with faster strconv.FormatUint", "Use strconv.FormatUint", wrap("strconv.FormatUint(", `, ${base}`));
    }
    if (is(types.String) && fn === "fmt.Sprintf" && isConcatable(verb) && c.stringFormat) {
      const literal = (s: string) => quote(s).replace(/%%/g, "%");
      let fix: string;
      if (verb.endsWith("%s")) {
        fix = `${literal(verb.slice(0, -2))}+${source()}`;
      } else if (verb.endsWith("%[1]s")) {
        fix = `${literal(verb.slice(0, -5))}+${source()}`;
      } else if (verb.startsWith("%s")) {
        fix = `${source()}+${literal(verb.slice(2))}`;
      } else {
        fix = `${source()}+${literal(verb.slice(5))}`;
      }
      return diagnostic("string-format", "can be replaced with string concatenation", "Use string concatenation", replace(fix));
    }
    return null;
  }
}

function diagnostic(checker: string, message: string, fix: string, edits: TextEdit[]): Diagnostic {
  return { checker, message, fix, edits };
}

// isConcatable reports whether a format is "%s" with a constant prefix or
// suffix, but not both.
function isConcatable(verb: string): boolean {
  const indexed = "%[1]s";
  const hasPrefix = (verb.startsWith("%s") && !verb.includes(indexed)) || (verb.startsWith(indexed) && !verb.includes("%s"));
  const hasSuffix = (verb.endsWith("%s") && !verb.includes(indexed)) || (verb.endsWith(indexed) && !verb.includes("%s"));
  if (verb.split(indexed).length - 1 > 1) {
    return false;
  }
  return hasPrefix !== hasSuffix;
}

// checkConcatLoop reports string variables declared outside a loop and
// concatenated inside it, suggesting a strings.Builder instead.
function checkConcatLoop(pass: Pass<Config>, loop: ast.RangeStmt | ast.ForStmt): void {
  const declared = new Set<string>();
  const adds = new Map<string, ast.AssignStmt[]>();
  // Statements are explored breadth first, into if and else blocks.
  const stmts = [...loop.body!.list] as ast.Stmt[];
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    if (stmt.$type === "IfStmt") {
      stmts.push(...((stmt.body?.list ?? []) as ast.Stmt[]));
      if (stmt.else?.$type === "BlockStmt") {
        stmts.push(...(stmt.else.list as ast.Stmt[]));
      }
    } else if (stmt.$type === "DeclStmt") {
      const decl = stmt.decl;
      if (decl?.$type === "GenDecl" && decl.specs.length === 1 && decl.specs[0]?.$type === "ValueSpec") {
        for (const name of decl.specs[0].names) {
          declared.add(name!.name);
        }
      }
    } else if (stmt.$type === "AssignStmt") {
      recordConcat(pass, stmt, declared, adds);
    }
  }
  if (adds.size > 0) {
    reportConcatLoop(pass, loop, adds);
  }
}

function recordConcat(pass: Pass<Config>, stmt: ast.AssignStmt, declared: Set<string>, adds: Map<string, ast.AssignStmt[]>): void {
  for (let n = 0; n < stmt.lhs.length; n++) {
    const id = stmt.lhs[n];
    if (id?.$type !== "Ident") {
      return;
    }
    if (stmt.tok === token.DEFINE) {
      declared.add(id.name);
      continue;
    }
    // Multiple assignments are not checked.
    if ((stmt.tok !== token.ASSIGN && stmt.tok !== token.ADD_ASSIGN) || n > 0 || declared.has(id.name)) {
      continue;
    }
    if (pass.typesInfo.types.get(id)?.type?.string() !== "string") {
      continue;
    }
    if (stmt.tok === token.ASSIGN && concatenated(stmt, id.name) === null) {
      continue;
    }
    adds.set(id.name, [...(adds.get(id.name) ?? []), stmt]);
  }
}

// concatenated returns x in "name = name + x", or null.
function concatenated(stmt: ast.AssignStmt, name: string): ast.Expr | null {
  const rhs = stmt.rhs.length === 1 ? stmt.rhs[0] : null;
  if (rhs?.$type === "BinaryExpr" && rhs.op === token.ADD && rhs.x?.$type === "Ident" && rhs.x.name === name) {
    return rhs.y;
  }
  return null;
}

function reportConcatLoop(pass: Pass<Config>, loop: ast.RangeStmt | ast.ForStmt, adds: Map<string, ast.AssignStmt[]>): void {
  const keys = [...adds.keys()].sort();
  const line = pass.fset.position(loop.pos()).line;
  const other = otherUse(loop, adds);
  if (other !== null && !pass.config.loopOtherOps) {
    return;
  }
  let prefix = other === null ? "" : `// FIXME check usages of string identifier ${other} (and mayber others) in loop\n`;
  let suffix = "";
  for (const k of keys) {
    prefix += `var ${k}Sb${line} strings.Builder\n`;
    suffix += `\n${k} += ${k}Sb${line}.String()`;
  }
  const edits: TextEdit[] = [{ pos: loop.pos(), end: loop.pos(), newText: prefix }];
  for (const k of keys) {
    for (const stmt of adds.get(k)!) {
      const added = stmt.tok === token.ASSIGN ? concatenated(stmt, k)! : stmt.rhs[0]!;
      edits.push({ pos: stmt.pos(), end: added.pos(), newText: `${k}Sb${line}.WriteString(` });
      edits.push({ pos: added.end(), end: added.end(), newText: ")" });
    }
  }
  edits.push({ pos: loop.end(), end: loop.end(), newText: suffix });
  const first = adds.get(keys[0])![0];
  const fix: SuggestedFix = { message: "Use a strings.Builder", textEdits: edits };
  pass.report({ pos: first.pos(), end: first.end(), message: "concat-loop: string concatenation in a loop", suggestedFixes: [fix] });
}

// otherUse returns a concatenated variable the loop uses other than by
// concatenating to it, or null.
function otherUse(loop: ast.Node, adds: Map<string, ast.AssignStmt[]>): string | null {
  let found: string | null = null;
  ast.inspect(loop, (node) => {
    if (found !== null) {
      return false;
    }
    if (node?.$type === "AssignStmt" && (node.tok === token.ASSIGN || node.tok === token.ADD_ASSIGN) && node.lhs.length === 1) {
      const id = node.lhs[0];
      if (id?.$type === "Ident" && adds.has(id.name)) {
        if (node.tok === token.ASSIGN && concatenated(node, id.name) === null) {
          found = id.name;
        }
        return false;
      }
    }
    if (node?.$type === "Ident" && adds.has(node.name)) {
      found = node.name;
      return false;
    }
    return true;
  });
  return found;
}
