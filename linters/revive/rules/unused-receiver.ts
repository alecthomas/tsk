import { seekNode } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "unused-receiver";

export interface Options {
  /** A regular expression matching names unused receivers may have. */
  allowRegex: string;
}

export const defaults: Options = { allowRegex: "^_$" };

export function create(options: DeepReadonly<Options>): Rule {
  // The pattern is a JavaScript regular expression, where revive's is Go's.
  let allow: RegExp;
  try {
    allow = new RegExp(options.allowRegex);
  } catch (e) {
    throw new Error(`error configuring [unused-receiver] rule: allowRegex is not valid regex [${options.allowRegex}]: ${e}`);
  }
  // Revive words the default differently only when unconfigured; this port
  // uses it whenever the pattern is the default.
  const suffix = options.allowRegex === defaults.allowRegex ? "as _" : `to match ${options.allowRegex}`;
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      for (const decl of file.ast.decls) {
        if (decl?.$type !== "FuncDecl" || decl.recv === null) {
          continue;
        }
        const rec = decl.recv.list[0]!;
        if (rec.names.length < 1) {
          continue;
        }
        const recID = rec.names[0]!;
        if (recID.name === "_" || allow.test(recID.name)) {
          continue;
        }
        // Uses are told apart from shadowing names by their ast.Object.
        if (seekNode(decl.body, (n) => n.$type === "Ident" && n.obj === recID.obj) !== null) {
          continue;
        }
        failures.push({
          failure: `method receiver '${recID.name}' is not referenced in method's body, consider removing or renaming it ${suffix}`,
          node: recID,
          confidence: 1,
        });
      }
      return failures;
    },
  };
}
