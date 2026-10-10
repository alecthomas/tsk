import type * as ast from "go/ast";
import { isDirectiveComment } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "package-comments";

export function create(): Rule {
  // The missing-comment failure is reported once per package.
  let checked = false;
  const checkPackageComment = (file: File): Failure[] => {
    if (checked) {
      return [];
    }
    checked = true;
    const files = file.pkg.files;
    if (files.some((f) => f.ast.doc !== null)) {
      return [];
    }
    // Revive compares whole paths with "doc.go" and "<package>.go", so it
    // only prefers those files when run in their directory; tsk compares
    // base names.
    const docFile =
      files.find((f) => baseName(f.name) === "doc.go") ??
      files.find((f) => baseName(f.name) === `${f.ast.name!.name}.go`) ??
      files.reduce((first, f) => (f.name < first.name ? f : first));
    return [{ failure: "should have a package comment", pos: docFile.ast.pos(), end: docFile.ast.name!.end(), confidence: 1 }];
  };
  return {
    name,
    apply(file: File): Failure[] {
      if (file.isTest()) {
        return [];
      }
      const astFile = file.ast;
      const prefix = `Package ${astFile.name!.name} `;
      // A comment ending before the package clause, but not just before it, is detached.
      let last: ast.CommentGroup | null = null;
      for (const group of astFile.comments) {
        if (group!.pos() > astFile.package) {
          break;
        }
        last = group;
      }
      if (last !== null && last.text().startsWith(prefix)) {
        const endLine = commentGroupEndLine(file, last);
        if (endLine + 1 < file.toPosition(astFile.package).line) {
          const pos = file.tokenFile().lineStart(endLine + 1);
          return [
            {
              failure: "package comment is detached; there should be no blank lines between it and the package statement",
              pos,
              end: pos,
              confidence: 0.9,
            },
          ];
        }
      }
      if (astFile.doc === null || astFile.doc.text() === "") {
        return checkPackageComment(file);
      }
      const text = astFile.doc.text();
      if (!file.pkg.isMain() && !text.startsWith(prefix) && !isDirectiveComment(text)) {
        return [{ failure: `package comment should be of the form "${prefix}..."`, node: astFile.doc, confidence: 1 }];
      }
      return [];
    },
  };
}

// commentGroupEndLine counts the lines of the last comment's text, since
// CommentGroup.End is wrong for block comments in CRLF sources.
function commentGroupEndLine(file: File, group: ast.CommentGroup): number {
  const last = group.list[group.list.length - 1]!;
  return file.toPosition(last.slash).line + last.text.split("\n").length - 1;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
