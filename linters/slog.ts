// Port of golang.org/x/tools/go/analysis/passes/slog at v0.50.0.
import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, formatNode } from "tsk";
import { inspect } from "tsk/passes";
import { quote } from "./internal/strconv";
import { isTypeNamed, receiverNamed } from "./internal/typesinternal";

// What is expected to appear in an argument position.
const key = 0;
const value = 1;
const unknown = 2;

// The functions and methods in log/slog that take ...any for key-value pairs,
// by receiver type name ("" for a function), mapped to the arguments to skip.
const kvFuncs = new Map<string, Map<string, number>>([
  [
    "",
    new Map([
      ["Debug", 1],
      ["Info", 1],
      ["Warn", 1],
      ["Error", 1],
      ["DebugContext", 2],
      ["InfoContext", 2],
      ["WarnContext", 2],
      ["ErrorContext", 2],
      ["Log", 3],
      ["Group", 1],
    ]),
  ],
  [
    "Logger",
    new Map([
      ["Debug", 1],
      ["Info", 1],
      ["Warn", 1],
      ["Error", 1],
      ["DebugContext", 2],
      ["InfoContext", 2],
      ["WarnContext", 2],
      ["ErrorContext", 2],
      ["Log", 3],
      ["With", 0],
    ]),
  ],
  ["Record", new Map([["Add", 0]])],
]);

export default defineAnalyzer({
  name: "slog",
  doc: `check for invalid structured logging calls

The slog checker looks for calls to functions from the log/slog
package that take alternating key-value pairs. It reports calls
where an argument in a key position is neither a string nor a
slog.Attr, and where a final key is missing its value.
For example,it would report

	slog.Warn("message", 11, "k") // slog.Warn arg "11" should be a string or a slog.Attr

and

	slog.Info("message", "k1", v1, "k2") // call to slog.Info missing a final value`,
  group: "govet",
  requires: [inspect],
  run(pass) {
    const stringType = types.Universe!.lookup("string")!.type();
    const format = (e: ast.Node) => quote(formatNode(e, pass.fset));
    let attrType: types.Type | null = null;
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      const fn = typeutil.staticCallee(pass.typesInfo, call);
      if (fn === null || call.ellipsis !== token.NoPos) {
        continue;
      }
      let skipArgs = kvFuncSkipArgs(fn);
      if (skipArgs === undefined) {
        continue;
      }
      attrType ??= fn.pkg()!.scope()!.lookup("Attr")!.type();
      if (isMethodExpr(pass.typesInfo, call)) {
        skipArgs++;
      }
      if (call.args.length <= skipArgs) {
        continue;
      }
      // The first position should hold a key or Attr.
      let pos = key;
      let unknownArg: ast.Expr | null = null;
      let reported = false;
      for (const arg of call.args.slice(skipArgs)) {
        const t = pass.typesInfo.types.get(arg!)?.type ?? null;
        if (pos === key) {
          if (t === stringType) {
            pos = value;
            continue;
          }
          if (isAttr(t)) {
            continue;
          }
          if (t !== null && types.isInterface(t)) {
            // Without dataflow the dynamic type is unknown. An empty
            // interface may hold a string or an Attr.
            if (types.assignableTo(stringType, t)) {
              pos = unknown;
              continue;
            }
            if (types.assignableTo(attrType, t)) {
              continue;
            }
          }
          const message =
            unknownArg === null
              ? `${shortName(fn)} arg ${format(arg!)} should be a string or a slog.Attr (possible missing key or value)`
              : `${shortName(fn)} arg ${format(arg!)} should probably be a string or a slog.Attr (previous arg ${format(unknownArg)} cannot be a key)`;
          pass.report({ pos: arg!.pos(), end: arg!.end(), message });
          // Report at most one missing key per call.
          reported = true;
          break;
        }
        if (pos === value) {
          pos = key;
          continue;
        }
        // After an unknown position, a later problem may be a missing final
        // value or a non-key in key position.
        unknownArg = arg;
        if (t !== stringType && !isAttr(t) && !(t !== null && types.isInterface(t))) {
          // unknownArg was not a key, so this is its value.
          pos = key;
        }
      }
      if (!reported && pos === value) {
        const message = unknownArg === null ? `call to ${shortName(fn)} missing a final value` : `call to ${shortName(fn)} has a missing or misplaced value`;
        pass.report({ pos: call.pos(), end: call.end(), message });
      }
    }
  },
});

function isAttr(t: types.Type | null): boolean {
  return isTypeNamed(t, "log/slog", "Attr");
}

// shortName returns a name such as "slog.Info" or "slog.Logger.With".
function shortName(fn: types.Func): string {
  let r = "";
  const recv = fn.signature()!.recv();
  if (recv !== null) {
    const { named } = receiverNamed(recv);
    r = `${named !== null ? named.obj()!.name() : recv.type()!.string()}.`;
  }
  return `${fn.pkg()!.name()}.${r}${fn.name()}`;
}

// kvFuncSkipArgs returns the number of arguments before the key-value pairs
// if fn is a log/slog function taking them, and undefined otherwise.
function kvFuncSkipArgs(fn: types.Func): number | undefined {
  if (fn.pkg()?.path() !== "log/slog") {
    return undefined;
  }
  let recvName = "";
  const recv = fn.signature()!.recv();
  if (recv !== null) {
    const { named } = receiverNamed(recv);
    if (named === null) {
      return undefined;
    }
    recvName = named.obj()!.name();
  }
  return kvFuncs.get(recvName)?.get(fn.name());
}

function isMethodExpr(info: types.Info, call: ast.CallExpr): boolean {
  const s = call.fun;
  if (s?.$type !== "SelectorExpr") {
    return false;
  }
  const sel = info.selections.get(s);
  return sel !== undefined && sel !== null && sel.kind() === types.MethodExpr;
}
