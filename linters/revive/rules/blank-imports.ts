import type * as ast from "go/ast";
import type { File, Failure, Rule } from "../lint";

export const name = "blank-imports";

const message = "a blank import should be only in a main or test package, or have a comment justifying it";
const embedImportPath = `"embed"`;

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  if (file.pkg.isMain() || file.isTest()) {
    return [];
  }
  const failures: Failure[] = [];
  const imports = file.ast.imports;
  // The first of each contiguous group of blank imports needs a comment.
  imports.forEach((imp, i) => {
    if (!isBlank(imp!.name)) {
      return;
    }
    if (i > 0) {
      const prev = imports[i - 1]!;
      const line = file.toPosition(imp!.pos()).line;
      if (file.toPosition(prev.pos()).line + 1 === line && prev.path!.value !== embedImportPath && isBlank(prev.name)) {
        return;
      }
    }
    if (imp!.path!.value === embedImportPath && hasEmbedComment(file.ast)) {
      return;
    }
    if (imp!.doc === null && imp!.comment === null) {
      failures.push({ failure: message, node: imp!, confidence: 1 });
    }
  });
  return failures;
}

function hasEmbedComment(file: ast.File): boolean {
  return file.comments.some((group) => group!.list.some((c) => c!.text.startsWith("//go:embed ")));
}

function isBlank(id: ast.Ident | null): boolean {
  return id !== null && id.name === "_";
}
