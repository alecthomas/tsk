import type * as ast from "go/ast";
import { defineAnalyzer } from "tsk";
import { quote } from "./internal/strconv";
import { byteLength } from "./internal/utf8";

interface Config {
  /** Keywords to report; an empty list means TODO, BUG and FIXME. */
  keywords: readonly string[];
}

const defaultKeywords = ["TODO", "BUG", "FIXME"];

export default defineAnalyzer<Config>({
  name: "godox",
  doc: "Detects usage of FIXME, TODO and other keywords inside comments",
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: { keywords: [] },
  run(pass) {
    const keywords = pass.config.keywords.length === 0 ? defaultKeywords : pass.config.keywords;
    for (const file of pass.files) {
      if (!pass.fset.position(file!.pos()).filename.endsWith(".go")) {
        continue;
      }
      for (const group of file!.comments) {
        for (const comment of group!.list) {
          for (const message of messages(comment!, keywords)) {
            // Upstream reports every line of a comment one byte past its start.
            pass.report({ pos: comment!.pos() + 1, message });
          }
        }
      }
    }
  },
});

function messages(comment: ast.Comment, keywords: readonly string[]): string[] {
  const found: string[] = [];
  for (const raw of extractComment(comment.text).split("\n")) {
    // Lines are trimmed like Go's bytes.TrimSpace.
    const line = raw.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, "");
    if (byteLength(line) < 4) {
      continue;
    }
    const keyword = keywords.find((kw) => line.slice(0, kw.length).toUpperCase() === kw.toUpperCase() && !hasAlphanumRuneAdjacent(line.slice(kw.length)));
    if (keyword === undefined) {
      continue;
    }
    // Upstream truncates to 40 runes once the line passes 40 bytes.
    const shown = byteLength(line) > 40 ? `${[...line].slice(0, 40).join("")}...` : line;
    found.push(`Line contains ${keywords.join("/")}: ${quote(shown)}`);
  }
  return found;
}

function extractComment(text: string): string {
  if (text[1] === "/") {
    return text.slice(2).replace(/^ /, "");
  }
  return text[1] === "*" ? text.slice(2, -2) : text;
}

function hasAlphanumRuneAdjacent(rest: string): boolean {
  if (rest === "" || rest[0] === ":" || rest[0] === " " || rest[0] === "(") {
    return false;
  }
  return /^[\p{L}\p{N}]/u.test(rest);
}
