import * as ast from "go/ast";
import { goFmt, isStringLiteral } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "unnecessary-format";

export function create(): Rule {
  return { name, apply };
}

// Each formatting function's format argument index and alternative. Like
// revive, the logger, t, b, and f entries match variables by name alone.
const formattingFuncs = new Map<string, [number, string]>([
  ["fmt.Appendf", [1, `"fmt.Append"`]],
  ["fmt.Errorf", [0, `"errors.New"`]],
  ["fmt.Fprintf", [1, `"fmt.Fprint"`]],
  ["fmt.Fscanf", [1, `"fmt.Fscan" or "fmt.Fscanln"`]],
  ["fmt.Printf", [0, `"fmt.Print" or "fmt.Println"`]],
  ["fmt.Scanf", [0, `"fmt.Scan"`]],
  ["fmt.Sprintf", [0, `"fmt.Sprint" or just the string itself"`]],
  ["fmt.Sscanf", [1, `"fmt.Sscan"`]],
  ["log.Fatalf", [0, `"log.Fatal"`]],
  ["log.Panicf", [0, `"log.Panic"`]],
  ["log.Printf", [0, `"log.Print"`]],
  ["logger.Fatalf", [0, `"logger.Fatal"`]],
  ["logger.Panicf", [0, `"logger.Panic"`]],
  ["logger.Printf", [0, `"logger.Print"`]],
  ["t.Errorf", [0, `"t.Error"`]],
  ["t.Fatalf", [0, `"t.Fatal"`]],
  ["t.Logf", [0, `"t.Log"`]],
  ["t.Skipf", [0, `"t.Skip"`]],
  ["b.Errorf", [0, `"b.Error"`]],
  ["b.Fatalf", [0, `"b.Fatal"`]],
  ["b.Logf", [0, `"b.Log"`]],
  ["b.Skipf", [0, `"b.Skip"`]],
  ["f.Errorf", [0, `"f.Error"`]],
  ["f.Fatalf", [0, `"f.Fatal"`]],
  ["f.Logf", [0, `"f.Log"`]],
  ["f.Skipf", [0, `"f.Skip"`]],
  ["trace.Logf", [2, `"trace.Log"`]],
]);

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  ast.inspect(file.ast, (n) => {
    if (n === null || n.$type !== "CallExpr") {
      return true;
    }
    const call = n as ast.CallExpr;
    if (call.args.length < 1) {
      return true;
    }
    const funcName = goFmt(call.fun!);
    const spec = formattingFuncs.get(funcName);
    if (spec === undefined || call.args.length <= spec[0]) {
      return true;
    }
    const arg = call.args[spec[0]]!;
    if (!isStringLiteral(arg) || goFmt(arg).includes("%")) {
      return true;
    }
    failures.push({
      node: call.fun!,
      confidence: 0.8,
      failure: `unnecessary use of formatting function "${funcName}", you can replace it with ${spec[1]}`,
    });
    return true;
  });
  return failures;
}
