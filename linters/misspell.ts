import type * as ast from "go/ast";
import type * as token from "go/token";
import { defineAnalyzer, type Pass } from "tsk";
import { type Diff, fromBytes, Replacer, toBytes } from "./misspell/replacer";
import { american, british, main } from "./misspell/words";

interface ExtraWord {
  /** The misspelling. */
  typo: string;
  /** Its correction. */
  correction: string;
}

interface Config {
  /** US or UK to also correct the other locale's spellings; empty is neutral. */
  locale: string;
  /** Misspellings not to report. */
  ignoreRules: string[];
  /** "restricted" checks only comments; "" or "default" checks all text. */
  mode: string;
  /** More misspellings to correct. */
  extraWords: ExtraWord[];
}

export default defineAnalyzer<Config>({
  name: "misspell",
  doc: `finds commonly misspelled English words

Words are checked in comments, strings, and identifiers, or only in comments
in restricted mode. Words in URLs, paths, emails, and host names are skipped.`,
  config: { locale: "", ignoreRules: [], mode: "", extraWords: [] },
  runDespiteErrors: true,
  run(pass) {
    const replacer = replacerFor(pass.config);
    const restricted = pass.config.mode === "restricted";
    for (const file of pass.files) {
      const tokenFile = pass.fset.file(file!.fileStart)!;
      const content = toBytes(pass.readFile(tokenFile.name()));
      const lines = splitAfter(content);
      const changed = restricted ? commentLines(replacer, tokenFile, file!.comments) : null;
      const diffs: Diff[] = [];
      lines.forEach((line, i) => {
        if (changed === null ? replacer.replace(line) !== line : changed.has(i)) {
          replacer.recheckLine(line, i + 1, diffs);
        }
      });
      for (const diff of diffs) {
        const pos = tokenFile.lineStart(diff.line) + diff.column;
        const original = fromBytes(diff.original);
        const corrected = fromBytes(diff.corrected);
        pass.report({
          pos,
          end: pos + diff.original.length,
          message: `\`${original}\` is a misspelling of \`${corrected}\``,
          suggestedFixes: [
            { message: `Replace \`${original}\` with \`${corrected}\``, textEdits: [{ pos, end: pos + diff.original.length, newText: corrected }] },
          ],
        });
      }
    }
  },
});

// replacers caches each runtime's replacer by config, which is costly to
// build and the same for every package. It holds nothing read from files.
const replacers = new Map<string, Replacer>();

function replacerFor(config: Pass<Config>["config"]): Replacer {
  const key = JSON.stringify(config);
  let replacer = replacers.get(key);
  if (replacer === undefined) {
    replacer = newReplacer(config);
    replacers.set(key, replacer);
  }
  return replacer;
}

// newReplacer builds the word list: the main one, the locale's, less the
// ignored misspellings, then the extra words.
function newReplacer(config: Pass<Config>["config"]): Replacer {
  let words = parse(main);
  switch (config.locale.toUpperCase()) {
    case "":
      break;
    case "US":
      words.push(...parse(american));
      break;
    case "UK":
      words.push(...parse(british));
      break;
    default:
      throw new Error(`unknown locale: ${config.locale}`);
  }
  const ignored = config.ignoreRules.map((rule) => rule.toLowerCase());
  words = words.filter(([typo]) => !ignored.includes(fromBytes(typo).toLowerCase()));
  for (const extra of config.extraWords) {
    words.push([toBytes(extra.typo.toLowerCase()), toBytes(extra.correction.toLowerCase())]);
  }
  return new Replacer(words);
}

function parse(list: string): [string, string][] {
  return list
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [typo, correction] = line.split("\t");
      return [toBytes(typo!), toBytes(correction!)];
    });
}

// splitAfter splits text after each newline, as strings.SplitAfter does.
function splitAfter(s: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", start)) {
    lines.push(s.slice(start, i + 1));
    start = i + 1;
  }
  lines.push(s.slice(start));
  return lines;
}

// commentLines returns the indexes of lines whose comments hold a
// misspelling. Upstream rechecks those whole lines, code included.
function commentLines(replacer: Replacer, tokenFile: token.File, comments: readonly (ast.CommentGroup | null)[]): Set<number> {
  const changed = new Set<number>();
  for (const group of comments) {
    for (const comment of group!.list) {
      const text = toBytes(comment!.text);
      const corrected = replacer.replace(text);
      if (corrected === text) {
        continue;
      }
      const start = tokenFile.line(comment!.slash) - 1;
      const updated = corrected.split("\n");
      text.split("\n").forEach((line, i) => {
        if (line !== updated[i]) {
          changed.add(start + i);
        }
      });
    }
  }
  return changed;
}
