import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer, type Pass } from "tsk";

interface Config {
  /** Required order of type, const, var and func declarations in a file. */
  decOrder: readonly string[];
  /** Skip declarations named _ when counting declarations. */
  ignoreUnderscoreVars: boolean;
  /** Disable every check for repeated declarations of a kind. */
  disableDecNumCheck: boolean;
  /** Disable the check for repeated type declarations. */
  disableTypeDecNumCheck: boolean;
  /** Disable the check for repeated const declarations. */
  disableConstDecNumCheck: boolean;
  /** Disable the check for repeated var declarations. */
  disableVarDecNumCheck: boolean;
  /** Disable the declaration order check. */
  disableDecOrderCheck: boolean;
  /** Disable the check that init is a file's first function. */
  disableInitFuncFirstCheck: boolean;
}

const kindNames = new Map<token.Token, string>([
  [token.TYPE, "type"],
  [token.CONST, "const"],
  [token.VAR, "var"],
  [token.FUNC, "func"],
  [token.IMPORT, "import"],
]);

export default defineAnalyzer<Config>({
  name: "decorder",
  doc: "check declaration order and count of types, constants, variables and functions",
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: {
    decOrder: ["type", "const", "var", "func"],
    ignoreUnderscoreVars: false,
    disableDecNumCheck: true,
    disableTypeDecNumCheck: false,
    disableConstDecNumCheck: false,
    disableVarDecNumCheck: false,
    disableDecOrderCheck: true,
    disableInitFuncFirstCheck: true,
  },
  run(pass) {
    for (const file of pass.files) {
      if (!pass.config.disableDecNumCheck || !pass.config.disableDecOrderCheck) {
        checkDeclarations(pass, file!);
      }
      if (!pass.config.disableInitFuncFirstCheck) {
        checkInitFirst(pass, file!);
      }
    }
  },
});

function checkInitFirst(pass: Pass<Config>, file: ast.File): void {
  let nonInitFound = false;
  ast.inspect(file, (node) => {
    if (node?.$type !== "FuncDecl") {
      return true;
    }
    if (node.name!.name === "init" && node.recv === null) {
      if (nonInitFound) {
        pass.report({ pos: node.pos(), message: "init func must be the first function in file" });
      }
    } else {
      nonInitFound = true;
    }
    return true;
  });
}

function checkDeclarations(pass: Pass<Config>, file: ast.File): void {
  const c = pass.config;
  const order = c.decOrder
    .join(",")
    .split(",")
    .map((kind) => kind.trim());
  const counts = new Map<string, number>(["type", "const", "var", "func"].map((kind) => [kind, 0]));
  const numCheckDisabled = new Map<token.Token, boolean>([
    [token.TYPE, c.disableTypeDecNumCheck],
    [token.CONST, c.disableConstDecNumCheck],
    [token.VAR, c.disableVarDecNumCheck],
  ]);
  const funcs: ast.FuncDecl[] = [];
  // tooLate returns a later kind in the order that has already appeared.
  const tooLate = (kind: string) => {
    const i = order.indexOf(kind);
    return i < 0 ? undefined : order.slice(i + 1).find((later) => (counts.get(later) ?? 0) > 0);
  };
  const checkOrder = (node: ast.Node, kind: string) => {
    const later = tooLate(kind);
    if (!c.disableDecOrderCheck && later !== undefined) {
      pass.report({ pos: node.pos(), message: `${kind} must not be placed after ${later} (desired order: ${c.decOrder.join(",")})` });
    }
  };
  ast.inspect(file, (node) => {
    if (node?.$type === "FuncDecl") {
      funcs.push(node);
      counts.set("func", counts.get("func")! + 1);
      checkOrder(node, "func");
      return true;
    }
    // Declarations inside function declarations are not counted.
    if (node?.$type !== "GenDecl" || funcs.some((fn) => fn.pos() < node.pos() && fn.end() > node.pos())) {
      return true;
    }
    const kind = kindNames.get(node.tok)!;
    if (counts.has(kind) && !(c.ignoreUnderscoreVars && declName(node) === "_")) {
      counts.set(kind, counts.get(kind)! + 1);
      if (!c.disableDecNumCheck && !numCheckDisabled.get(node.tok) && counts.get(kind)! > 1) {
        pass.report({ pos: node.pos(), message: `multiple "${kind}" declarations are not allowed; use parentheses instead` });
      }
    }
    checkOrder(node, kind);
    return true;
  });
}

function declName(decl: ast.GenDecl): string {
  for (const spec of decl.specs) {
    if (spec?.$type === "ValueSpec" && spec.names.length > 0 && spec.names[0] !== null) {
      return spec.names[0].name;
    }
  }
  return "";
}
