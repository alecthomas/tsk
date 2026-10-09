import * as ast from "go/ast";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Check that constructors follow their type's declaration and precede its methods. */
  constructor: boolean;
  /** Check that a type's exported methods precede its unexported ones. */
  structMethod: boolean;
  /** Check that constructors and methods are sorted alphabetically. */
  alphabetical: boolean;
  /** Check that exported functions precede unexported ones. */
  function: boolean;
}

// TypeHolder collects one file's declaration of a type with its
// constructors and methods.
interface TypeHolder {
  spec: ast.TypeSpec | null;
  constructors: ast.FuncDecl[];
  methods: ast.FuncDecl[];
}

export default defineAnalyzer<Config>({
  name: "funcorder",
  doc: `check the order of functions, methods, and constructors

Constructors, exported functions named New... or Must... returning a type,
should follow the type's declaration and precede its methods, and exported
methods should precede unexported ones. Types are checked per file.`,
  requires: [inspect],
  config: { constructor: true, structMethod: true, alphabetical: false, function: false },
  run(pass) {
    for (const fileCursor of pass.resultOf(inspect).root().children()) {
      analyzeFile(
        pass,
        fileCursor
          .preorder(ast.FuncDecl, ast.TypeSpec)
          .toArray()
          .map((c) => c.node()!),
      );
    }
  },
});

function analyzeFile(pass: Pass<Config>, nodes: ast.Node[]): void {
  const holders = new Map<string, TypeHolder>();
  const holder = (name: string) => {
    let found = holders.get(name);
    if (found === undefined) {
      found = { spec: null, constructors: [], methods: [] };
      holders.set(name, found);
    }
    return found;
  };
  const functions: ast.FuncDecl[] = [];
  for (const node of nodes) {
    if (node.$type === "TypeSpec") {
      holder(node.name!.name).spec = node;
      continue;
    }
    if (node.$type !== "FuncDecl") {
      continue;
    }
    if (node.recv === null) {
      functions.push(node);
    }
    const constructed = constructedType(node);
    if (constructed !== null) {
      holder(constructed).constructors.push(node);
      continue;
    }
    const receiver = node.recv?.list.length === 1 ? identOf(node.recv.list[0]!.type) : null;
    if (receiver !== null) {
      holder(receiver.name).methods.push(node);
    }
  }
  for (const h of holders.values()) {
    if (h.spec !== null) {
      analyzeType(pass, h);
    }
  }
  if (pass.config.function) {
    analyzeFunctions(pass, functions);
  }
}

// constructedType returns the type an exported New... or Must... function
// returns first, or null if it is not a constructor.
function constructedType(fn: ast.FuncDecl): string | null {
  const name = fn.name!.name;
  const results = fn.type!.results?.list ?? [];
  if (!ast.isExported(name) || fn.recv !== null || results.length === 0) {
    return null;
  }
  const lower = name.toLowerCase();
  if (!["new", "must"].some((prefix) => lower.startsWith(prefix) && name.length > prefix.length)) {
    return null;
  }
  return identOf(results[0]!.type)?.name ?? null;
}

function identOf(expr: ast.Expr | null): ast.Ident | null {
  if (expr?.$type === "StarExpr") {
    return identOf(expr.x);
  }
  return expr?.$type === "Ident" ? expr : null;
}

function analyzeType(pass: Pass<Config>, h: TypeHolder): void {
  const spec = h.spec!;
  const typeName = JSON.stringify(spec.name!.name);
  const name = (fn: ast.FuncDecl) => JSON.stringify(fn.name!.name);
  h.methods.sort((a, b) => a.pos() - b.pos());
  if (pass.config.constructor) {
    h.constructors.forEach((ctor, i) => {
      if (ctor.pos() < spec.pos()) {
        pass.report({ pos: ctor.pos(), message: `constructor ${name(ctor)} for struct ${typeName} should be placed after the struct declaration` });
      }
      if (h.methods.length > 0 && ctor.pos() > h.methods[0].pos()) {
        pass.report({
          pos: ctor.pos(),
          message: `constructor ${name(ctor)} for struct ${typeName} should be placed before struct method ${name(h.methods[0])}`,
        });
      }
      const next = h.constructors[i + 1];
      if (pass.config.alphabetical && next !== undefined && ctor.name!.name > next.name!.name) {
        pass.report({
          pos: next.pos(),
          message: `constructor ${name(next)} for struct ${typeName} should be placed before constructor ${name(ctor)}`,
        });
      }
    });
  }
  if (!pass.config.structMethod) {
    return;
  }
  const exported = h.methods.filter((m) => ast.isExported(m.name!.name));
  const lastExported = exported[exported.length - 1];
  for (const method of h.methods) {
    if (lastExported !== undefined && !ast.isExported(method.name!.name) && method.pos() < lastExported.pos()) {
      pass.report({
        pos: method.pos(),
        message: `unexported method ${name(method)} for struct ${typeName} should be placed after the exported method ${name(lastExported)}`,
      });
    }
  }
  if (pass.config.alphabetical) {
    for (const group of [exported, h.methods.filter((m) => !ast.isExported(m.name!.name))]) {
      for (let i = 0; i + 1 < group.length; i++) {
        if (group[i].name!.name > group[i + 1].name!.name) {
          pass.report({
            pos: group[i + 1].pos(),
            message: `method ${name(group[i + 1])} for struct ${typeName} should be placed before method ${name(group[i])}`,
          });
        }
      }
    }
  }
}

function analyzeFunctions(pass: Pass<Config>, functions: ast.FuncDecl[]): void {
  const counted = functions.filter((fn) => fn.name!.name !== "init");
  const exported = counted.filter((fn) => ast.isExported(fn.name!.name));
  if (exported.length === 0) {
    return;
  }
  const lastExported = exported.reduce((last, fn) => (fn.pos() > last.pos() ? fn : last));
  for (const fn of counted) {
    if (!ast.isExported(fn.name!.name) && fn.pos() < lastExported.pos()) {
      pass.report({
        pos: fn.pos(),
        message: `unexported function ${JSON.stringify(fn.name!.name)} should be placed after the exported function ${JSON.stringify(lastExported.name!.name)}`,
      });
    }
  }
}
