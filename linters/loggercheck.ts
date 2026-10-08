import * as ast from "go/ast";
import * as constant from "go/constant";
import * as token from "go/token";
import * as types from "go/types";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Check github.com/go-kit/log calls. */
  kitlog: boolean;
  /** Check k8s.io/klog/v2 calls. */
  klog: boolean;
  /** Check github.com/go-logr/logr calls. */
  logr: boolean;
  /** Check log/slog calls. */
  slog: boolean;
  /** Check go.uber.org/zap calls. */
  zap: boolean;
  /** Require keys to be constant strings of ASCII characters. */
  requireStringKey: boolean;
  /** Report printf-like format specifiers in logging arguments. */
  noPrintfLike: boolean;
  /** Extra logging functions to check, such as "(*example.com/log.Logger).Infow". */
  rules: string[];
}

type Logger = "kitlog" | "klog" | "logr" | "slog" | "zap";

// Ruleset lists one package's logging functions. A null logger marks custom
// rules, which no setting disables.
interface Ruleset {
  logger: Logger | null;
  pkg: string;
  funcs: FuncRule[];
}

// FuncRule matches a function by name and, for methods, by receiver such as
// "*Logger" or "Logger[T]".
interface FuncRule {
  name: string;
  receiver: string | null;
}

const staticRules: [Logger, string[]][] = [
  ["logr", ["(github.com/go-logr/logr.Logger).Error", "(github.com/go-logr/logr.Logger).Info", "(github.com/go-logr/logr.Logger).WithValues"]],
  [
    "klog",
    [
      "k8s.io/klog/v2.InfoS",
      "k8s.io/klog/v2.InfoSDepth",
      "k8s.io/klog/v2.ErrorS",
      "(k8s.io/klog/v2.Verbose).InfoS",
      "(k8s.io/klog/v2.Verbose).InfoSDepth",
      "(k8s.io/klog/v2.Verbose).ErrorS",
    ],
  ],
  ["zap", ["With", "Debugw", "Infow", "Warnw", "Errorw", "DPanicw", "Panicw", "Fatalw"].map((name) => `(*go.uber.org/zap.SugaredLogger).${name}`)],
  ["kitlog", ["github.com/go-kit/log.With", "github.com/go-kit/log.WithPrefix", "github.com/go-kit/log.WithSuffix", "(github.com/go-kit/log.Logger).Log"]],
  [
    "slog",
    [
      "log/slog.Group",
      ...["With", "Debug", "Info", "Warn", "Error", "DebugContext", "InfoContext", "WarnContext", "ErrorContext"].flatMap((name) => [
        `log/slog.${name}`,
        `(*log/slog.Logger).${name}`,
      ]),
    ],
  ],
];

// structuredTypes names the strongly typed attribute that a logger accepts in
// place of a key-value pair, such as slog.Attr.
const structuredTypes: Partial<Record<Logger, string>> = { slog: "Attr", zap: "Field" };

export default defineAnalyzer<Config>({
  name: "loggercheck",
  doc: "Checks key value pairs for common logger libraries (kitlog,klog,logr,slog,zap).",
  url: "https://github.com/timonwong/loggercheck",
  requires: [inspect],
  config: {
    kitlog: true,
    klog: true,
    logr: true,
    slog: true,
    zap: true,
    requireStringKey: false,
    noPrintfLike: false,
    rules: [],
  },
  run(pass) {
    const checker = new Checker(pass);
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      checker.check(cursor.node() as ast.CallExpr);
    }
  },
});

class Checker {
  private readonly rulesets: Ruleset[];
  private readonly stringer: types.Interface;

  constructor(private readonly pass: Pass<Config>) {
    const parsed = staticRules.map(([logger, lines]) => ({ ...parseRules(lines)[0], logger }));
    this.rulesets = [...parsed, ...parseRules(pass.config.rules)].filter((rs) => rs.logger === null || pass.config[rs.logger]);
    const result = types.newVar(token.NoPos, null, "", types.Typ[types.String]);
    const sig = types.newSignatureType(null, [], [], types.newTuple(), types.newTuple(result), false);
    this.stringer = types.newInterfaceType([types.newFunc(token.NoPos, null, "String", sig)], [])!.complete()!;
  }

  check(call: ast.CallExpr): void {
    if (!this.pass.typesInfo.types.get(call.fun!)?.type || call.ellipsis !== token.NoPos) {
      return;
    }
    const fn = typeutil.callee(this.pass.typesInfo, call);
    if (fn?.$type !== "Func") {
      return;
    }
    const sig = fn.type();
    if (sig?.$type !== "Signature" || !sig.variadic()) {
      return;
    }
    const ruleset = this.rulesetFor(fn, sig);
    if (ruleset === null) {
      return;
    }
    const params = sig.params()!;
    const start = params.len() - 1;
    if (call.args.length < start) {
      // A multi-valued argument has no expression per value.
      return;
    }
    const variadic = params.at(start)!.type();
    const elem = types.unalias(variadic?.$type === "Slice" ? variadic.elem() : null);
    if (elem?.$type !== "Interface" || !elem.empty()) {
      return;
    }
    const structured = ruleset.logger === null ? undefined : structuredTypes[ruleset.logger];
    const keyValues = call.args.slice(start).filter((arg) => structured === undefined || !this.isNamed(arg!, structured)) as ast.Expr[];
    if (keyValues.length % 2 !== 0) {
      this.pass.report({
        pos: keyValues[0].pos(),
        end: keyValues[keyValues.length - 1].end(),
        message: "odd number of arguments passed as key-value pairs for logging",
      });
    }
    if (this.pass.config.requireStringKey) {
      this.checkKeys(keyValues);
    }
    this.checkStringerValues(keyValues);
    if (this.pass.config.noPrintfLike) {
      this.checkPrintfLike(call.args as ast.Expr[]);
    }
  }

