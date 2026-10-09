import * as ast from "go/ast";
import { type Diagnostic, defineAnalyzer, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";

const expMaps = "golang.org/x/exp/maps";
const expSlices = "golang.org/x/exp/slices";
const expConstraints = "golang.org/x/exp/constraints";

interface Replacement {
  // minGo is the minimum Go minor version, as 21 for go1.21.
  minGo: number;
  text: string;
  fix?: (call: ast.CallExpr) => string;
}

const keysOrValues = (call: ast.CallExpr) =>
  `slices.AppendSeq(make([]FIXME, 0, len(${call.args.map((arg) => formatNode(arg!)).join(", ")})), ${formatNode(call)})`;

const mapsReplacements = new Map<string, Replacement>([
  ["Keys", { minGo: 23, text: "slices.AppendSeq(make([]T, 0, len(data)), maps.Keys(data))", fix: keysOrValues }],
  ["Values", { minGo: 23, text: "slices.AppendSeq(make([]T, 0, len(data)), maps.Values(data))", fix: keysOrValues }],
  ["Equal", { minGo: 21, text: "maps.Equal()" }],
  ["EqualFunc", { minGo: 21, text: "maps.EqualFunc()" }],
  ["Clone", { minGo: 21, text: "maps.Clone()" }],
  ["Copy", { minGo: 21, text: "maps.Copy()" }],
  ["DeleteFunc", { minGo: 21, text: "maps.DeleteFunc()" }],
  [
    "Clear",
    {
      minGo: 21,
      text: "clear()",
      fix: (call) => `clear(${call.args.map((arg) => formatNode(arg!)).join(", ")}${call.ellipsis !== 0 ? "..." : ""})`,
    },
  ],
]);

// slicesFunctions are the golang.org/x/exp/slices functions in the slices package since Go 1.21.
const slicesFunctions = [
  "Equal",
  "EqualFunc",
  "Compare",
  "CompareFunc",
  "Index",
  "IndexFunc",
  "Contains",
  "ContainsFunc",
  "Insert",
  "Delete",
  "DeleteFunc",
  "Replace",
  "Clone",
  "Compact",
  "CompactFunc",
  "Grow",
  "Clip",
  "Reverse",
  "Sort",
  "SortFunc",
  "SortStableFunc",
  "IsSorted",
  "IsSortedFunc",
  "Min",
  "MinFunc",
  "Max",
  "MaxFunc",
  "BinarySearch",
  "BinarySearchFunc",
];
const slicesReplacements = new Map<string, Replacement>(slicesFunctions.map((name) => [name, { minGo: 21, text: `slices.${name}()` }]));

export default defineAnalyzer({
  name: "exptostd",
  doc: `detect functions from golang.org/x/exp/ that can be replaced by std functions

Reports calls to golang.org/x/exp/maps and golang.org/x/exp/slices functions,
and uses of constraints.Ordered, that the standard library now provides, and
imports of those packages that can be replaced outright.`,
  requires: [inspect],
  run(pass) {
    const goVersion = minorVersion(pass.pkg.goVersion());
    // Imports without a name, by path.
    const imports = new Map<string, ast.ImportSpec>();
    let keepMaps = false;
    let keepSlices = false;
    const slicesDiagnostics: Diagnostic[] = [];
    const constraints = { keep: false };
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr, ast.FuncDecl, ast.TypeSpec, ast.ImportSpec)) {
      const node = cursor.node()!;
      switch (node.$type) {
        case "ImportSpec":
          if (node.name === null || node.name.name === "") {
            imports.set(trimImportPath(node), node);
          }
          break;
        case "CallExpr": {
          const sel = node.fun;
          if (sel?.$type !== "SelectorExpr" || sel.x?.$type !== "Ident") {
            break;
          }
          if (sel.x.name === "maps") {
            const diagnostic = detectUsage(pass, mapsReplacements, sel, node, expMaps, goVersion);
            if (diagnostic !== null) {
              pass.report(diagnostic);
            }
            keepMaps = keepMaps || diagnostic === null;
          } else if (sel.x.name === "slices") {
            const diagnostic = detectUsage(pass, slicesReplacements, sel, node, expSlices, goVersion);
            if (diagnostic !== null) {
              slicesDiagnostics.push(diagnostic);
            }
            keepSlices = keepSlices || diagnostic === null;
          }
          break;
        }
        case "FuncDecl":
          for (const field of node.type!.typeParams?.list ?? []) {
            detectConstraints(pass, field!.type, constraints, goVersion);
          }
          break;
        case "TypeSpec":
          for (const field of node.typeParams?.list ?? []) {
            detectConstraints(pass, field!.type, constraints, goVersion);
          }
          if (node.type?.$type === "InterfaceType") {
            for (const method of node.type.methods!.list) {
              const t = method!.type;
              if (t?.$type === "BinaryExpr") {
                detectConstraints(pass, t.x, constraints, goVersion);
                detectConstraints(pass, t.y, constraints, goVersion);
              } else if (t?.$type === "SelectorExpr") {
                detectConstraints(pass, t, constraints, goVersion);
              }
            }
          }
          break;
      }
    }
    suggestImport(pass, imports, keepMaps, expMaps, "maps");
    // When the whole import can go, it alone is reported.
    if (keepSlices) {
      for (const diagnostic of slicesDiagnostics) {
        pass.report(diagnostic);
      }
    } else {
      suggestImport(pass, imports, keepSlices, expSlices, "slices");
    }
    suggestImport(pass, imports, constraints.keep, expConstraints, "cmp");
  },
});

