import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";
import { unquote } from "./internal/strconv";
import { byteLength } from "./internal/utf8";
import { callExpr, type Expr, exprEqual, format, inspect, intExpr, isSyn, shape } from "./prealloc/expr";
import { addIntExpr, divIntExpr, incIntExpr, intValue, mulIntExpr, subIntExpr } from "./prealloc/math";

interface Config {
  /** Report only slices whose loops have no returns, breaks or continues. */
  simple: boolean;
  /** Report slices appended to in range loops. */
  rangeLoops: boolean;
  /** Report slices appended to in for loops. */
  forLoops: boolean;
}

interface SliceDecl {
  name: string;
  pos: token.Pos;
  // Nesting level; an append at another level disqualifies the slice.
  level: number;
  lenExpr: Expr;
  exclude: boolean;
  // A return was found after the first append.
  hasReturn: boolean;
  // The slice is being assigned the result of an append.
  assigning: boolean;
  // The slice was appended to without reassignment.
  detached: boolean;
}

interface SliceAppend {
  index: number;
  countExpr: Expr | null;
}

export default defineAnalyzer<Config>({
  name: "prealloc",
  doc: "Find slice declarations that could potentially be pre-allocated",
  config: { simple: true, rangeLoops: true, forLoops: false },
  run(pass) {
    const v = new Visitor(pass);
    for (const file of pass.files) {
      v.walk(file);
    }
  },
});

const newDecl = (name: string, pos: token.Pos, level: number, lenExpr: Expr): SliceDecl => ({
  name,
  pos,
  level,
  lenExpr,
  exclude: false,
  hasReturn: false,
  assigning: false,
  detached: false,
});

class Visitor {
  private decls: SliceDecl[] = [];
  private appends: (SliceAppend | null)[] = [];
  private loopVars: ast.Expr[] = [];
  // Loops do not increment the level.
  private level = 0;
  private hasReturn = false;
  private hasGoto = false;
  private hasBranch = false;

  constructor(private readonly pass: Pass<Config>) {}

  walk(node: ast.Node | null): void {
    if (node !== null) {
      ast.inspect(node, (n) => n === null || this.visit(n));
    }
  }

  // visit handles a node and reports whether to walk its children.
  private visit(node: ast.Node): boolean {
    const c = this.pass.config;
    switch (node.$type) {
      case "FuncDecl":
        if (node.body !== null) {
          this.level = 0;
          this.hasReturn = false;
          this.hasGoto = false;
          this.walk(node.body);
        }
        return false;
      case "FuncLit": {
        const [wasReturn, wasGoto] = [this.hasReturn, this.hasGoto];
        this.hasReturn = false;
        this.walk(node.body);
        [this.hasReturn, this.hasGoto] = [wasReturn, wasGoto];
        return false;
      }
      case "BlockStmt":
        this.block(node);
        return false;
      case "ValueSpec":
        this.valueSpec(node);
        return true;
      case "AssignStmt":
        return this.assign(node);
      case "CallExpr":
        this.call(node);
        return true;
      case "RangeStmt":
      case "ForStmt":
        if (this.decls.length === 0) {
          return true;
        }
        this.loop(node);
        return false;
      case "SwitchStmt":
      case "TypeSwitchStmt":
      case "SelectStmt": {
        const hadBranch = this.hasBranch;
        this.hasBranch = false;
        this.walk(node.body);
        this.hasBranch = hadBranch;
        return false;
      }
      case "ReturnStmt":
        if (!c.simple) {
          return false;
        }
        this.hasReturn = true;
        // Flag every slice appended to at least once.
        for (const a of this.appends) {
          if (a !== null) {
            this.decls[a.index].hasReturn = true;
          }
        }
        return true;
      case "BranchStmt":
        if (!c.simple) {
          return false;
        }
        if (node.label !== null) {
          this.hasGoto = true;
        } else {
          this.hasBranch = true;
        }
        return true;
      default:
        return true;
    }
  }

