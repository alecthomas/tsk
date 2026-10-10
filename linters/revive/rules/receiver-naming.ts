import type * as ast from "go/ast";
import { receiverType } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "receiver-naming";

export interface Options {
  /** The longest receiver name allowed, in characters; 0 or less allows any. */
  maxLength: number;
}

export const defaults: Options = { maxLength: -1 };

export function create(options: DeepReadonly<Options>): Rule {
  if (!Number.isInteger(options.maxLength)) {
    throw new Error(`invalid value ${options.maxLength} for argument maxLength of rule receiver-naming, expected integer value got float64`);
  }
  return {
    name,
    apply(file: File): Failure[] {
      const typeReceiver = new Map<string, string>();
      const failures: Failure[] = [];
      for (const decl of file.ast.decls) {
        if (decl!.$type !== "FuncDecl") {
          continue;
        }
        const fn = decl as ast.FuncDecl;
        if (fn.recv === null || fn.recv.list.length === 0) {
          continue;
        }
        const names = fn.recv.list[0]!.names;
        if (names.length < 1) {
          continue;
        }
        const recvName = names[0]!.name;
        const fail = (failure: string): void => {
          failures.push({ failure, confidence: 1, node: fn });
        };
        if (recvName === "_") {
          fail("receiver name should not be an underscore, omit the name if it is unused");
          continue;
        }
        if (recvName === "this" || recvName === "self") {
          fail(`receiver name should be a reflection of its identity; don't use generic names such as "this" or "self"`);
          continue;
        }
        if (options.maxLength > 0 && [...recvName].length > options.maxLength) {
          fail(`receiver name ${recvName} is longer than ${options.maxLength} characters`);
          continue;
        }
        const recv = receiverType(fn);
        const prev = typeReceiver.get(recv);
        if (prev !== undefined && prev !== recvName) {
          fail(`receiver name ${recvName} should be consistent with previous receiver name ${prev} for ${recv}`);
          continue;
        }
        typeReceiver.set(recv, recvName);
      }
      return failures;
    },
  };
}
