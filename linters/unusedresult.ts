// Port of golang.org/x/tools/go/analysis/passes/unusedresult at v0.50.0.
import * as ast from "go/ast";
import * as types from "go/types";
import type * as inspector from "golang.org/x/tools/go/ast/inspector";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import { isMethodNamed } from "./internal/typesinternal";

interface Config {
  /** Functions whose results must be used, as `package/path.Name`. Given values replace the default list. */
  funcs: string[];
  /** Names of methods of type func() string whose results must be used. */
  stringmethods: string[];
}

// The context.With* entries are effectively redundant with lostcancel.
const defaultFuncs = [
  "context.WithCancel",
  "context.WithDeadline",
  "context.WithTimeout",
  "context.WithValue",
  "errors.New",
  "fmt.Append",
  "fmt.Appendf",
  "fmt.Appendln",
  "fmt.Errorf",
  "fmt.Sprint",
  "fmt.Sprintf",
  "fmt.Sprintln",
  "maps.All",
  "maps.Clone",
  "maps.Collect",
  "maps.Equal",
  "maps.EqualFunc",
  "maps.Keys",
  "maps.Values",
  "slices.All",
  "slices.AppendSeq",
  "slices.Backward",
  "slices.BinarySearch",
  "slices.BinarySearchFunc",
  "slices.Chunk",
  "slices.Clip",
  "slices.Clone",
  "slices.Collect",
  "slices.Compact",
  "slices.CompactFunc",
  "slices.Compare",
  "slices.CompareFunc",
  "slices.Concat",
  "slices.Contains",
  "slices.ContainsFunc",
  "slices.Delete",
  "slices.DeleteFunc",
  "slices.Equal",
  "slices.EqualFunc",
  "slices.Grow",
  "slices.Index",
  "slices.IndexFunc",
  "slices.Insert",
  "slices.IsSorted",
  "slices.IsSortedFunc",
  "slices.Max",
  "slices.MaxFunc",
  "slices.Min",
  "slices.MinFunc",
  "slices.Repeat",
  "slices.Replace",
  "slices.Sorted",
  "slices.SortedFunc",
  "slices.SortedStableFunc",
  "slices.Values",
  "sort.Reverse",
];

export default defineAnalyzer<Config>({
  name: "unusedresult",
  doc: `check for unused results of calls to some functions

Some functions like fmt.Errorf return a result and have no side
effects, so it is always a mistake to discard the result. Other
functions may return an error that must not be ignored, or a cleanup
operation that must be called. This analyzer reports calls to
functions like these when the result of the call is ignored.

The set of functions may be controlled using options.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/unusedresult",
  requires: [inspect],
  config: { funcs: defaultFuncs, stringmethods: ["Error", "String"] },
  run(pass) {
    // Keys are the package path and name, joined by a space.
    const pkgFuncs = new Set<string>();
    for (const s of pass.config.funcs) {
      const i = s.lastIndexOf(".");
      if (i > 0) {
        pkgFuncs.add(`${s.slice(0, i)} ${s.slice(i + 1)}`);
      }
    }
    const stringMethods = new Set(pass.config.stringmethods);
    for (const cur of pass.resultOf(inspect).root().preorder(ast.ExprStmt)) {
      const call = ast.unparen((cur.node() as ast.ExprStmt).x);
      if (call?.$type !== "CallExpr" || inBenchmarkLoop(pass.typesInfo, cur)) {
        continue;
      }
      const fn = typeutil.callee(pass.typesInfo, call);
      if (fn?.$type !== "Func") {
        continue;
      }
      const sig = fn.signature()!;
      const recv = sig.recv();
      if (recv !== null) {
        if (isNoArgsStringResult(sig) && stringMethods.has(fn.name())) {
          pass.report({ pos: call.pos(), end: call.lparen, message: `result of (${recv.type()!.string()}).${fn.name()} call not used` });
        }
      } else if (pkgFuncs.has(`${fn.pkg()!.path()} ${fn.name()}`)) {
        pass.report({ pos: call.pos(), end: call.lparen, message: `result of ${fn.pkg()!.path()}.${fn.name()} call not used` });
      }
    }
  },
});

// isNoArgsStringResult reports whether sig is identical to func() string.
function isNoArgsStringResult(sig: types.Signature): boolean {
  const params = sig.params();
  const results = sig.results();
  return (
    (sig.typeParams()?.len() ?? 0) === 0 &&
    !sig.variadic() &&
    (params?.len() ?? 0) === 0 &&
    results?.len() === 1 &&
    types.identical(results.at(0)!.type(), types.Typ[types.String])
  );
}

// inBenchmarkLoop reports whether cur, an ExprStmt, is in the body of a
// "for b.Loop() {…}" loop, which keeps the results of calls alive by design.
function inBenchmarkLoop(info: types.Info, cur: inspector.Cursor): boolean {
  if (cur.parent().node()?.$type !== "BlockStmt") {
    return false;
  }
  const loop = cur.parent().parent().node();
  if (loop?.$type !== "ForStmt") {
    return false;
  }
  const cond = ast.unparen(loop.cond);
  return cond?.$type === "CallExpr" && isMethodNamed(typeutil.callee(info, cond), "testing", "B", "Loop");
}