  private block(block: ast.BlockStmt): void {
    const declIdx = this.decls.length;
    let appendIdx = this.appends.length;
    this.level++;
    for (const stmt of block.list) {
      this.walk(stmt);
    }
    this.level--;
    for (let i = declIdx; i < this.decls.length; i++) {
      const decl = this.decls[i];
      if (decl.exclude || this.hasGoto) {
        continue;
      }
      let capExpr: Expr | null = decl.lenExpr;
      for (let j = appendIdx; j < this.appends.length; j++) {
        const a = this.appends[j];
        if (a !== null && a.index === i) {
          capExpr = addIntExpr(capExpr, a.countExpr);
        }
      }
      // Nothing was appended.
      if (capExpr === decl.lenExpr) {
        continue;
      }
      const capVal = capExpr === null ? null : intValue(capExpr);
      if (capVal !== null && capVal <= 0) {
        continue;
      }
      const capacity = capExpr === null ? null : format(capExpr);
      this.pass.report({ pos: decl.pos, message: `Consider preallocating ${decl.name}${capacity === null ? "" : ` with capacity ${capacity}`}` });
    }
    // Discard slices falling out of scope and their appends.
    this.decls = this.decls.slice(0, declIdx);
    for (let i = appendIdx; i < this.appends.length; i++) {
      const a = this.appends[i];
      if (a !== null) {
        if (a.index >= declIdx) {
          this.appends[i] = null;
        } else {
          appendIdx = i + 1;
        }
      }
    }
    this.appends = this.appends.slice(0, appendIdx);
  }

  private valueSpec(spec: ast.ValueSpec): void {
    const under = spec.type === null ? null : this.pass.typesInfo.typeOf(spec.type)?.underlying();
    const isArrayOrSlice = under?.$type === "Array" || under?.$type === "Slice";
    spec.names.forEach((name, i) => {
      let lenExpr: Expr | null;
      if (i >= spec.values.length) {
        if (!isArrayOrSlice) {
          return;
        }
        lenExpr = intExpr(0);
      } else {
        lenExpr = this.createArray(spec.values[i]!);
        if (lenExpr === null) {
          const value = spec.values[i];
          if (value?.$type !== "Ident" || value.name !== "nil") {
            return;
          }
          lenExpr = intExpr(0);
        }
      }
      this.decls.push(newDecl(name!.name, spec.pos(), this.level, lenExpr));
    });
  }

  private assign(s: ast.AssignStmt): boolean {
    if (this.loopVars.length > 0) {
      if (s.lhs.length === s.rhs.length) {
        s.lhs.forEach((lhs, i) => {
          if (hasAny(s.rhs[i], this.loopVars)) {
            this.loopVars.push(lhs!);
          }
        });
      } else if (s.rhs.length === 1 && hasAny(s.rhs[0], this.loopVars)) {
        this.loopVars.push(...(s.lhs as ast.Expr[]));
      }
    }
    if (s.lhs.length !== s.rhs.length) {
      return false;
    }
    s.lhs.forEach((lhs, i) => {
      if (lhs?.$type !== "Ident") {
        return;
      }
      const rhs = s.rhs[i]!;
      const lenExpr = this.createArray(rhs);
      if (lenExpr !== null) {
        this.decls.push(newDecl(lhs.name, s.pos(), this.level, lenExpr));
        return;
      }
      const decl = this.findDecl(lhs.name);
      if (decl === null) {
        return;
      }
      // Reinitializing a slice to nil starts a new declaration.
      if (rhs.$type === "Ident" && s.tok === token.ASSIGN && rhs.name === "nil") {
        this.decls.push(newDecl(lhs.name, s.pos(), this.level, intExpr(0)));
        return;
      }
      if (rhs.$type === "CallExpr" && rhs.args.length >= 2 && !decl.d.hasReturn && decl.d.level === this.level) {
        const first = rhs.args[0];
        if (rhs.fun?.$type === "Ident" && rhs.fun.name === "append" && first?.$type === "Ident" && first.name === lhs.name) {
          decl.d.assigning = true;
          return;
        }
      }
      decl.d.exclude = true;
    });
    return true;
  }

  private findDecl(name: string): { d: SliceDecl; index: number } | null {
    for (let i = this.decls.length - 1; i >= 0; i--) {
      if (this.decls[i].name === name) {
        return { d: this.decls[i], index: i };
      }
    }
    return null;
  }

