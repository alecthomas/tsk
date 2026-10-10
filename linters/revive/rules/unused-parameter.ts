import type * as ast from "go/ast";
import { pickNodes, walk, type Visitor } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "unused-parameter";

export interface Options {
  /** A regular expression matching names unused parameters may have. */
  allowRegex: string;
}

export const defaults: Options = { allowRegex: "^_$" };

export function create(options: DeepReadonly<Options>): Rule {
  // The pattern is a JavaScript regular expression, where revive's is Go's.
  let allow: RegExp;
  try {
    allow = new RegExp(options.allowRegex);
  } catch (e) {
    throw new Error(`error configuring ${name} rule: allowRegex is not valid regex [${options.allowRegex}]: ${e}`);
  }
  // Revive words the default differently only when unconfigured; this port
  // uses it whenever the pattern is the default.
  const suffix = options.allowRegex === defaults.allowRegex ? "as _" : `to match ${options.allowRegex}`;
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      const visitor: Visitor = {
        visit(node) {
          if (node === null) {
            return visitor;
          }
          let funcType: ast.FuncType;
          let body: ast.BlockStmt;
          if (node.$type === "FuncLit") {
            funcType = node.type!;
            body = node.body!;
          } else if (node.$type === "FuncDecl") {
            if (node.body === null) {
              return null;
            }
            funcType = node.type!;
            body = node.body;
          } else {
            return visitor;
          }
          // Parameters are told apart by their ast.Object, as revive does.
          const unused = new Set<ast.Object | null>();
          for (const field of funcType.params!.list) {
            for (const n of field!.names) {
              if (n!.name !== "_") {
                unused.add(n!.obj);
              }
            }
          }
          if (unused.size === 0) {
            return visitor;
          }
          for (const id of pickNodes(body, (n) => n.$type === "Ident")) {
            unused.delete((id as ast.Ident).obj);
          }
          for (const field of funcType.params!.list) {
            for (const n of field!.names) {
              if (!allow.test(n!.name) && unused.has(n!.obj)) {
                failures.push({ failure: `parameter '${n!.name}' seems to be unused, consider removing or renaming it ${suffix}`, node: n!, confidence: 1 });
              }
            }
          }
          return visitor;
        },
      };
      walk(visitor, file.ast);
      return failures;
    },
  };
}
