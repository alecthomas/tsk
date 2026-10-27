// Port of golang.org/x/tools/go/analysis/passes/atomicalign at v0.50.0.
import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { imports, isFunctionNamed } from "./internal/typesinternal";

const funcNames = [
  "AddInt64",
  "AddUint64",
  "LoadInt64",
  "LoadUint64",
  "StoreInt64",
  "StoreUint64",
  "SwapInt64",
  "SwapUint64",
  "CompareAndSwapInt64",
  "CompareAndSwapUint64",
];

export default defineAnalyzer({
  name: "atomicalign",
  doc: "check for non-64-bits-aligned arguments to sync/atomic functions",
  group: "govet",
  enabledByDefault: false,
  requires: [inspect],
  run(pass) {
    const sizes = pass.typesSizes;
    // Only 32-bit platforms need 64-bit atomics aligned by hand.
    if (sizes === null || 8 * sizes.sizeof(types.Typ[types.Uintptr]!) === 64) {
      return;
    }
    if (!imports(pass.pkg, "sync/atomic")) {
      return;
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      const obj = typeutil.callee(pass.typesInfo, call);
      if (isFunctionNamed(obj, "sync/atomic", ...funcNames)) {
        check64BitAlignment(pass, sizes, obj!.name(), call.args[0]!);
      }
    }
  },
});

// check64BitAlignment reports &x.f arguments whose field is not 64-bit
// aligned. Variables themselves can be relied on to be aligned.
function check64BitAlignment(pass: Pass<unknown>, sizes: types.Sizes, funcName: string, arg: ast.Expr): void {
  if (arg.$type !== "UnaryExpr" || arg.op !== token.AND) {
    return;
  }
  const sel = arg.x;
  if (sel?.$type !== "SelectorExpr") {
    return;
  }
  const tvar = pass.typesInfo.selections.get(sel)?.obj();
  if (tvar?.$type !== "Var" || !tvar.isField()) {
    return;
  }
  const stype = pass.typesInfo.types.get(sel.x!)?.type?.underlying();
  if (stype?.$type !== "Struct") {
    return;
  }
  let offset = 0;
  const fields: types.Var[] = [];
  for (let i = 0; i < stype.numFields(); i++) {
    const f = stype.field(i)!;
    fields.push(f);
    if (f === tvar) {
      offset = sizes.offsetsof(fields)[i];
      break;
    }
  }
  if (offset % 8 === 0) {
    return;
  }
  pass.report({ pos: arg.pos(), end: arg.end(), message: `address of non 64-bit aligned field .${tvar.name()} passed to atomic.${funcName}` });
}