  private call(s: ast.CallExpr): void {
    const target = s.args[0];
    if (s.fun?.$type !== "Ident" || s.fun.name !== "append" || s.args.length < 2 || target?.$type !== "Ident") {
      return;
    }
    const found = this.findDecl(target.name);
    if (found === null || found.d.exclude) {
      return;
    }
    const decl = found.d;
    if (decl.hasReturn || decl.level !== this.level || decl.detached) {
      decl.exclude = true;
      return;
    }
    const countExpr = this.appendCount(s);
    // A count that depends on the loop or the slice itself is unknown.
    if (countExpr !== null && (hasAny(countExpr, this.loopVars) || hasVarReference(countExpr, decl.name))) {
      decl.exclude = true;
      return;
    }
    if (decl.assigning) {
      decl.assigning = false;
    } else {
      decl.detached = true;
    }
    this.appends.push({ index: found.index, countExpr });
  }

  private loop(stmt: ast.RangeStmt | ast.ForStmt): void {
    if (stmt.body === null) {
      return;
    }
    const appendIdx = this.appends.length;
    const hadBranch = this.hasBranch;
    this.hasBranch = false;
    this.level--;
    const varsIdx = this.loopVars.length;
    if (stmt.$type === "RangeStmt") {
      for (const v of [stmt.key, stmt.value]) {
        if (v !== null) {
          this.loopVars.push(v);
        }
      }
    } else if (stmt.init?.$type === "AssignStmt") {
      this.loopVars.push(...(stmt.init.lhs as ast.Expr[]));
    }
    this.walk(stmt.body);
    this.level++;
    this.loopVars = this.loopVars.slice(0, varsIdx);

    const included = stmt.$type === "RangeStmt" ? this.pass.config.rangeLoops : this.pass.config.forLoops;
    let exclude = !included || this.hasReturn || this.hasGoto || this.hasBranch;
    let loopCount: Expr | null = null;
    if (!exclude) {
      const counted = stmt.$type === "RangeStmt" ? this.rangeLoopCount(stmt) : this.forLoopCount(stmt);
      loopCount = counted.expr;
      exclude = !counted.ok;
    }
    if (exclude) {
      // Exclude every slice appended to within the loop.
      for (let i = appendIdx; i < this.appends.length; i++) {
        const a = this.appends[i];
        if (a !== null) {
          this.decls[a.index].exclude = true;
        }
      }
    } else {
      this.decls.forEach((decl, i) => {
        if (decl.exclude) {
          return;
        }
        let prev = -1;
        for (let j = this.appends.length - 1; j >= appendIdx; j--) {
          const a = this.appends[j];
          if (a === null || a.index !== i) {
            continue;
          }
          if (prev < 0) {
            if (loopCount === null) {
              // An unknown loop count makes the appends unknown.
              a.countExpr = null;
            } else if (hasVarReference(loopCount, decl.name)) {
              decl.exclude = true;
              break;
            }
          } else {
            // Consolidate appends to the same slice.
            a.countExpr = addIntExpr(a.countExpr, this.appends[prev]!.countExpr);
            this.appends[prev] = null;
          }
          prev = j;
        }
        if (prev >= 0) {
          this.appends[prev]!.countExpr = mulIntExpr(this.appends[prev]!.countExpr, loopCount);
        }
      });
    }
    this.hasBranch = hadBranch;
  }

  // createArray returns the length of a slice or array an expression creates.
  private createArray(expr: ast.Expr): Expr | null {
    if (expr.$type === "CompositeLit") {
      const under = this.pass.typesInfo.typeOf(expr)?.underlying();
      return under?.$type === "Array" || under?.$type === "Slice" ? intExpr(expr.elts.length) : null;
    }
    if (expr.$type !== "CallExpr") {
      return null;
    }
    if (expr.args.length === 1) {
      // []T(nil)
      const arg = expr.args[0];
      if (arg?.$type !== "Ident" || arg.name !== "nil") {
        return null;
      }
      return this.pass.typesInfo.typeOf(expr.fun)?.underlying()?.$type === "Slice" ? intExpr(0) : null;
    }
    if (expr.args.length === 2 && expr.fun?.$type === "Ident" && expr.fun.name === "make") {
      return expr.args[1];
    }
    return null;
  }

  private appendCount(call: ast.CallExpr): Expr | null {
    return call.ellipsis !== token.NoPos ? this.sliceLength(call.args[1]!) : intExpr(call.args.length - 1);
  }

