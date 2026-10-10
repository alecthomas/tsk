import * as ast from "go/ast";
import * as token from "go/token";
import { receiverType } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "exported";

export interface Options {
  /** Check exported methods of unexported types. */
  checkPrivateReceivers: boolean;
  /** Do not report exported names that repeat the package name. */
  disableStutteringCheck: boolean;
  /** Say "is repetitive" rather than "stutters" about names that repeat the package name. */
  sayRepetitiveInsteadOfStutters: boolean;
  /** Check the comments of exported methods of exported interfaces. */
  checkPublicInterface: boolean;
  /** Do not check exported constants. */
  disableChecksOnConstants: boolean;
  /** Do not check exported functions. */
  disableChecksOnFunctions: boolean;
  /** Do not check exported methods. */
  disableChecksOnMethods: boolean;
  /** Do not check exported types. */
  disableChecksOnTypes: boolean;
  /** Do not check exported variables. */
  disableChecksOnVariables: boolean;
}

export const defaults: Options = {
  checkPrivateReceivers: false,
  disableStutteringCheck: false,
  sayRepetitiveInsteadOfStutters: false,
  checkPublicInterface: false,
  disableChecksOnConstants: false,
  disableChecksOnFunctions: false,
  disableChecksOnMethods: false,
  disableChecksOnTypes: false,
  disableChecksOnVariables: false,
};

const commonMethods = new Set(["Error", "Read", "ServeHTTP", "String", "Write", "Unwrap"]);

const articles = ["A", "An", "The", "This"];

enum Status {
  OK,
  Missing,
  CaseMismatch,
  FirstLetterMismatch,
  Unexpected,
}

function confidence(status: Status): number {
  return status === Status.Unexpected ? 0.8 : 1;
}

function correctionHint(status: Status, firstCommentLine: string): string {
  const firstWord = firstCommentLine.split(" ")[0];
  switch (status) {
    case Status.CaseMismatch:
      return ` by using its correct casing, not "${firstWord} ..."`;
    case Status.FirstLetterMismatch:
      return ` to match its exported status, not "${firstWord} ..."`;
    default:
      return "";
  }
}

// firstCommentLine is the first non-empty line of the comment's text, which
// omits directives, or "" if there is none before a deprecation notice.
function firstCommentLine(comment: ast.CommentGroup | null): string {
  if (comment === null) {
    return "";
  }
  for (const raw of comment.text().split("\n")) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    return line.startsWith("Deprecated: ") ? "" : line;
  }
  return "";
}

function stripFirstRune(s: string): string {
  return [...s].slice(1).join("");
}

function goDocStatus(comment: ast.CommentGroup | null, name: string): Status {
  const line = firstCommentLine(comment);
  if (line === "") {
    return Status.Missing;
  }
  const expectedPrefix = `${name.trim()} `;
  if (line.startsWith(expectedPrefix)) {
    return Status.OK;
  }
  if (!line.toLowerCase().startsWith(expectedPrefix.toLowerCase())) {
    return Status.Unexpected;
  }
  // Only the first letter differs, as when sendJSON became SendJSON.
  if (stripFirstRune(line).startsWith(stripFirstRune(expectedPrefix))) {
    return Status.FirstLetterMismatch;
  }
  return Status.CaseMismatch;
}

