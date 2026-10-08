import type * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer, type Pass } from "tsk";

const outputPrefix = /^[ \t\n\v\f\r]*(unordered )?output:/i;

export default defineAnalyzer({
  name: "testableexamples",
  doc: "linter checks if examples are testable (have an expected output)",
  url: "https://github.com/maratori/testableexamples",
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  run(pass) {
    for (const file of pass.files) {
      if (pass.fset.position(file!.pos()).filename.endsWith("_test.go")) {
        checkFile(pass, file!);
      }
    }
  },
});

// checkFile reports examples without an output comment, finding examples as
// go/doc.Examples does.
function checkFile(pass: Pass<unknown>, file: ast.File): void {
  let hasTests = false;
  let numDecl = 0;
  const examples: ast.FuncDecl[] = [];
  for (const decl of file.decls) {
    if (decl?.$type === "GenDecl" && decl.tok !== token.IMPORT) {
      numDecl++;
      continue;
    }
    if (decl?.$type !== "FuncDecl" || decl.recv !== null) {
      continue;
    }
    numDecl++;
    const name = decl.name!.name;
    if (isTest(name, "Test") || isTest(name, "Benchmark") || isTest(name, "Fuzz")) {
      hasTests = true;
      continue;
    }
    const type = decl.type!;
    if (!isTest(name, "Example") || type.params!.list.length !== 0 || (type.results?.list.length ?? 0) !== 0 || decl.body === null) {
      continue;
    }
    examples.push(decl);
  }
  // go/doc treats a file with one example, other declarations, and no tests
  // as a whole-file example, whose code starts at the package clause.
  const wholeFile = !hasTests && numDecl > 1 && examples.length === 1;
  for (const example of examples) {
    if (!hasOutput(example.body!, file.comments as ast.CommentGroup[])) {
      const pos = wholeFile ? file.pos() : example.body!.pos();
      pass.report({ pos, message: "missing output for example, go test can't validate it" });
    }
  }
}

// hasOutput reports whether the last comment in a body is an output comment.
function hasOutput(body: ast.BlockStmt, comments: ast.CommentGroup[]): boolean {
  let last: ast.CommentGroup | null = null;
  for (const group of comments) {
    if (group.pos() < body.pos()) {
      continue;
    }
    if (group.end() > body.end()) {
      break;
    }
    last = group;
  }
  return last !== null && outputPrefix.test(last.text());
}

// isTest reports whether name is prefix followed by nothing or a character
// that is not a lower-case letter.
function isTest(name: string, prefix: string): boolean {
  if (!name.startsWith(prefix)) {
    return false;
  }
  const next = name.slice(prefix.length);
  return next === "" || !/^\p{Ll}/u.test(next);
}
