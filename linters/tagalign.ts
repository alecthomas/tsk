import * as ast from "go/ast";
import { defineAnalyzer, type Pass } from "tsk";
import { quote, unquote } from "./internal/strconv";
import { byteLength } from "./internal/utf8";

interface Config {
  /** Align the tags of consecutive fields into columns. */
  align: boolean;
  /** Sort tags by key. */
  sort: boolean;
  /** Keys that sort first, in this order; implies sort. */
  order: readonly string[];
  /** Give every key its own column, leaving gaps; needs align and sort. */
  strict: boolean;
}

interface Tag {
  key: string;
  value: string;
}

const tagString = (t: Tag) => `${t.key}:${quote(t.value)}`;

const errTagValueSyntax = "bad syntax for struct tag value";

export default defineAnalyzer<Config>({
  name: "tagalign",
  doc: "check that struct tags are well aligned",
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: { align: true, sort: true, order: [], strict: false },
  run(pass) {
    const c = pass.config;
    const sort = c.sort || c.order.length > 0;
    if (!c.align && !sort) {
      return;
    }
    const strict = c.strict && c.align && c.sort;
    for (const file of pass.files) {
      if (!filename(pass, file!).endsWith(".go")) {
        continue;
      }
      const groups: ast.Field[][] = [];
      const singles: ast.Field[] = [];
      ast.inspect(file, (node) => {
        if (node?.$type === "StructType") {
          findGroups(pass, node, groups, singles);
        }
        return true;
      });
      for (const group of groups) {
        processGroup(pass, group, c.align, sort, c.order, strict);
      }
      for (const field of singles) {
        processSingle(pass, field, sort, c.order);
      }
    }
  },
});

function filename(pass: Pass<Config>, file: ast.File): string {
  const adjusted = pass.fset.positionFor(file.pos(), true).filename;
  return adjusted.endsWith(".go") ? adjusted : pass.fset.positionFor(file.pos(), false).filename;
}

// findGroups splits a struct's tagged fields into runs on consecutive lines.
// A field after an untagged one joins the current run regardless.
function findGroups(pass: Pass<Config>, st: ast.StructType, groups: ast.Field[][], singles: ast.Field[]): void {
  const fields = st.fields!.list as ast.Field[];
  let run: ast.Field[] = [];
  const split = () => {
    if (run.length > 1) {
      groups.push(run);
    } else if (run.length === 1) {
      singles.push(run[0]);
    }
    run = [];
  };
  fields.forEach((field, i) => {
    if (field.tag === null) {
      split();
      return;
    }
    if (i > 0) {
      const prev = fields[i - 1].tag;
      if (prev === null) {
        run.push(field);
        return;
      }
      if (pass.fset.position(field.tag.pos()).line - pass.fset.position(prev.pos()).line > 1) {
        split();
      }
    }
    run.push(field);
  });
  split();
}

function report(pass: Pass<Config>, field: ast.Field, message: string, newText: string): void {
  const tag = field.tag!;
  pass.report({
    pos: tag.pos(),
    end: tag.end(),
    message,
    suggestedFixes: [{ message, textEdits: [{ pos: tag.pos(), end: tag.end(), newText }] }],
  });
}

// parseTag parses a tag literal, reporting it if it is malformed.
function parseTag(pass: Pass<Config>, field: ast.Field): Tag[] | null {
  const text = unquote(field.tag!.value);
  if (text === null) {
    report(pass, field, errTagValueSyntax, field.tag!.value);
    return null;
  }
  const parsed = parseStructTag(text);
  if (typeof parsed === "string") {
    report(pass, field, parsed, field.tag!.value);
    return null;
  }
  return parsed;
}

function compareByOrder(order: readonly string[]): (a: string, b: string) => number {
  return (a, b) => {
    const oi = order.indexOf(a);
    const oj = order.indexOf(b);
    if (oi === -1 && oj === -1) {
      return a < b ? -1 : a > b ? 1 : 0;
    }
    if (oi === -1) {
      return 1;
    }
    if (oj === -1) {
      return -1;
    }
    return oi - oj;
  };
}

const sameTags = (a: readonly Tag[], b: readonly Tag[]) => a.length === b.length && a.every((t, i) => t.key === b[i].key && t.value === b[i].value);

// pad pads s with spaces to width runes, as fmt's %-Ns does.
const pad = (s: string, width: number) => s + " ".repeat(Math.max(0, width - [...s].length));

