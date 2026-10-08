import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";

interface Config {
  /** Predeclared identifiers not to report. */
  ignore: string[];
  /** Also check method and field names. */
  qualifiedName: boolean;
}

export default defineAnalyzer<Config>({
  name: "predeclared",
  doc: "find code that shadows one of Go's predeclared identifiers",
  url: "https://github.com/nishanths/predeclared",
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: { ignore: [], qualifiedName: false },
  run(pass) {
    for (const file of pass.files) {
      checkFile(pass, file!);
    }
  },
});

function checkFile(pass: Pass<Config>, file: ast.File): void {
  const qualified = pass.config.qualifiedName;
  const report = (ident: ast.Ident | null, kind: string) => {
    // The universe scope holds exactly the predeclared identifiers.
    if (ident !== null && !pass.config.ignore.includes(ident.name) && types.Universe!.lookup(ident.name) !== null) {
      pass.report({ pos: ident.pos(), end: ident.end(), message: `${kind} ${ident.name} has same name as predeclared identifier` });
    }
  };
  const reportFields = (list: ast.FieldList | null, kind: string) => {
    for (const field of list?.list ?? []) {
      for (const name of field!.names) {
        report(name, kind);
      }
    }
  };
  report(file.name, "package name");
  for (const spec of file.imports) {
    report(spec!.name, "import name");
  }
  ast.inspect(file, (node) => {
    switch (node?.$type) {
      case "GenDecl": {
        const kind = node.tok === token.CONST ? "const" : node.tok === token.VAR ? "variable" : null;
        for (const spec of kind === null ? [] : node.specs) {
          if (spec?.$type === "ValueSpec") {
            for (const name of spec.names) {
              report(name, kind!);
            }
          }
        }
        break;
      }
      case "TypeSpec":
        report(node.name, "type");
        break;
      case "StructType":
        if (qualified) {
          reportFields(node.fields, "field");
        }
        break;
      case "InterfaceType":
        if (qualified) {
          reportFields(node.methods, "method");
        }
        break;
      case "FuncDecl":
        if (node.recv === null) {
          report(node.name, "function");
        } else if (qualified) {
          report(node.name, "method");
        }
        reportFields(node.recv, "receiver");
        break;
      case "FuncType":
        reportFields(node.params, "param");
        reportFields(node.results, "named return");
        break;
      case "LabeledStmt":
        report(node.label, "label");
        break;
      case "AssignStmt":
        if (node.tok === token.DEFINE) {
          for (const lhs of node.lhs) {
            if (lhs?.$type === "Ident") {
              report(lhs, "variable");
            }
          }
        }
        break;
    }
    return true;
  });
}
