// Port of golang.org/x/tools/go/analysis/passes/structtag at v0.50.0.
import * as ast from "go/ast";
import type * as token from "go/token";
import type * as types from "go/types";
import * as filepath from "path/filepath";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { quote, unquote } from "./internal/strconv";
import { byteLength } from "./internal/utf8";

// NamesSeen maps encoding tags, by key, name and anonymous struct nesting
// level, to their positions. Equal names conflict only at the same level.
type NamesSeen = Map<string, token.Pos>;

const checkTagDups = ["json", "xml"];
const checkTagSpaces = new Set(["json", "xml", "asn1"]);

export default defineAnalyzer({
  name: "structtag",
  doc: `check that struct field tags conform to reflect.StructTag.Get

Also report certain struct tags (json, xml) used with unexported fields.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/structtag",
  group: "govet",
  requires: [inspect],
  runDespiteErrors: true,
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.StructType)) {
      const styp = pass.typesInfo.types.get(cursor.node() as ast.StructType)?.type;
      // Type information may be incomplete.
      if (styp?.$type !== "Struct") {
        continue;
      }
      const seen: NamesSeen = new Map();
      for (let i = 0; i < styp.numFields(); i++) {
        checkCanonicalFieldTag(pass, styp.field(i)!, styp.tag(i), seen);
      }
    }
  },
});

function reportField(pass: Pass<unknown>, field: types.Var, message: string): void {
  pass.report({ pos: field.pos(), end: field.pos() + byteLength(field.name()), message });
}

function checkCanonicalFieldTag(pass: Pass<unknown>, field: types.Var, tag: string, seen: NamesSeen): void {
  // These packages know how to use their own APIs, and sometimes test
  // incorrect programs.
  if (pass.pkg.path().startsWith("encoding/")) {
    return;
  }
  for (const key of checkTagDups) {
    checkTagDuplicates(pass, tag, key, field, field, seen, 1);
  }
  const err = validateStructTag(tag);
  if (err !== null) {
    reportField(pass, field, `struct field tag ${backquote(tag)} not compatible with reflect.StructTag.Get: ${err}`);
  }
  // Check for json or xml tags on unexported, non-embedded fields.
  if (field.anonymous() || field.exported()) {
    return;
  }
  for (const enc of ["json", "xml"]) {
    const value = lookupTag(tag, enc) ?? "";
    if (value !== "" && value !== "-") {
      reportField(pass, field, `struct field ${field.name()} has ${enc} tag but is not exported`);
      return;
    }
  }
}

// checkTagDuplicates checks whether a field's tag duplicates another's.
// nearest is the closest field that is part of the top-level struct type.
function checkTagDuplicates(pass: Pass<unknown>, tag: string, key: string, nearest: types.Var, field: types.Var, seen: NamesSeen, level: number): void {
  let val = lookupTag(tag, key) ?? "";
  if (val === "-") {
    return;
  }
  if (val === "" || val[0] === ",") {
    if (!field.anonymous()) {
      return;
    }
    const typ = field.type()!.underlying();
    if (typ?.$type !== "Struct") {
      return;
    }
    for (let i = 0; i < typ.numFields(); i++) {
      const embedded = typ.field(i)!;
      if (embedded.exported()) {
        checkTagDuplicates(pass, typ.tag(i), key, nearest, embedded, seen, level + 1);
      }
    }
    return;
  }
  // XMLName names the element itself, so it cannot collide with other fields.
  if (key === "xml" && field.name() === "XMLName") {
    return;
  }
  const comma = val.indexOf(",");
  if (comma >= 0) {
    // XML attributes have their own namespace.
    if (key === "xml" && val.slice(comma).split(",").includes("attr")) {
      key += " attribute";
    }
    val = val.slice(0, comma);
  }
  const id = JSON.stringify([key, val, level]);
  const pos = seen.get(id);
  if (pos === undefined) {
    seen.set(id, field.pos());
    return;
  }
  // The "also at" position is relative to this field's, as the fields may be
  // in different directories.
  const alsoPos = pass.fset.position(pos);
  let filename = alsoPos.filename;
  try {
    filename = filepath.rel(filepath.dir(pass.fset.position(field.pos()).filename), filename);
  } catch {
    // Leave the filename alone, as upstream does.
  }
  const also = positionString(filename, alsoPos.line);
  pass.report({
    pos: nearest.pos(),
    end: nearest.pos() + byteLength(nearest.name()),
    message: `struct field ${field.name()} repeats ${key} tag ${quote(val)} also at ${also}`,
  });
}

// positionString formats a position without a column, as token.Position does.
function positionString(filename: string, line: number): string {
  if (line <= 0) {
    return filename === "" ? "-" : filename;
  }
  return filename === "" ? `${line}` : `${filename}:${line}`;
}

// backquote formats s as Go's %#q does.
function backquote(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strconv.CanBackquote rejects control characters other than tab.
  return /[`\x00-\x08\x0a-\x1f\x7f﻿�]/.test(s) ? quote(s) : `\`${s}\``;
}

