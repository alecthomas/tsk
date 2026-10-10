import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer, type Pass, type SuggestedFix } from "tsk";
import { quote, unquote } from "./internal/strconv";
import { byteLength } from "./internal/utf8";

interface Config {
  /** Words to look for. Empty looks for any repeated word. */
  keywords: string[];
  /** Repeated words to allow. */
  ignore: string[];
  /** Check only comments, not string literals. */
  commentsOnly: boolean;
  /** Skip raw string literals. */
  skipRawStrings: boolean;
}

export default defineAnalyzer<Config>({
  name: "dupword",
  doc: `checks for duplicate words in the source code

Repeated words in comments and string literals, as in "the the", are usually
mistakes. Words starting with a digit, punctuation, or a symbol are allowed.`,
  config: { keywords: [], ignore: [], commentsOnly: false, skipRawStrings: false },
  runDespiteErrors: true,
  run(pass) {
    const checker = new Checker(pass);
    for (const file of pass.files) {
      checker.comments(file!);
    }
    if (pass.config.commentsOnly) {
      return;
    }
    for (const file of pass.files) {
      ast.inspect(file, (node) => {
        if (node?.$type === "BasicLit") {
          checker.literal(node);
        }
        return true;
      });
    }
  },
});

const commentPrefix = "//";
const exampleOutputs = ["// Output:", "// output:", "// Unordered output:", "// unordered output:"];

class Checker {
  private readonly ignore: Set<string>;

  constructor(private readonly pass: Pass<Config>) {
    this.ignore = new Set(pass.config.ignore);
  }

  comments(file: ast.File): void {
    const pass = this.pass;
    const isTest = pass.fset.file(file.fileStart)!.name().endsWith("_test.go");
    for (const group of file.comments) {
      const list = group!.list;
      // An example's expected output may repeat words.
      if (isTest && exampleOutputs.some((prefix) => list[0]!.text.startsWith(prefix))) {
        continue;
      }
      let previous: ast.Comment | null = null;
      for (const comment of list) {
        const c = comment!;
        const [update, keyword, found] = this.check(c.text);
        if (found) {
          pass.report({ pos: c.slash, end: c.end(), message: message(keyword), suggestedFixes: [fix(c.slash, c.end(), update)] });
        }
        if (previous !== null) {
          // A word may repeat across lines: the previous line's last word
          // and this line's first.
          const fields = goFields(previous.text);
          if (fields.length < 1) {
            continue;
          }
          const previousContent = `${fields[fields.length - 1]}\n`;
          const thisContent = found ? update : c.text;
          const cut = thisContent.indexOf(commentPrefix);
          const before = cut < 0 ? thisContent : thisContent.slice(0, cut);
          const after = cut < 0 ? "" : thisContent.slice(cut + commentPrefix.length);
          const [joined, joinedKeyword, joinedFound] = this.check(previousContent + after);
          if (joinedFound) {
            const fixes: SuggestedFix[] = [];
            if (joined.includes(previousContent)) {
              const text = before + commentPrefix + (joined.startsWith(previousContent) ? joined.slice(previousContent.length) : joined);
              fixes.push(fix(c.slash, c.end(), text));
            }
            pass.report({ pos: c.slash, end: c.end(), message: message(joinedKeyword), suggestedFixes: fixes });
          }
        }
        previous = c;
      }
    }
  }

  literal(lit: ast.BasicLit): void {
    if (lit.kind !== token.STRING) {
      return;
    }
    const raw = lit.value.startsWith("`");
    if (this.pass.config.skipRawStrings && raw) {
      return;
    }
    const value = unquote(lit.value) ?? lit.value;
    let [update, keyword, found] = this.check(value);
    if (value !== lit.value) {
      update = raw ? `\`${update}\`` : quote(update);
    }
    if (found) {
      this.pass.report({ pos: lit.pos(), end: lit.end(), message: message(keyword), suggestedFixes: [fix(lit.pos(), lit.end(), update)] });
    }
  }

  // check removes repeats of each keyword in turn, or of any word without
  // keywords, returning the updated text and the words found.
  check(raw: string): [string, string, boolean] {
    const keywords = this.pass.config.keywords;
    if (keywords.length === 0) {
      return this.checkOneKey(raw, "");
    }
    let text = raw;
    let update = "";
    let keyword = "";
    let found = false;
    for (const key of keywords) {
      const [updated, , foundOne] = this.checkOneKey(text, key);
      if (foundOne) {
        text = updated;
        update = updated;
        found = true;
        keyword = keyword === "" ? key : `${keyword},${key}`;
      }
    }
    return [update, keyword, found];
  }

