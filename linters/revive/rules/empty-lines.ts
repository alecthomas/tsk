import * as ast from "go/ast";
import type * as token from "go/token";
import type { Failure, File, Rule } from "../lint";

export const name = "empty-lines";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const comments = commentLines(file);
  const line = (pos: token.Pos): number => file.toPosition(pos).line;
  ast.inspect(file.ast, (n) => {
    if (n === null || n.$type !== "BlockStmt") {
      return true;
    }
    const block = n as ast.BlockStmt;
    if (block.list.length === 0) {
      return true;
    }
    const start = line(block.lbrace);
    if (line(block.list[0]!.pos()) - (start + 1) > 0 && !comments.has(start + 1)) {
      failures.push({ failure: "extra empty line at the start of a block", node: block, confidence: 1 });
    }
    const end = line(block.rbrace);
    if (end - 1 - line(block.list[block.list.length - 1]!.end()) > 0 && !comments.has(end - 1)) {
      failures.push({ failure: "extra empty line at the end of a block", node: block, confidence: 1 });
    }
    return true;
  });
  return failures;
}

// commentLines returns the lines that comments the comment map holds span.
function commentLines(file: File): Set<number> {
  const result = new Set<number>();
  for (const [, groups] of file.commentMap()) {
    for (const group of groups) {
      const last = file.toPosition(group!.end()).line;
      for (let i = file.toPosition(group!.pos()).line; i <= last; i++) {
        result.add(i);
      }
    }
  }
  return result;
}
