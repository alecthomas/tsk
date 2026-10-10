import * as ast from "go/ast";
import * as token from "go/token";
import { unquote } from "../../internal/strconv";
import type { Failure, File, Rule } from "../lint";

export const name = "unsecure-url-scheme";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  if (file.isTest()) {
    return [];
  }
  const failures: Failure[] = [];
  ast.inspect(file.ast, (node) => {
    if (node !== null && node.$type === "BasicLit" && (node as ast.BasicLit).kind === token.STRING) {
      check(node as ast.BasicLit, failures);
    }
    return true;
  });
  return failures;
}

function check(lit: ast.BasicLit, failures: Failure[]): void {
  const value = unquote(lit.value) ?? "";
  let scheme: string;
  if (value.startsWith("http://")) {
    scheme = "http";
  } else if (value.startsWith("ws://")) {
    scheme = "ws";
  } else {
    return;
  }
  // Go's len counts bytes, but any host part makes the string longer either way.
  if (value.length <= scheme.length + "://".length) {
    return;
  }
  if (["localhost", "127.0.0.1", "0.0.0.0", "//::"].some((local) => value.includes(local))) {
    return;
  }
  failures.push({ node: lit, confidence: 1, failure: `prefer secure protocol ${scheme}s over ${scheme} in ${lit.value}` });
}