  // rulesetFor returns the first enabled ruleset listing a function.
  private rulesetFor(fn: types.Func, sig: types.Signature): Ruleset | null {
    const pkg = fn.pkg();
    if (pkg === null) {
      return null;
    }
    const path = vendorLessPath(pkg.path());
    const recv = sig.recv();
    const receiver = recv === null ? null : receiverName(recv.type());
    for (const ruleset of this.rulesets) {
      if (ruleset.pkg === path && ruleset.funcs.some((rule) => rule.name === fn.name() && rule.receiver === receiver)) {
        return ruleset;
      }
    }
    return null;
  }

  // isNamed reports whether a call or identifier has a named type called name,
  // such as zap's Field, which stands alone rather than as a key-value pair.
  private isNamed(arg: ast.Expr, name: string): boolean {
    if (arg.$type !== "CallExpr" && arg.$type !== "Ident") {
      return false;
    }
    const t = types.unalias(this.pass.typesInfo.typeOf(arg));
    return t?.$type === "Named" && t.obj()?.name() === name;
  }

  private checkKeys(keyValues: ast.Expr[]): void {
    for (let i = 0; i < keyValues.length; i += 2) {
      const arg = keyValues[i];
      const value = this.stringConstant(arg);
      if (value === null) {
        this.pass.report({
          pos: arg.pos(),
          end: arg.end(),
          message: `logging keys are expected to be inlined constant strings, please replace ${goQuote(ellipsis(formatNode(arg, this.pass.fset)))} provided with string`,
        });
      } else if (Array.from(value).some((c) => c.codePointAt(0)! >= 0x80)) {
        this.pass.report({
          pos: arg.pos(),
          end: arg.end(),
          message: `logging keys are expected to be alphanumeric strings, please remove any non-latin characters from ${goQuote(value)}`,
        });
      }
    }
  }

  // checkStringerValues reports pointer values whose element type implements
  // fmt.Stringer, since formatting a nil one calls String on nil and panics.
  private checkStringerValues(keyValues: ast.Expr[]): void {
    for (let i = 1; i < keyValues.length; i += 2) {
      const arg = keyValues[i];
      const t = types.unalias(this.pass.typesInfo.typeOf(arg));
      if (t?.$type !== "Pointer") {
        continue;
      }
      if (!types.implements_(types.unalias(t.elem()), this.stringer) || !types.implements_(t, this.stringer)) {
        continue;
      }
      this.pass.report({
        pos: arg.pos(),
        end: arg.end(),
        message: "logging value may panic when nil because its element type implements fmt.Stringer",
      });
    }
  }

  private checkPrintfLike(args: ast.Expr[]): void {
    for (const arg of args) {
      const value = this.stringConstant(arg);
      const specifier = value === null ? null : printfSpecifier(value);
      if (specifier !== null) {
        this.pass.report({ pos: arg.pos(), end: arg.end(), message: `logging message should not use format specifier ${goQuote(specifier)}` });
        return;
      }
    }
  }

  private stringConstant(arg: ast.Expr): string | null {
    const tv = this.pass.typesInfo.types.get(arg);
    const t = tv?.type;
    if (t?.$type !== "Basic" || t.kind() !== types.String || !tv?.value) {
      return null;
    }
    return constant.stringVal(tv.value);
  }
}

// parseRules parses rules such as "pkg.Func" and "(*pkg.Type).Method",
// grouping them by package.
function parseRules(lines: readonly string[]): Ruleset[] {
  const byPkg = new Map<string, FuncRule[]>();
  lines.forEach((line, i) => {
    if (line === "" || line.startsWith("#")) {
      return;
    }
    const [pkg, rule] = parseRule(line, i + 1);
    byPkg.set(pkg, [...(byPkg.get(pkg) ?? []), rule]);
  });
  return [...byPkg].map(([pkg, funcs]) => ({ logger: null, pkg, funcs }));
}