  // stringLength returns the byte length of a string literal.
  private stringLength(expr: ast.Expr): Expr | null {
    if (expr.$type !== "BasicLit" || expr.kind !== token.STRING) {
      return null;
    }
    const s = unquote(expr.value);
    return s === null ? null : intExpr(byteLength(s));
  }

  // unwrapConversion looks through a []T(x) conversion; an append yields the
  // length it builds.
  private unwrap(expr: ast.Expr): { expr: ast.Expr; length?: Expr | null } {
    if (expr.$type === "CallExpr") {
      if (expr.args.length === 1 && expr.fun?.$type === "ArrayType") {
        return { expr: expr.args[0]! };
      }
      if (expr.args.length >= 2 && expr.fun?.$type === "Ident" && expr.fun.name === "append") {
        return { expr, length: addIntExpr(this.sliceLength(expr.args[0]!), this.appendCount(expr)) };
      }
    }
    return { expr };
  }

  private sliceLength(input: ast.Expr): Expr | null {
    const unwrapped = this.unwrap(input);
    if (unwrapped.length !== undefined) {
      return unwrapped.length;
    }
    const expr = unwrapped.expr;
    const under = this.pass.typesInfo.typeOf(expr)?.underlying() ?? null;
    switch (under?.$type) {
      case "Array":
      case "Slice":
        if (expr.$type === "CompositeLit") {
          return intExpr(expr.elts.length);
        }
        break;
      case "Basic":
        if ((under.info() & types.IsString) !== 0) {
          const length = this.stringLength(expr);
          if (length !== null) {
            return length;
          }
        }
        break;
      default:
        return null;
    }
    if (hasCall(expr)) {
      return null;
    }
    return sliceBound(expr);
  }

  private rangeLoopCount(stmt: ast.RangeStmt): { expr: Expr | null; ok: boolean } {
    if (hasAny(stmt.x, this.loopVars)) {
      return { expr: null, ok: false };
    }
    const unwrapped = this.unwrap(stmt.x!);
    if (unwrapped.length !== undefined) {
      return { expr: unwrapped.length, ok: true };
    }
    const x = unwrapped.expr;
    const under = this.pass.typesInfo.typeOf(x)?.underlying() ?? null;
    switch (under?.$type) {
      case "Chan":
      case "Signature":
        return { expr: null, ok: false };
      case "Array":
        if (stmt.x!.$type === "CompositeLit" && under.len() >= 0) {
          return { expr: intExpr(under.len()), ok: true };
        }
        break;
      case "Slice":
        if (stmt.x!.$type === "CompositeLit") {
          return { expr: intExpr(stmt.x!.elts.length), ok: true };
        }
        break;
      case "Map":
        if (x.$type === "CompositeLit") {
          return { expr: intExpr(x.elts.length), ok: true };
        }
        break;
      case "Pointer": {
        const elem = under.elem();
        if (elem?.$type !== "Array") {
          return { expr: null, ok: true };
        }
        if (x.$type === "UnaryExpr" && x.op === token.AND && x.x?.$type === "CompositeLit" && elem.len() >= 0) {
          return { expr: intExpr(elem.len()), ok: true };
        }
        break;
      }
      case "Basic":
        if ((under.info() & types.IsString) !== 0) {
          const length = this.stringLength(x);
          if (length !== null) {
            return { expr: length, ok: true };
          }
        }
        break;
      default:
        return { expr: null, ok: true };
    }
    if (hasCall(x)) {
      return { expr: null, ok: true };
    }
    if (under?.$type === "Basic") {
      if ((under.info() & types.IsInteger) !== 0) {
        return { expr: x, ok: true };
      }
      if ((under.info() & types.IsString) === 0) {
        return { expr: null, ok: true };
      }
    }
    return { expr: sliceBound(x), ok: true };
  }

