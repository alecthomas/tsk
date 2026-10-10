import { apply, type Chain, Target } from "../ifelse";
import type { DeepReadonly, File, Rule } from "../lint";

export const name = "indent-error-flow";

export interface Options {
  /** Do not suggest changes that would enlarge a variable's scope. */
  preserveScope: boolean;
}

export const defaults: Options = { preserveScope: false };

export function create(options: DeepReadonly<Options>): Rule {
  const check = (chain: Chain): string | undefined => {
    if (!chain.hasElse || !chain.if.deviates()) {
      return undefined;
    }
    // Outdenting the else would let a prior branch flow into it.
    if (chain.hasPriorNonDeviating) {
      return undefined;
    }
    // superfluous-else reports these.
    if (!chain.if.returns()) {
      return undefined;
    }
    if (options.preserveScope && !chain.atBlockEnd && (chain.hasInitializer || chain.else.hasDecls())) {
      return undefined;
    }
    return "if block ends with a return statement, so drop this else and outdent its block";
  };
  return { name, apply: (file: File) => apply(check, file.ast, Target.Else, false) };
}