  // checkOneKey removes a word repeated after whitespace, keeping the first
  // whitespace between them. Its indexes follow upstream's byte offsets
  // where they decide what is checked.
  private checkOneKey(raw: string, key: string): [string, string, boolean] {
    if (key === "") {
      const fields = goFields(raw);
      if (!fields.some((field, i) => i < fields.length - 1 && field === fields[i + 1])) {
        return ["", "", false];
      }
    } else if (raw.split(key).length < 2) {
      return ["", "", false];
    }
    const matches = (word: string) => (key === "" || word === key) && !this.excluded(cutTrailingComma(word));
    const foundWords = new Set<string>();
    let out = "";
    let wordStart = 0;
    let spaceStart = 0;
    let curWord = "";
    let preWord = "";
    let lastSpace = "";
    let lastRune = 0;
    const lastByte = byteLength(raw) - 1;
    let byteIndex = 0;
    for (let i = 0; i < raw.length; ) {
      const r = raw.codePointAt(i)!;
      if (!isSpace(r) && isSpace(lastRune)) {
        let symbol = raw.slice(spaceStart, i);
        if ((key === "" || curWord === key) && curWord === preWord && curWord !== "") {
          // An allowed repeat is left out of the update, as upstream does.
          if (matches(curWord)) {
            foundWords.add(curWord);
            out += lastSpace;
            symbol = "";
          }
        } else {
          out += lastSpace + curWord;
        }
        lastSpace = symbol;
        preWord = curWord;
        wordStart = i;
      } else if (isSpace(r) && !isSpace(lastRune)) {
        spaceStart = i;
        curWord = raw.slice(wordStart, i);
      } else if (byteIndex === lastByte && !isSpace(r)) {
        // Upstream compares a byte offset, so this runs only when the text
        // ends in a one-byte character.
        const word = raw.slice(wordStart);
        if ((key === "" || word === key) && word === preWord) {
          if (matches(word)) {
            foundWords.add(word);
          }
        } else {
          out += lastSpace + word;
        }
      }
      lastRune = r;
      i += r > 0xffff ? 2 : 1;
      byteIndex += byteLength(String.fromCodePoint(r));
    }
    // Upstream reads the last byte as a rune, so a final multi-byte character
    // whose last byte is 0x85 or 0xa0 also counts as a space.
    if (raw.length > 0 && isSpace(lastByteOf(raw))) {
      if (curWord !== "") {
        if ((key === "" || curWord === key) && curWord === preWord && matches(curWord)) {
          foundWords.add(curWord);
        } else {
          out += lastSpace + curWord;
        }
      }
      out += raw.slice(spaceStart);
    }
    if (foundWords.size === 0) {
      return ["", "", false];
    }
    return [out, [...foundWords].sort().join(","), true];
  }

  // excluded allows words starting with a digit, punctuation, or a symbol,
  // and ignored words.
  private excluded(word: string): boolean {
    const first = word.length === 0 ? "�" : String.fromCodePoint(word.codePointAt(0)!);
    return /^[\p{Nd}\p{P}\p{S}]$/u.test(first) || this.ignore.has(word);
  }
}

function message(keyword: string): string {
  return `Duplicate words (${keyword}) found`;
}

function fix(pos: token.Pos, end: token.Pos, newText: string): SuggestedFix {
  return { message: "Update", textEdits: [{ pos, end, newText }] };
}

function cutTrailingComma(word: string): string {
  return word.endsWith(",") ? word.slice(0, -1) : word;
}

// isSpace is unicode.IsSpace, which differs from JavaScript's \s.
function isSpace(r: number): boolean {
  switch (r) {
    case 0x09:
    case 0x0a:
    case 0x0b:
    case 0x0c:
    case 0x0d:
    case 0x20:
    case 0x85:
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
      return true;
  }
  return r >= 0x2000 && r <= 0x200a;
}

// goFields is strings.Fields.
function goFields(s: string): string[] {
  const fields: string[] = [];
  let field = "";
  for (const char of s) {
    if (isSpace(char.codePointAt(0)!)) {
      if (field !== "") {
        fields.push(field);
        field = "";
      }
    } else {
      field += char;
    }
  }
  if (field !== "") {
    fields.push(field);
  }
  return fields;
}

// lastByteOf returns the last byte of a string's UTF-8 encoding.
function lastByteOf(s: string): number {
  const chars = [...s];
  const r = chars[chars.length - 1]!.codePointAt(0)!;
  return r < 0x80 ? r : 0x80 | (r & 0x3f);
}