function processGroup(pass: Pass<Config>, group: ast.Field[], align: boolean, sort: boolean, order: readonly string[], strict: boolean): void {
  const fields: ast.Field[] = [];
  const tagsGroup: Tag[][] = [];
  const unsortedGroup: Tag[][] = [];
  const uniqueKeys: string[] = [];
  let maxTagNum = 0;
  for (const field of group) {
    const tags = parseTag(pass, field);
    if (tags === null) {
      continue;
    }
    maxTagNum = Math.max(maxTagNum, tags.length);
    if (sort) {
      unsortedGroup.push([...tags]);
      tags.sort((a, b) => compareByOrder(order)(a.key, b.key));
    }
    for (const t of tags) {
      if (!uniqueKeys.includes(t.key)) {
        uniqueKeys.push(t.key);
      }
    }
    fields.push(field);
    tagsGroup.push(tags);
  }
  if (sort && strict) {
    uniqueKeys.sort(compareByOrder(order));
    maxTagNum = uniqueKeys.length;
  }
  // The widest tag in each column, measured in bytes.
  const maxLens: { key: string; len: number }[] = [];
  for (let j = 0; j < maxTagNum; j++) {
    let maxLength = 0;
    const key = strict ? uniqueKeys[j] : "";
    for (const tags of tagsGroup) {
      const tag = strict ? tags.find((t) => t.key === key) : tags[j];
      if (tag !== undefined) {
        maxLength = Math.max(maxLength, byteLength(tagString(tag)));
      }
    }
    maxLens.push({ key, len: maxLength });
  }
  fields.forEach((field, i) => {
    const tags = tagsGroup[i];
    let newTag: string;
    if (align) {
      newTag = "";
      for (let t = 0, n = 0; t < tags.length && n < maxLens.length; n++) {
        // Strict style leaves a gap for each key a field lacks.
        if (strict && maxLens[n].key !== tags[t].key) {
          newTag += pad("", maxLens[n].len + 1);
          continue;
        }
        newTag += pad(tagString(tags[t]), maxLens[n].len + 1);
        t++;
      }
    } else {
      if (sort && sameTags(unsortedGroup[i], tags)) {
        return;
      }
      newTag = tags.map(tagString).join(" ");
    }
    const unquoted = newTag.replace(/ +$/, "");
    const newValue = `\`${unquoted}\``;
    if (field.tag!.value !== newValue) {
      report(pass, field, `tag is not aligned, should be: ${unquoted}`, newValue);
    }
  });
}

function processSingle(pass: Pass<Config>, field: ast.Field, sort: boolean, order: readonly string[]): void {
  const tags = parseTag(pass, field);
  if (tags === null) {
    return;
  }
  const original = [...tags];
  if (sort) {
    tags.sort((a, b) => compareByOrder(order)(a.key, b.key));
  }
  const joined = tags.map(tagString).join(" ");
  const newValue = `\`${joined}\``;
  if (sameTags(original, tags) && field.tag!.value === newValue) {
    return;
  }
  report(pass, field, `tag is not aligned , should be: ${joined}`, newValue);
}

// parseStructTag ports structtag.Parse, returning the error message for a
// malformed tag.
function parseStructTag(input: string): Tag[] | string {
  const tags: Tag[] = [];
  let tag = input;
  while (tag !== "") {
    let i = 0;
    while (i < tag.length && tag[i] === " ") {
      i++;
    }
    tag = tag.slice(i);
    if (tag === "") {
      break;
    }
    i = 0;
    while (i < tag.length && tag[i] > " " && tag[i] !== ":" && tag[i] !== '"' && tag.charCodeAt(i) !== 0x7f) {
      i++;
    }
    if (i === 0) {
      return "bad syntax for struct tag key";
    }
    if (i + 1 >= tag.length || tag[i] !== ":") {
      return "bad syntax for struct tag pair";
    }
    if (tag[i + 1] !== '"') {
      return errTagValueSyntax;
    }
    const key = tag.slice(0, i);
    tag = tag.slice(i + 1);
    i = 1;
    while (i < tag.length && tag[i] !== '"') {
      if (tag[i] === "\\") {
        i++;
      }
      i++;
    }
    if (i >= tag.length) {
      return errTagValueSyntax;
    }
    const value = unquote(tag.slice(0, i + 1));
    tag = tag.slice(i + 1);
    if (value === null) {
      return errTagValueSyntax;
    }
    tags.push({ key, value });
  }
  return tags;
}