// lookupTag returns the value of key in tag, as reflect.StructTag.Lookup does.
function lookupTag(tag: string, key: string): string | undefined {
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
    while (i < tag.length && tag[i] > " " && tag[i] !== ":" && tag[i] !== '"' && tag[i] !== "\x7f") {
      i++;
    }
    if (i === 0 || i + 1 >= tag.length || tag[i] !== ":" || tag[i + 1] !== '"') {
      break;
    }
    const name = tag.slice(0, i);
    tag = tag.slice(i + 1);
    i = 1;
    while (i < tag.length && tag[i] !== '"') {
      if (tag[i] === "\\") {
        i++;
      }
      i++;
    }
    if (i >= tag.length) {
      break;
    }
    const qvalue = tag.slice(0, i + 1);
    tag = tag.slice(i + 1);
    if (key === name) {
      return unquoteStrict(qvalue) ?? undefined;
    }
  }
  return undefined;
}

// validateStructTag returns an error message if tag is not a canonical
// space-separated list of key:"value" pairs, or null.
function validateStructTag(tag: string): string | null {
  for (let n = 0; tag !== ""; n++) {
    // More restrictive than reflect, catching mistakes like `x:"foo",y:"bar"`.
    if (n > 0 && tag[0] !== " ") {
      return 'key:"value" pairs not separated by spaces';
    }
    let i = 0;
    while (i < tag.length && tag[i] === " ") {
      i++;
    }
    tag = tag.slice(i);
    if (tag === "") {
      break;
    }
    // A space, quote or ASCII control character in a key is a syntax error.
    i = 0;
    while (i < tag.length && tag[i] > " " && tag[i] !== ":" && tag[i] !== '"' && tag[i] !== "\x7f") {
      i++;
    }
    if (i === 0) {
      return "bad syntax for struct tag key";
    }
    if (i + 1 >= tag.length || tag[i] !== ":") {
      return "bad syntax for struct tag pair";
    }
    if (tag[i + 1] !== '"') {
      return "bad syntax for struct tag value";
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
      return "bad syntax for struct tag value";
    }
    const qvalue = tag.slice(0, i + 1);
    tag = tag.slice(i + 1);
    let value = unquoteStrict(qvalue);
    if (value === null) {
      return "bad syntax for struct tag value";
    }
    if (!checkTagSpaces.has(key)) {
      continue;
    }
    if (key === "xml") {
      // Leading, trailing or multiple spaces are suspicious.
      if (value.replace(/^ +| +$/g, "") !== value || value.split(" ").length - 1 > 1) {
        return "suspicious space in struct tag value";
      }
      const comma = value.indexOf(",");
      if (comma < 0) {
        continue;
      }
      if (comma > 0 && value[comma - 1] === " ") {
        return "suspicious space in struct tag value";
      }
      value = value.slice(comma + 1);
    } else if (key === "json") {
      // JSON names may contain spaces.
      const comma = value.indexOf(",");
      if (comma < 0) {
        continue;
      }
      value = value.slice(comma + 1);
    }
    if (value.includes(" ")) {
      return "suspicious space in struct tag value";
    }
  }
  return null;
}

// unquoteStrict is strconv.Unquote for a double-quoted literal, rejecting
// invalid escapes and raw newlines, which the shared unquote accepts.
function unquoteStrict(qvalue: string): string | null {
  if (!/^"(?:[^"\\\n]|\\(?:[abfnrtv\\"]|x[0-9a-fA-F]{2}|[0-3][0-7]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}))*"$/.test(qvalue)) {
    return null;
  }
  return unquote(qvalue);
}
