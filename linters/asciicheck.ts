import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

export default defineAnalyzer({
  name: "asciicheck",
  doc: `check that declared identifiers contain only ASCII characters

Non-ASCII identifiers can hide look-alike characters, such as a Cyrillic а in
place of a Latin a.`,
  url: "https://github.com/tdakkota/asciicheck",
  requires: [inspect],
  run(pass) {
    const root = pass.resultOf(inspect).root();
    const nodes = [
      ast.File,
      ast.ImportSpec,
      ast.TypeSpec,
      ast.ValueSpec,
      ast.FuncDecl,
      ast.StructType,
      ast.FuncType,
      ast.InterfaceType,
      ast.LabeledStmt,
      ast.AssignStmt,
    ];
    for (const cursor of root.preorder(...nodes)) {
      const node = cursor.node()!;
      switch (node.$type) {
        case "File":
          checkIdent(pass, node.name);
          break;
        case "ImportSpec":
          checkIdent(pass, node.name);
          break;
        case "TypeSpec":
          checkIdent(pass, node.name);
          checkFieldList(pass, node.typeParams);
          break;
        case "ValueSpec":
          for (const name of node.names) {
            checkIdent(pass, name);
          }
          break;
        case "FuncDecl":
          checkIdent(pass, node.name);
          checkFieldList(pass, node.recv);
          break;
        case "StructType":
          checkFieldList(pass, node.fields);
          break;
        case "FuncType":
          checkFieldList(pass, node.typeParams);
          checkFieldList(pass, node.params);
          checkFieldList(pass, node.results);
          break;
        case "InterfaceType":
          checkFieldList(pass, node.methods);
          break;
        case "LabeledStmt":
          checkIdent(pass, node.label);
          break;
        case "AssignStmt":
          if (node.tok === token.DEFINE) {
            for (const expr of node.lhs) {
              if (expr?.$type === "Ident") {
                checkIdent(pass, expr);
              }
            }
          }
          break;
      }
    }
  },
});

function checkIdent(pass: Pass<unknown>, ident: ast.Ident | null): void {
  if (ident === null) {
    return;
  }
  for (const char of ident.name) {
    const code = char.codePointAt(0)!;
    if (code > 0x7f) {
      const hex = code.toString(16).toUpperCase().padStart(4, "0");
      pass.report({ pos: ident.pos(), message: `identifier "${ident.name}" contain non-ASCII character: U+${hex} '${char}'` });
      return;
    }
  }
}

function checkFieldList(pass: Pass<unknown>, fields: ast.FieldList | null): void {
  for (const field of fields?.list ?? []) {
    for (const name of field!.names) {
      checkIdent(pass, name);
    }
  }
}
