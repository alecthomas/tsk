import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";

interface Config {
  /** Also report conversions of floating-point values, which may round. */
  fastMath: boolean;
  /** Only report conversions whose context keeps the same type without them. */
  safe: boolean;
}

// Step is a node on the path to the current node, with the number of its
// children visited so far.
interface Step {
  node: ast.Node;
  i: number;
}

export default defineAnalyzer<Config>({
  name: "unconvert",
  doc: "Remove unnecessary type conversions",
  url: "https://github.com/mdempsky/unconvert",
  config: { fastMath: false, safe: false },
  run(pass) {
    for (const file of pass.files) {
      const filename = pass.fset.position(file!.package).filename;
      // Skips cgo's generated files.
      if (filename.endsWith("-d") || filename.endsWith("/_cgo_gotypes.go")) {
        continue;
      }
      const path: Step[] = [];
      ast.inspect(file, (node) => {
        if (node === null) {
          path.pop();
          if (path.length > 0) {
            path[path.length - 1].i++;
          }
          return true;
        }
        path.push({ node, i: 0 });
        if (node.$type === "CallExpr" && isUnnecessary(pass, node, path)) {
          pass.report({ pos: node.lparen, message: "unnecessary conversion" });
        }
        return true;
      });
    }
  },
});

function isUnnecessary(pass: Pass<Config>, call: ast.CallExpr, path: Step[]): boolean {
  if (call.args.length !== 1 || call.ellipsis !== token.NoPos) {
    return false;
  }
  const info = pass.typesInfo;
  const ft = info.types.get(call.fun!);
  const at = info.types.get(call.args[0]!);
  if (!ft?.isType() || !at || !types.identical(ft.type, at.type)) {
    return false;
  }
  if (!pass.config.fastMath && isFloatingPoint(ft.type)) {
    return false;
  }
  if (isUntypedValue(pass, call.args[0]!)) {
    return false;
  }
  return !pass.config.safe || isSafeContext(pass, at.type, path);
}

function isFloatingPoint(t: types.Type | null): boolean {
  const u = t?.underlying();
  return u?.$type === "Basic" && (u.info() & (types.IsFloat | types.IsComplex)) !== 0;
}

// isSafeContext reports whether the conversion's parent expects its type
// anyway, so removing the conversion keeps the result's type.
function isSafeContext(pass: Pass<Config>, t: types.Type | null, path: Step[]): boolean {
  const info = pass.typesInfo;
  const ctxt = path[path.length - 2];
  const typeOf = (e: ast.Expr | null) => (e === null ? undefined : info.types.get(e)?.type);
  const n = ctxt.node;
  switch (n.$type) {
    case "AssignStmt": {
      const pos = ctxt.i - n.lhs.length;
      if (pos < 0) {
        return false;
      }
      if (n.tok === token.DEFINE) {
        return true;
      }
      const lt = typeOf(n.lhs[pos]);
      return lt !== undefined && types.identical(t, lt);
    }
    case "BinaryExpr": {
      if (n.op === token.SHL || n.op === token.SHR) {
        return true;
      }
      const ot = typeOf(ctxt.i === 0 ? n.y : n.x);
      return ot !== undefined && types.identical(t, ot);
    }
    case "CallExpr": {
      const pos = ctxt.i - 1;
      if (pos < 0) {
        return true;
      }
      const sig = typeOf(n.fun);
      if (sig === undefined) {
        return false;
      }
      if (sig?.$type !== "Signature") {
        return true;
      }
      const params = sig.params()!;
      let pt: types.Type | null;
      if (sig.variadic() && n.ellipsis === token.NoPos && pos >= params.len() - 1) {
        const last = params.at(params.len() - 1)!.type();
        pt = last?.$type === "Slice" ? last.elem() : null;
      } else {
        pt = params.at(pos)!.type();
      }
      return types.identical(t, pt);
    }
    case "ReturnStmt": {
      const fn = [...path].reverse().find((step) => step.node.$type === "FuncDecl" || step.node.$type === "FuncLit")?.node as
        | ast.FuncDecl
        | ast.FuncLit
        | undefined;
      let typeExpr: ast.Expr | null = null;
      let i = ctxt.i;
      for (const field of fn?.type?.results?.list ?? []) {
        const count = Math.max(field!.names.length, 1);
        if (i >= count) {
          i -= count;
          continue;
        }
        typeExpr = field!.type;
        break;
      }
      const pt = typeOf(typeExpr);
      return pt !== undefined && types.identical(t, pt);
    }
    default:
      // Composite literals, unary and star expressions, switches, and
      // anything else are assumed safe, as upstream does.
      return true;
  }
}

// isUntypedValue reports whether an expression is an untyped constant or
// nil, whose conversion gives it a type.
function isUntypedValue(pass: Pass<Config>, n: ast.Expr): boolean {
  switch (n.$type) {
    case "BinaryExpr":
      switch (n.op) {
        case token.SHL:
        case token.SHR:
          return isUntypedValue(pass, n.x!);
        case token.EQL:
        case token.NEQ:
        case token.LSS:
        case token.GTR:
        case token.LEQ:
        case token.GEQ:
          return true;
        case token.ADD:
        case token.SUB:
        case token.MUL:
        case token.QUO:
        case token.REM:
        case token.AND:
        case token.OR:
        case token.XOR:
        case token.AND_NOT:
        case token.LAND:
        case token.LOR:
          return isUntypedValue(pass, n.x!) && isUntypedValue(pass, n.y!);
        default:
          return false;
      }
    case "UnaryExpr":
      return [token.ADD, token.SUB, token.NOT, token.XOR].includes(n.op) && isUntypedValue(pass, n.x!);
    case "BasicLit":
      return true;
    case "ParenExpr":
      return isUntypedValue(pass, n.x!);
    case "SelectorExpr":
      return isUntypedValue(pass, n.sel!);
    case "Ident": {
      const object = pass.typesInfo.uses.get(n);
      if (!object) {
        return false;
      }
      if (object.pkg() === null && object.name() === "nil") {
        return true;
      }
      const t = object.type();
      return t?.$type === "Basic" && (t.info() & types.IsUntyped) !== 0;
    }
    case "CallExpr": {
      let fun = n.fun;
      while (fun?.$type === "ParenExpr") {
        fun = fun.x;
      }
      const builtin = fun?.$type === "Ident" ? pass.typesInfo.uses.get(fun) : undefined;
      if (builtin?.$type !== "Builtin") {
        return false;
      }
      if (builtin.name() === "real" || builtin.name() === "imag") {
        return isUntypedValue(pass, n.args[0]!);
      }
      return builtin.name() === "complex" && isUntypedValue(pass, n.args[0]!) && isUntypedValue(pass, n.args[1]!);
    }
    default:
      return false;
  }
}