  private forLoopCount(stmt: ast.ForStmt): { expr: Expr | null; ok: boolean } {
    if (stmt.init === null || stmt.cond === null || stmt.post === null) {
      return { expr: null, ok: false };
    }
    if (hasAny(stmt.init, this.loopVars) || hasAny(stmt.cond, this.loopVars)) {
      return { expr: null, ok: false };
    }
    const init = stmt.init;
    if (init.$type !== "AssignStmt" || init.lhs.length !== init.rhs.length) {
      return { expr: null, ok: true };
    }
    for (let i = 0; i < init.lhs.length; i++) {
      const initIdent = init.lhs[i];
      if (initIdent?.$type !== "Ident") {
        continue;
      }
      let reverse = false;
      let step: Expr | null = null;
      const post = stmt.post;
      if (post.$type === "IncDecStmt") {
        if (isIdentName(post.x, initIdent.name)) {
          reverse = post.tok === token.DEC;
          step = intExpr(1);
        }
      } else if (post.$type === "AssignStmt") {
        if (post.lhs.length !== post.rhs.length) {
          return { expr: null, ok: true };
        }
        for (let j = 0; j < post.lhs.length; j++) {
          if (!isIdentName(post.lhs[j], initIdent.name)) {
            continue;
          }
          if (post.tok === token.ADD_ASSIGN || post.tok === token.SUB_ASSIGN) {
            step = post.rhs[j];
            reverse = post.tok === token.SUB_ASSIGN;
          } else if (post.tok === token.ASSIGN) {
            const rhs = post.rhs[j];
            if (rhs?.$type !== "BinaryExpr") {
              return { expr: null, ok: false };
            }
            // Upstream compares the assignment token with -, so this is never
            // a reverse step.
            reverse = false;
            if (rhs.op === token.ADD) {
              if (isIdentName(rhs.x, initIdent.name)) {
                step = rhs.y;
              } else if (isIdentName(rhs.y, initIdent.name)) {
                step = rhs.x;
              }
            }
          } else {
            return { expr: null, ok: false };
          }
          if (step !== null) {
            break;
          }
        }
      }
      if (step === null) {
        continue;
      }
      let lower: Expr | null = init.rhs[i];
      if (hasCall(lower)) {
        continue;
      }
      const bound = forLoopUpperBound(stmt.cond, initIdent.name);
      let upper = bound.expr;
      if (!reverse) {
        if (bound.op === token.GTR || bound.op === token.GEQ) {
          return { expr: null, ok: false };
        }
      } else {
        if (bound.op === token.LSS || bound.op === token.LEQ) {
          return { expr: null, ok: false };
        }
        [lower, upper] = [upper, lower];
      }
      if (bound.op === token.LEQ || bound.op === token.GEQ) {
        upper = incIntExpr(upper);
      }
      const { expr, rounded } = divIntExpr(subIntExpr(upper, lower), step);
      // Extra capacity in case a larger step rounds down.
      return { expr: rounded ? incIntExpr(expr) : expr, ok: true };
    }
    return { expr: null, ok: true };
  }
}

// sliceBound returns the length of x[low:high], or len(x).
function sliceBound(expr: ast.Expr): Expr | null {
  if (expr.$type === "SliceExpr") {
    const high: Expr = expr.high ?? callExpr("len", [expr.x!]);
    return expr.low !== null ? subIntExpr(high, expr.low) : high;
  }
  return callExpr("len", [expr]);
}

const reversed = new Map([
  [token.LSS, token.GTR],
  [token.GTR, token.LSS],
  [token.LEQ, token.GEQ],
  [token.GEQ, token.LEQ],
]);

// forLoopUpperBound returns the bound a loop condition places on name and its
// comparison. Combined bounds become min or max.
function forLoopUpperBound(expr: ast.Expr | null, name: string): { expr: Expr | null; op: token.Token } {
  if (expr?.$type !== "BinaryExpr") {
    return { expr: null, op: 0 };
  }
  if (expr.op === token.LAND || expr.op === token.LOR) {
    const x = forLoopUpperBound(expr.x, name);
    const y = forLoopUpperBound(expr.y, name);
    if (x.expr === null || y.expr === null || x.op !== y.op) {
      return { expr: null, op: 0 };
    }
    const fun = expr.op === token.LAND ? "min" : "max";
    // Upstream extends an existing min or max call in place.
    if (shape(x.expr).type === "CallExpr" && isCallNamed(x.expr, fun)) {
      return { expr: extend(x.expr, y.expr), op: x.op };
    }
    if (shape(y.expr).type === "CallExpr" && isCallNamed(y.expr, fun)) {
      return { expr: extend(y.expr, x.expr), op: y.op };
    }
    return { expr: callExpr(fun, [x.expr, y.expr]), op: x.op };
  }
  if (![token.LSS, token.GTR, token.LEQ, token.GEQ, token.NEQ].includes(expr.op)) {
    return { expr: null, op: 0 };
  }
  if (isIdentName(expr.x, name)) {
    return hasCall(expr.y) ? { expr: null, op: 0 } : { expr: expr.y, op: expr.op };
  }
  if (isIdentName(expr.y, name)) {
    return hasCall(expr.x) ? { expr: null, op: 0 } : { expr: expr.x, op: reversed.get(expr.op) ?? expr.op };
  }
  return { expr: null, op: 0 };
}