export function create(options: DeepReadonly<Options>): Rule {
  const repetitiveMsg = options.sayRepetitiveInsteadOfStutters ? "is repetitive" : "stutters";
  return {
    name,
    apply(file: File): Failure[] {
      if (!file.isImportable()) {
        return [];
      }
      const failures: Failure[] = [];
      const fail = (node: ast.Node, confidence: number, failure: string): void => {
        failures.push({ failure, node, confidence });
      };
      const pkgName = file.ast.name!.name;

      const mustCheckMethod = (fn: ast.FuncDecl): boolean => {
        const recv = receiverType(fn);
        if (!ast.isExported(recv) && !options.checkPrivateReceivers) {
          return false;
        }
        const fnName = fn.name!.name;
        if (commonMethods.has(fnName)) {
          return false;
        }
        return !(["Len", "Less", "Swap"].includes(fnName) && file.pkg.sortable().has(recv));
      };

      const lintFuncDoc = (fn: ast.FuncDecl): void => {
        const fnName = fn.name!.name;
        if (!ast.isExported(fnName)) {
          return;
        }
        let kind = "function";
        let fullName = fnName;
        if (fn.recv !== null && fn.recv.list.length > 0) {
          if (!mustCheckMethod(fn)) {
            return;
          }
          kind = "method";
          fullName = `${receiverType(fn)}.${fnName}`;
        }
        if (kind === "function" ? options.disableChecksOnFunctions : options.disableChecksOnMethods) {
          return;
        }
        const status = goDocStatus(fn.doc, fnName);
        if (status === Status.OK) {
          return;
        }
        if (status === Status.Missing) {
          fail(fn, confidence(status), `exported ${kind} ${fullName} should have comment or be unexported`);
          return;
        }
        const hint = correctionHint(status, firstCommentLine(fn.doc));
        fail(fn.doc!, confidence(status), `comment on exported ${kind} ${fullName} should be of the form "${fnName} ..."${hint}`);
      };

      const checkRepetitiveNames = (id: ast.Ident, thing: string): void => {
        if (options.disableStutteringCheck) {
          return;
        }
        const idName = id.name;
        // A name repeats the package name if that is a strict prefix and the
        // rest starts a new word.
        if (!ast.isExported(idName) || idName.length <= pkgName.length) {
          return;
        }
        if (pkgName.toLowerCase() !== idName.slice(0, pkgName.length).toLowerCase()) {
          return;
        }
        const rem = idName.slice(pkgName.length);
        if (rem[0] === "_" || /^\p{Lu}/u.test(rem)) {
          fail(id, 0.8, `${thing} name will be used as ${pkgName}.${idName} by other packages, and that ${repetitiveMsg}; consider calling this ${rem}`);
        }
      };

      const lintTypeDoc = (t: ast.TypeSpec, doc: ast.CommentGroup | null, firstLine: string): void => {
        if (options.disableChecksOnTypes) {
          return;
        }
        const typeName = t.name!.name;
        if (!ast.isExported(typeName)) {
          return;
        }
        if (firstLine === "") {
          fail(t, 1, `exported type ${typeName} should have comment or be unexported`);
          return;
        }
        let line = firstLine;
        let expectedPrefix = typeName;
        for (const a of articles) {
          if (typeName === a) {
            continue;
          }
          if (line.startsWith(`${a} `)) {
            line = line.slice(a.length + 1);
            expectedPrefix = `${a} ${typeName}`;
            break;
          }
        }
        const status = goDocStatus(doc, expectedPrefix);
        if (status === Status.OK) {
          return;
        }
        fail(
          doc!,
          confidence(status),
          `comment on exported type ${typeName} should be of the form "${typeName} ..." (with optional leading article)${correctionHint(status, line)}`,
        );
      };

      // Revive reports each block missing comments once, for its first spec.
      const genDeclMissingComments = new Set<ast.GenDecl>();

      const lintValueSpecDoc = (vs: ast.ValueSpec, gd: ast.GenDecl): void => {
        const kind = gd.tok === token.CONST ? "const" : "var";
        if (kind === "const" ? options.disableChecksOnConstants : options.disableChecksOnVariables) {
          return;
        }
        const extra = vs.names.slice(1).find((n) => ast.isExported(n!.name));
        if (extra !== undefined) {
          fail(vs, 1, `exported ${kind} ${extra!.name} should have its own declaration`);
          return;
        }
        const valueName = vs.names[0]!.name;
        if (!ast.isExported(valueName)) {
          return;
        }
        const vsFirstLine = firstCommentLine(vs.doc);
        const gdFirstLine = firstCommentLine(gd.doc);
        if (vsFirstLine === "" && gdFirstLine === "") {
          if (genDeclMissingComments.has(gd)) {
            return;
          }
          const block = kind === "const" && gd.lparen !== token.NoPos ? " (or a comment on this block)" : "";
          fail(vs, 1, `exported ${kind} ${valueName} should have comment${block} or be unexported`);
          genDeclMissingComments.add(gd);
          return;
        }
        // A commented block's specs keep to no particular form.
        if (gdFirstLine !== "" && gd.lparen !== token.NoPos) {
          return;
        }
        const doc = vsFirstLine !== "" ? vs.doc : gd.doc;
        const status = goDocStatus(doc, valueName);
        if (status === Status.OK) {
          return;
        }
        const hint = correctionHint(status, firstCommentLine(doc));
        fail(doc!, confidence(status), `comment on exported ${kind} ${valueName} should be of the form "${valueName} ..."${hint}`);
      };

      const lintInterfaceMethod = (typeName: string, m: ast.Field): void => {
        if (m.names.length === 0 || !ast.isExported(m.names[0]!.name)) {
          return;
        }
        const methodName = m.names[0]!.name;
        const status = goDocStatus(m.doc, methodName);
        if (status === Status.OK) {
          return;
        }
        if (status === Status.Missing) {
          fail(m, confidence(status), `public interface method ${typeName}.${methodName} should be commented`);
          return;
        }
        const hint = correctionHint(status, firstCommentLine(m.doc));
        fail(m.doc!, confidence(status), `comment on exported interface method ${typeName}.${methodName} should be of the form "${methodName} ..."${hint}`);
      };

      // Revive walks the file, but only top-level declarations matter.
      for (const decl of file.ast.decls) {
        if (decl!.$type === "FuncDecl") {
          const fn = decl as ast.FuncDecl;
          lintFuncDoc(fn);
          // Methods are not used package-qualified, so cannot stutter.
          if (fn.recv === null) {
            checkRepetitiveNames(fn.name!, "func");
          }
          continue;
        }
        if (decl!.$type !== "GenDecl" || (decl as ast.GenDecl).tok === token.IMPORT) {
          continue;
        }
        const gd = decl as ast.GenDecl;
        for (const spec of gd.specs) {
          if (spec!.$type === "ValueSpec") {
            lintValueSpecDoc(spec as ast.ValueSpec, gd);
            continue;
          }
          if (spec!.$type !== "TypeSpec") {
            continue;
          }
          const ts = spec as ast.TypeSpec;
          let doc = ts.doc;
          let firstLine = firstCommentLine(doc);
          if (firstLine === "") {
            doc = gd.doc;
            firstLine = firstCommentLine(doc);
          }
          lintTypeDoc(ts, doc, firstLine);
          checkRepetitiveNames(ts.name!, "type");
          if (options.checkPublicInterface && ts.type!.$type === "InterfaceType" && ast.isExported(ts.name!.name)) {
            for (const m of (ts.type as ast.InterfaceType).methods!.list) {
              lintInterfaceMethod(ts.name!.name, m!);
            }
          }
        }
      }
      return failures;
    },
  };
}
