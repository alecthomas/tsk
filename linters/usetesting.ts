import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Report context.Background(). */
  contextBackground: boolean;
  /** Report context.TODO(). */
  contextTodo: boolean;
  /** Report os.Chdir(). */
  osChdir: boolean;
  /** Report os.MkdirTemp(). */
  osMkdirTemp: boolean;
  /** Report os.Setenv(). */
  osSetenv: boolean;
  /** Report os.TempDir(). */
  osTempDir: boolean;
  /** Report os.CreateTemp("", ...). */
  osCreateTemp: boolean;
}

// FuncInfo describes the test function whose body is checked.
interface FuncInfo {
  name: string;
  argName: string;
}

const fieldNames = ["Chdir", "MkdirTemp", "TempDir", "Setenv", "Background", "TODO", "CreateTemp"];

export default defineAnalyzer<Config>({
  name: "usetesting",
  doc: "Reports uses of functions with replacement inside the testing package.",
  requires: [inspect],
  config: {
    contextBackground: false,
    contextTodo: false,
    osChdir: true,
    osMkdirTemp: true,
    osSetenv: true,
    osTempDir: false,
    osCreateTemp: true,
  },
  run(pass) {
    const geGo124 = isGoSupported(pass.pkg.goVersion());
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.FuncDecl, ast.FuncLit)) {
      const node = cursor.node()!;
      if (node.$type === "FuncDecl") {
        checkFunc(pass, node.type!, node.body, node.name!.name, geGo124);
      } else if (node.$type === "FuncLit") {
        // Literals inside a test function were checked with it.
        const parents = cursor.enclosing(ast.FuncDecl, ast.FuncLit).toArray().slice(1);
        if (!parents.some((parent) => isTestFunc(parent.node() as ast.FuncDecl | ast.FuncLit))) {
          checkFunc(pass, node.type!, node.body, "anonymous function", geGo124);
        }
      }
    }
  },
});

// isGoSupported reports whether a package's Go version is at least 1.24. An
// empty version means a development toolchain.
function isGoSupported(version: string): boolean {
  if (version === "") {
    return true;
  }
  // Upstream joins the major and minor digits, as 124 for go1.24.
  const match = /^go(\d+)\.(\d+)/.exec(version);
  return match !== null && Number(match[1] + match[2]) >= 124;
}

function isTestFunc(fn: ast.FuncDecl | ast.FuncLit): boolean {
  const name = fn.$type === "FuncDecl" ? fn.name!.name : "anonymous function";
  return testFunctionInfo(fn.type!, name) !== null;
}

// testFunctionInfo returns the test function info if the first parameter is a
// *testing.T, *testing.B or testing.TB.
function testFunctionInfo(ft: ast.FuncType, name: string): FuncInfo | null {
  const arg = ft.params?.list[0];
  if (arg === undefined || arg === null) {
    return null;
  }
  let selector: ast.SelectorExpr;
  let defaultName: string;
  let selectorNames: string[];
  if (arg.type?.$type === "StarExpr" && arg.type.x?.$type === "SelectorExpr") {
    [selector, defaultName, selectorNames] = [arg.type.x, "<t/b>", ["T", "B"]];
  } else if (arg.type?.$type === "SelectorExpr") {
    [selector, defaultName, selectorNames] = [arg.type, "tb", ["TB"]];
  } else {
    return null;
  }
  if (selector.x?.$type !== "Ident" || selector.x.name !== "testing" || !selectorNames.includes(selector.sel!.name)) {
    return null;
  }
  const first = arg.names[0];
  return { name, argName: first?.name !== undefined && first.name !== "_" ? first.name : defaultName };
}

function checkFunc(pass: Pass<Config>, ft: ast.FuncType, body: ast.BlockStmt | null, name: string, geGo124: boolean): void {
  const info = testFunctionInfo(ft, name);
  if (info === null || body === null) {
    return;
  }
  // A reported node's children are not checked again.
  ast.inspect(body, (node) => {
    switch (node?.$type) {
      case "SelectorExpr":
        return !(node.sel!.isExported() && node.x?.$type === "Ident" && report(pass, node, node.x.name, node.sel!.name, info, geGo124));
      case "Ident":
        return !(node.isExported() && fieldNames.includes(node.name) && report(pass, node, packageName(pass, node), node.name, info, geGo124));
      case "CallExpr":
        return !reportCreateTemp(pass, node, info);
    }
    return true;
  });
}

function packageName(pass: Pass<Config>, ident: ast.Ident): string {
  return pass.typesInfo.objectOf(ident)?.pkg()?.name() ?? "";
}

function reportCreateTemp(pass: Pass<Config>, call: ast.CallExpr, info: FuncInfo): boolean {
  if (!pass.config.osCreateTemp || call.args.length !== 2) {
    return false;
  }
  const fun = call.fun;
  let pkg: string;
  if (fun?.$type === "SelectorExpr" && fun.sel!.name === "CreateTemp" && fun.x?.$type === "Ident") {
    pkg = fun.x.name;
  } else if (fun?.$type === "Ident" && fun.name === "CreateTemp") {
    pkg = packageName(pass, fun);
  } else {
    return false;
  }
  const first = call.args[0];
  if (pkg !== "os" || first?.$type !== "BasicLit" || first.kind !== token.STRING || first.value !== '""') {
    return false;
  }
  const message = `os.CreateTemp("", ...) could be replaced by os.CreateTemp(${info.argName}.TempDir(), ...) in ${info.name}`;
  // A fix needs the parameter's name.
  if (info.argName.includes("<")) {
    pass.report({ pos: call.pos(), message });
  } else {
    const newText = `${formatNode(fun)}(${info.argName}.TempDir(), ${formatNode(call.args[1]!)})`;
    pass.report({ pos: call.pos(), message, suggestedFixes: [{ message: "", textEdits: [{ pos: call.pos(), end: call.end(), newText }] }] });
  }
  return true;
}

function report(pass: Pass<Config>, node: ast.Node, pkg: string, name: string, info: FuncInfo, geGo124: boolean): boolean {
  const c = pass.config;
  let expect: string;
  if (c.osMkdirTemp && pkg === "os" && name === "MkdirTemp") {
    expect = "TempDir";
  } else if (c.osTempDir && pkg === "os" && name === "TempDir") {
    expect = "TempDir";
  } else if (c.osSetenv && pkg === "os" && name === "Setenv") {
    expect = "Setenv";
  } else if (geGo124 && c.osChdir && pkg === "os" && name === "Chdir") {
    expect = "Chdir";
  } else if (geGo124 && pkg === "context" && ((c.contextBackground && name === "Background") || (c.contextTodo && name === "TODO"))) {
    expect = "Context";
  } else {
    return false;
  }
  const message = `${pkg}.${name}() could be replaced by ${info.argName}.${expect}() in ${info.name}`;
  // Only context calls have a fix, as their replacements return the same
  // number of results.
  if (info.argName.includes("<") || pkg !== "context") {
    pass.report({ pos: node.pos(), message });
  } else {
    pass.report({
      pos: node.pos(),
      message,
      suggestedFixes: [{ message: "", textEdits: [{ pos: node.pos(), end: node.end(), newText: `${info.argName}.${expect}` }] }],
    });
  }
  return true;
}
