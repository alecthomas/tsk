import { defineAnalyzer } from "tsk";
import { runRule } from "../lint";
import type { Failure, File, Rule } from "../lint";

export const name = "duplicated-imports";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const paths = new Set<string>();
  for (const imp of file.ast.imports) {
    const path = imp!.path!.value;
    if (paths.has(path)) {
      failures.push({ node: imp!, confidence: 1, failure: `Package ${path} already imported` });
      continue;
    }
    paths.add(path);
  }
  return failures;
}

export default defineAnalyzer({
  name: "duplicated_imports",
  doc: "Looks for packages that are imported two or more times",
  group: "revive",
  enabledByDefault: false,
  runDespiteErrors: true,
  run(pass) {
    runRule(pass, create());
  },
});
