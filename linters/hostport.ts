// Port of golang.org/x/tools/go/analysis/passes/hostport at v0.50.0.
import * as ast from "go/ast";
import * as constant from "go/constant";
import * as token from "go/token";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, type Pass, type TextEdit } from "tsk";
import { inspect } from "tsk/passes";
import { isFunctionNamed, isMethodNamed } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "hostport",
  doc: `check format of addresses passed to net.Dial

This analyzer flags code that produce network address strings using
fmt.Sprintf, as in this example:

    addr := fmt.Sprintf("%s:%d", host, 12345) // "will not work with IPv6"
    ...
    conn, err := net.Dial("tcp", addr)       // "when passed to dial here"

The analyzer suggests a fix to use the correct approach, a call to
net.JoinHostPort:

    addr := net.JoinHostPort(host, "12345")
    ...
    conn, err := net.Dial("tcp", addr)

A similar diagnostic and fix are produced for a format string of "%s:%s".`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/hostport",
  // Upstream finds calls and declarations with the typeindex pass, which tsk does not provide.
  requires: [inspect],
  run(pass) {
    const info = pass.typesInfo;
    const root = pass.resultOf(inspect).root();
    // Check the address argument of each call to net.Dial et al.
    for (const cursor of root.preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      const callee = typeutil.callee(info, call);
      if (!isFunctionNamed(callee, "net", "Dial", "DialTimeout") && !isMethodNamed(callee, "net", "Dialer", "Dial")) {
        continue;
      }
      if (call.args.length < 2) {
        // A multi-valued call may supply the complete argument list.
        continue;
      }
      const address = call.args[1]!;
      if (address.$type === "CallExpr") {
        if (call.args.length === 2) {
          // net.Dial("tcp", fmt.Sprintf("%s:%d", ...))
          checkAddr(pass, address, null);
        }
      } else if (address.$type === "Ident") {
        // addr := fmt.Sprintf("%s:%d", ...); net.Dial("tcp", addr)
        const addrVar = info.uses.get(address) ?? null;
        if (addrVar?.$type !== "Var") {
          continue;
        }
        const def = root.findByPos(addrVar.pos(), addrVar.pos() + addrVar.name().length);
        const id = def?.node() ?? null;
        if (id?.$type !== "Ident" || info.defs.get(id) !== addrVar) {
          continue;
        }
        const parent = def!.parent().node();
        if (parent?.$type === "AssignStmt" && parent.rhs.length === 1) {
          checkAddr(pass, parent.rhs[0]!, call);
        } else if (parent?.$type === "ValueSpec" && parent.values.length === 1) {
          checkAddr(pass, parent.values[0]!, call);
        }
      }
    }
  },
});

// checkAddr reports e if it is a call of the form fmt.Sprintf("%s:%d", ...).
// dialCall is the Dial call when it is not e's parent.
function checkAddr(pass: Pass<unknown>, e: ast.Expr, dialCall: ast.CallExpr | null): void {
  const info = pass.typesInfo;
  if (e.$type !== "CallExpr" || e.args.length !== 3 || !isFunctionNamed(typeutil.callee(info, e), "fmt", "Sprintf")) {
    return;
  }
  const call = e;
  const formatArg = call.args[0]!;
  const value = info.types.get(formatArg)?.value ?? null;
  if (value === null) {
    return;
  }
  const format = constant.stringVal(value);
  if (format !== "%s:%d" && format !== "%s:%s") {
    return;
  }
  // Use granular edits to preserve the original formatting.
  const edits: TextEdit[] = [
    { pos: call.fun!.pos(), end: call.fun!.end(), newText: "net.JoinHostPort" },
    { pos: formatArg.pos(), end: call.args[1]!.pos(), newText: "" },
  ];
  if (format === "%s:%d") {
    const port = call.args[2]!;
    // Only an integer literal becomes a string literal, as a named constant
    // would lose its symbolic connection.
    const kPort = port.$type === "BasicLit" && port.kind === token.INT ? parseIntLiteral(port.value) : -1n;
    if (kPort >= 0n) {
      edits.push({ pos: port.pos(), end: port.end(), newText: `"${kPort}"` });
    } else {
      edits.push({ pos: port.pos(), end: port.pos(), newText: 'fmt.Sprintf("%d", ' }, { pos: port.end(), end: port.end(), newText: ")" });
    }
  }
  const suffix = dialCall === null ? "" : ` (passed to net.Dial at L${pass.fset.position(dialCall.pos()).line})`;
  pass.report({
    pos: formatArg.pos(),
    end: formatArg.end(),
    message: `address format "${format}" does not work with IPv6${suffix}`,
    suggestedFixes: [{ message: "Replace fmt.Sprintf with net.JoinHostPort", textEdits: edits }],
  });
}

const maxInt64 = (1n << 63n) - 1n;

// parseIntLiteral returns the value of a Go integer literal as
// strconv.ParseInt(lit, 0, 64) does, or -1 if it is out of range.
function parseIntLiteral(lit: string): bigint {
  let s = lit.replace(/_/g, "");
  // A leading 0 without a base prefix means octal; BigInt reads it as decimal.
  if (/^0[0-7]+$/.test(s)) {
    s = `0o${s.slice(1)}`;
  }
  let v: bigint;
  try {
    v = BigInt(s);
  } catch {
    return -1n;
  }
  return v > maxInt64 ? -1n : v;
}