// detectUsage reports a call to an exp function with a std replacement, or
// returns null if the call is something else.
function detectUsage(
  pass: Pass<unknown>,
  replacements: Map<string, Replacement>,
  sel: ast.SelectorExpr,
  call: ast.CallExpr,
  importPath: string,
  goVersion: number,
): Diagnostic | null {
  const name = sel.sel!.name;
  const replacement = replacements.get(name);
  if (replacement === undefined || replacement.minGo > goVersion || !isPackage(pass, sel.x as ast.Ident, importPath)) {
    return null;
  }
  const fix = replacement.fix;
  return {
    pos: call.pos(),
    message: `${importPath}.${name}() can be replaced by ${replacement.text}`,
    suggestedFixes: fix === undefined ? [] : [{ message: "", textEdits: [{ pos: call.pos(), end: call.end(), newText: fix(call) }] }],
  };
}

function detectConstraints(pass: Pass<unknown>, expr: ast.Expr | null, result: { keep: boolean }, goVersion: number): void {
  switch (expr?.$type) {
    case "SelectorExpr": {
      if (expr.x?.$type !== "Ident" || !isPackage(pass, expr.x, expConstraints)) {
        return;
      }
      const name = expr.sel!.name;
      if (name !== "Ordered" || goVersion < 21) {
        result.keep = true;
        return;
      }
      pass.report({
        pos: expr.pos(),
        message: `${expConstraints}.${name} can be replaced by cmp.Ordered`,
        suggestedFixes: [{ message: "", textEdits: [{ pos: expr.pos(), end: expr.end(), newText: "cmp.Ordered" }] }],
      });
      return;
    }
    case "BinaryExpr":
      detectConstraints(pass, expr.x, result, goVersion);
      detectConstraints(pass, expr.y, result, goVersion);
      return;
    case "UnaryExpr":
      detectConstraints(pass, expr.x, result, goVersion);
      return;
  }
}

function suggestImport(pass: Pass<unknown>, imports: Map<string, ast.ImportSpec>, keep: boolean, importPath: string, std: string): void {
  const spec = imports.get(importPath);
  if (spec === undefined || keep) {
    return;
  }
  const quote = spec.path!.value[0];
  pass.report({
    pos: spec.pos(),
    end: spec.end(),
    message: `Import statement '${trimImportPath(spec)}' may be replaced by '${std}'`,
    suggestedFixes: [{ message: "", textEdits: [{ pos: spec.path!.pos(), end: spec.path!.end(), newText: quote + std + quote }] }],
  });
}

function isPackage(pass: Pass<unknown>, ident: ast.Ident, importPath: string): boolean {
  const object = pass.typesInfo.uses.get(ident);
  return object?.$type === "PkgName" && object.imported()!.path() === importPath;
}

// minorVersion returns a package's Go minor version, as 21 for go1.21. An
// empty version means a development toolchain, which has everything.
function minorVersion(version: string): number {
  if (version === "") {
    return 666;
  }
  const match = /^go1\.(\d+)/.exec(version);
  return match === null ? 16 : Number(match[1]);
}

function trimImportPath(spec: ast.ImportSpec): string {
  return spec.path!.value.slice(1, -1);
}