function isCallNamed(e: Expr, fun: string): boolean {
  const s = shape(e);
  return s.type === "CallExpr" && s.fun === fun && (isSyn(e) || (e.$type === "CallExpr" && e.fun?.$type === "Ident"));
}

function extend(call: Expr, arg: Expr): Expr {
  if (isSyn(call) && call.syn === "call") {
    call.args.push(arg);
    return call;
  }
  const s = shape(call);
  return callExpr(s.type === "CallExpr" ? s.fun! : "", [...(s.type === "CallExpr" ? s.args : []), arg]);
}

function isIdentName(expr: ast.Expr | null, name: string): boolean {
  return expr?.$type === "Ident" && expr.name === name;
}

const exprTypes = new Set([
  "BadExpr",
  "Ident",
  "Ellipsis",
  "BasicLit",
  "FuncLit",
  "CompositeLit",
  "ParenExpr",
  "SelectorExpr",
  "IndexExpr",
  "IndexListExpr",
  "SliceExpr",
  "TypeAssertExpr",
  "CallExpr",
  "StarExpr",
  "UnaryExpr",
  "BinaryExpr",
  "KeyValueExpr",
  "ArrayType",
  "StructType",
  "FuncType",
  "InterfaceType",
  "MapType",
  "ChanType",
]);

function hasAny(node: Expr | ast.Node | null, exprs: readonly ast.Expr[]): boolean {
  let found = false;
  const visit = (n: Expr | ast.Node) => {
    if ((isSyn(n) || exprTypes.has(n.$type)) && exprs.some((e) => exprEqual(n as Expr, e))) {
      found = true;
    }
    return !found;
  };
  if (node !== null && (isSyn(node) || exprTypes.has(node.$type))) {
    inspect(node as Expr, visit);
  } else if (node !== null) {
    ast.inspect(node as ast.Node, (n) => n === null || visit(n));
  }
  return found;
}

const conversions = new Set([
  "bool",
  "error",
  "string",
  "any",
  "byte",
  "rune",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uintptr",
  "float32",
  "float64",
  "complex64",
  "complex128",
]);
const pureBuiltins = new Set(["len", "cap", "real", "imag", "min", "max", "complex"]);

// hasCall reports whether an expression calls something other than a type
// conversion, a cheap pure builtin, or a method without arguments.
function hasCall(expr: Expr | null): boolean {
  let found = false;
  inspect(expr, (n) => {
    if (isSyn(n)) {
      return true;
    }
    if (n.$type !== "CallExpr") {
      return !found;
    }
    const fun = n.fun;
    if (fun?.$type === "ArrayType" || fun?.$type === "MapType") {
      return true;
    }
    if (fun?.$type === "Ident") {
      if ((conversions.has(fun.name) && n.args.length === 1) || pureBuiltins.has(fun.name)) {
        return true;
      }
    } else if (fun?.$type === "SelectorExpr" && n.args.length === 0) {
      return true;
    }
    found = true;
    return false;
  });
  return found;
}

// hasVarReference reports whether an expression refers to a variable. Like
// upstream, a later identifier overwrites what an earlier one found.
function hasVarReference(expr: Expr | null, name: string): boolean {
  let found = false;
  inspect(expr, (n) => {
    if (isSyn(n)) {
      if (n.syn === "call") {
        for (const arg of n.args) {
          found = hasVarReference(arg, name);
          if (found) {
            break;
          }
        }
        return false;
      }
      return !found;
    }
    switch (n.$type) {
      case "SelectorExpr":
        found = hasVarReference(n.x, name);
        return false;
      case "CallExpr":
        for (const arg of n.args) {
          found = hasVarReference(arg, name);
          if (found) {
            break;
          }
        }
        return false;
      case "KeyValueExpr":
        found = hasVarReference(n.value, name);
        return false;
      case "Ident":
        found = n.name === name;
        break;
    }
    return !found;
  });
  return found;
}