function parseRule(line: string, lineNumber: number): [string, FuncRule] {
  const invalid = new Error(`error parse rule at line ${lineNumber}: invalid rule format`);
  const dot = lastSeparator(line);
  if (dot === -1 || line[dot] === "/") {
    throw invalid;
  }
  const prefix = line.slice(0, dot);
  const name = line.slice(dot + 1);
  if (!line.startsWith("(")) {
    return [prefix, { name, receiver: null }];
  }
  if (!prefix.endsWith(")")) {
    throw invalid;
  }
  let receiver = prefix.slice(1, -1);
  const pointer = receiver.startsWith("*");
  if (pointer) {
    receiver = receiver.slice(1);
  }
  const typeDot = lastSeparator(receiver);
  if (typeDot === -1 || receiver[typeDot] === "/") {
    throw invalid;
  }
  return [receiver.slice(0, typeDot), { name, receiver: (pointer ? "*" : "") + receiver.slice(typeDot + 1) }];
}

function lastSeparator(s: string): number {
  return Math.max(s.lastIndexOf("."), s.lastIndexOf("/"));
}

// vendorLessPath strips a vendor directory prefix from an import path.
function vendorLessPath(path: string): string {
  const i = path.lastIndexOf("/vendor/");
  return i >= 0 ? path.slice(i + "/vendor/".length) : path;
}

// receiverName renders a receiver as rules write it, such as "*Logger" or
// "Logger[T]", or "" for an unsupported type.
function receiverName(t: types.Type | null): string {
  let prefix = "";
  let named: types.Type | null = t;
  if (t?.$type === "Pointer") {
    prefix = "*";
    named = t.elem();
  }
  if (named?.$type !== "Named") {
    return "";
  }
  const params = named.typeParams();
  const names = [...Array(params?.len() ?? 0).keys()].map((i) => params!.at(i)!.obj()!.name());
  return prefix + named.obj()!.name() + (names.length > 0 ? `[${names.join(",")}]` : "");
}

// ellipsis truncates text to 20 characters, as go/constant does.
function ellipsis(s: string): string {
  const chars = Array.from(s);
  return chars.length > 20 ? `${chars.slice(0, 17).join("")}...` : s;
}

// goQuote quotes a string like Go's %q verb for ASCII escapes.
function goQuote(s: string): string {
  const escapes: Record<string, string> = {
    "\x07": "\\a",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
    "\v": "\\v",
    '"': '\\"',
    "\\": "\\\\",
  };
  const quoted = Array.from(s, (c) => {
    const code = c.charCodeAt(0);
    if (escapes[c] !== undefined) {
      return escapes[c];
    }
    return code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : c;
  });
  return `"${quoted.join("")}"`;
}

const printfVerbFlags: Record<string, string> = {
  "%": "",
  b: " -+.0#",
  c: "-",
  d: " -+.0",
  e: " -+.0#",
  E: " -+.0#",
  f: " -+.0#",
  F: " -+.0#",
  g: " -+.0#",
  G: " -+.0#",
  o: " -+.0#",
  O: " -+.0#",
  p: "-#",
  q: " -+.0#",
  s: " -+.0",
  t: "-",
  T: "-",
  U: "-#",
  v: " -+.0#",
  w: " -+.0#",
  x: " -+.0#",
  X: " -+.0#",
};

// printfSpecifier returns the first directive in a string whose directives are
// all valid printf verbs, or null. It follows go vet's printf parser.
function printfSpecifier(format: string): string | null {
  let first: string | null = null;
  for (let i = 0; i < format.length; ) {
    if (format[i] !== "%") {
      i++;
      continue;
    }
    const directive = parsePrintfVerb(format.slice(i));
    if (directive === null || !(directive.verb in printfVerbFlags)) {
      return null;
    }
    if (!directive.flags.split("").every((flag) => printfVerbFlags[directive.verb].includes(flag))) {
      return null;
    }
    first = first ?? directive.format;
    i += directive.format.length;
  }
  return first;
}

// parsePrintfVerb parses the directive at the start of format, such as
// "%3.*[4]d", returning null for a syntax error.
function parsePrintfVerb(format: string): { verb: string; format: string; flags: string } | null {
  let n = 1;
  let flags = "";
  let indexPending = false;
  const scanNum = () => {
    while (n < format.length && format[n] >= "0" && format[n] <= "9") {
      n++;
    }
  };
  const parseIndex = (): boolean => {
    if (n === format.length || format[n] !== "[") {
      return true;
    }
    n++;
    const start = n;
    scanNum();
    const index = Number(format.slice(start, n));
    if (n === format.length || n === start || format[n] !== "]" || index <= 0 || index > 0x7fffffff) {
      return false;
    }
    n++;
    indexPending = true;
    return true;
  };
  const parseNum = () => {
    if (n < format.length && format[n] === "*") {
      indexPending = false;
      n++;
    } else {
      scanNum();
    }
  };
  while (n < format.length && "#0+- ".includes(format[n])) {
    flags += format[n++];
  }
  if (!parseIndex()) {
    return null;
  }
  parseNum();
  if (n < format.length && format[n] === ".") {
    flags += ".";
    n++;
    if (!parseIndex()) {
      return null;
    }
    parseNum();
  }
  if (!indexPending && !parseIndex()) {
    return null;
  }
  if (n === format.length) {
    return null;
  }
  const verb = String.fromCodePoint(format.codePointAt(n)!);
  n += verb.length;
  return { verb, format: format.slice(0, n), flags };
}
