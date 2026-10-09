import * as ast from "go/ast";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Check decoding methods such as UnmarshalJSON too, which usually mix receivers. */
  disableBuiltin: boolean;
  /** Methods to skip, as "Type.Method" or "*.Method". */
  exclusions: string[];
}

const builtinExclusions = ["*.UnmarshalText", "*.UnmarshalJSON", "*.UnmarshalYAML", "*.UnmarshalXML", "*.UnmarshalBinary", "*.GobDecode"];

export default defineAnalyzer<Config>({
  name: "recvcheck",
  doc: "checks for receiver type consistency",
  requires: [inspect],
  config: { disableBuiltin: false, exclusions: [] },
  run(pass) {
    const excluded = new Set([...(pass.config.disableBuiltin ? [] : builtinExclusions), ...pass.config.exclusions]);
    // receivers maps each type name to whether it has pointer and value receivers.
    const receivers = new Map<string, { pointer: boolean; value: boolean }>();
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.FuncDecl)) {
      const fn = cursor.node() as ast.FuncDecl;
      if (fn.recv?.list.length !== 1) {
        continue;
      }
      const recvType = fn.recv.list[0]!.type;
      // Generic receivers, such as *T[K], are not matched.
      const pointer = recvType?.$type === "StarExpr";
      const ident = pointer ? recvType.x : recvType;
      const method = fn.name!.name;
      if (ident?.$type !== "Ident" || method === "" || excluded.has(`${ident.name}.${method}`) || excluded.has(`*.${method}`)) {
        continue;
      }
      const used = receivers.get(ident.name) ?? { pointer: false, value: false };
      used[pointer ? "pointer" : "value"] = true;
      receivers.set(ident.name, used);
    }
    for (const [name, used] of receivers) {
      const decl = pass.pkg.scope()!.lookup(name);
      if (used.pointer && used.value && decl !== null) {
        pass.report({ pos: decl.pos(), message: `the methods of ${JSON.stringify(name)} use pointer receiver and non-pointer receiver.` });
      }
    }
  },
});
