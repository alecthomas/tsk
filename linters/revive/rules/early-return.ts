import { apply, type Chain, deviates, kindString, Target } from "../ifelse";
import type { DeepReadonly, File, Rule } from "../lint";

export const name = "early-return";

export interface Options {
  /** Do not suggest changes that would enlarge a variable's scope. */
  preserveScope: boolean;
  /** Suggest adding a jump, such as return or continue, to reduce nesting. */
  allowJump: boolean;
}

export const defaults: Options = { preserveScope: false, allowJump: false };

export function create(options: DeepReadonly<Options>): Rule {
  const check = (chain: Chain): string | undefined => {
    if (chain.hasElse) {
      if (!chain.else.deviates()) {
        return undefined;
      }
    } else if (!options.allowJump || !chain.atBlockEnd || !deviates(chain.blockEndKind) || chain.if.isShort()) {
      // Adding a jump only pays off when it outdents several statements.
      return undefined;
    }
    // Outdenting the block would let a prior branch flow into it.
    if (chain.hasPriorNonDeviating && !chain.if.isEmpty()) {
      return undefined;
    }
    // superfluous-else reports these.
    if (chain.hasElse && chain.if.deviates()) {
      return undefined;
    }
    if (options.preserveScope && !chain.atBlockEnd && (chain.hasInitializer || chain.if.hasDecls())) {
      return undefined;
    }
    if (!chain.hasElse) {
      return `if c { ... } can be rewritten if !c { ${kindString(chain.blockEndKind)} } ... to reduce nesting`;
    }
    const els = chain.else.toString();
    if (chain.if.isEmpty()) {
      return `if c { } else ${els} can be simplified to if !c ${els}`;
    }
    return `if c { ... } else ${els} can be simplified to if !c ${els} ...`;
  };
  return { name, apply: (file: File) => apply(check, file.ast, Target.If, options.allowJump) };
}
