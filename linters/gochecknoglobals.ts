import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";

export default defineAnalyzer({
  name: "gochecknoglobals",
  doc: `check that no global variables exist

Any function in a package can read and write a package-level variable, so
global variables cause side effects that are hard to track. Sentinel errors
named ErrXxx or errXxx, variables named _ or version, //go:embed targets, and
regexp.MustCompile results are allowed.`,
  runDespiteErrors: true,
  run(pass) {
    for (const file of pass.files) {
      if (!pass.fset.position(file.pos()).filename.endsWith(".go")) {
        continue;
      }
      const comments = ast.newCommentMap(pass.fset, file, file.comments);
      for (const decl of file.decls) {
        if (decl?.$type !== "GenDecl" || decl.tok !== token.VAR || hasEmbedComment(comments, decl)) {
          continue;
        }
        for (const spec of decl.specs) {
          const valueSpec = spec as ast.ValueSpec;
          if (valueSpec.values.length > 0 && valueSpec.values.every((value) => isAllowedValue(value!))) {
            continue;
          }
          for (const name of valueSpec.names) {
            if (!isAllowedName(pass, comments, name!)) {
              pass.report({ pos: name!.pos(), category: "global", message: `${name!.name} is a global variable` });
            }
          }
        }
      }
    }
  },
});

function isAllowedName(pass: Pass<unknown>, comments: ast.CommentMap, ident: ast.Ident): boolean {
  if (ident.name === "_" || ident.name === "version" || isError(pass, ident)) {
    return true;
  }
  const decl = ident.obj?.decl as ast.Node | null | undefined;
  return decl?.$type === "ValueSpec" && hasEmbedComment(comments, decl);
}

// isAllowedValue reports whether a value is a regexp.MustCompile call or
// composite literal, which are effectively constant.
function isAllowedValue(value: ast.Expr): boolean {
  const selector = value.$type === "CallExpr" ? value.fun : value.$type === "CompositeLit" ? value.type : null;
  return selector?.$type === "SelectorExpr" && selector.x?.$type === "Ident" && selector.x.name === "regexp" && selector.sel!.name === "MustCompile";
}

// isError reports whether an identifier is named as an error, Err or err
// first, and implements error.
function isError(pass: Pass<unknown>, ident: ast.Ident): boolean {
  const prefix = ast.isExported(ident.name) ? "Err" : "err";
  const t = pass.typesInfo.typeOf(ident);
  const errorType = types.Universe!.lookup("error")!.type()!.underlying() as types.Interface;
  return ident.name.startsWith(prefix) && t !== null && types.implements_(t, errorType);
}

function hasEmbedComment(comments: ast.CommentMap, node: ast.Node): boolean {
  return (comments.get(node) ?? []).some((group) => group!.list.some((comment) => comment!.text.startsWith("//go:embed ")));
}
