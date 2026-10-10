import * as ast from "go/ast";
import { goFmt, walk } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";
import { parseTags, type Tag } from "../structtag";

export const name = "struct-tag";

export interface Options {
  /** Options to accept beyond the known ones, by tag key, such as json = ["inline"]. */
  userDefinedOptions: Record<string, string[]>;
  /** Tag keys, such as "validate", whose tags are not checked. */
  omittedTags: string[];
}

export const defaults: Options = { userDefinedOptions: {}, omittedTags: [] };

interface CheckContext {
  userDefined: DeepReadonly<Record<string, string[]>>;
  usedTagNbr: Set<string>;
  usedTagName: Set<string>;
  commonOptions: Set<string>;
  isAtLeastGo124: boolean;
}

type TagChecker = (ctx: CheckContext, tag: Tag, field: ast.Field) => string | null;

const msgUnknownOption = (opt: string) => `unknown option ${goQuote(opt)}`;
const msgDuplicatedOption = (opt: string) => `duplicated option ${goQuote(opt)}`;
const msgDuplicatedTagNumber = (n: bigint) => `duplicated tag number ${n}`;
const msgTypeMismatch = "type mismatch between field type and default value type";

const structTagCodecSpecialField = "_struct";

// tagKeyToSpecialField maps tag keys to the field names with special meaning to them.
const tagKeyToSpecialField = new Map([["codec", structTagCodecSpecialField]]);

export function create(options: DeepReadonly<Options>): Rule {
  const omitted = new Set(options.omittedTags);
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      const isAtLeastGo124 = file.pkg.isAtLeastGoVersion("1.24");
      walk(
        {
          visit(node) {
            if (node === null || node.$type !== "StructType") {
              return this;
            }
            const st = node as ast.StructType;
            if (st.fields === null || numFields(st.fields) < 1) {
              return null;
            }
            const ctx: CheckContext = {
              userDefined: options.userDefinedOptions,
              usedTagNbr: new Set(),
              usedTagName: new Set(),
              commonOptions: new Set(),
              isAtLeastGo124,
            };
            for (const f of st.fields.list) {
              if (f!.tag !== null) {
                checkTaggedField(ctx, f!, omitted, failures);
              }
            }
            return this;
          },
        },
        file.ast,
      );
      return failures;
    },
  };
}

function numFields(fields: ast.FieldList): number {
  return fields.list.reduce((n, f) => n + Math.max(f!.names.length, 1), 0);
}

function checkTaggedField(ctx: CheckContext, field: ast.Field, omitted: Set<string>, failures: Failure[]): void {
  const tagLit = field.tag!;
  const tags = parseTags(tagLit.value.replace(/^`+|`+$/g, ""));
  if (tags === null) {
    failures.push({ node: tagLit, failure: "malformed tag", confidence: 1 });
    return;
  }
  const report = (msg: string | null, key: string) => {
    if (msg !== null) {
      failures.push({ node: tagLit, failure: `${msg} in ${key} tag`, confidence: 1 });
    }
  };
  const analyzedTags = new Set<string>();
  for (const tag of tags) {
    if (omitted.has(tag.key)) {
      continue;
    }
    report(checkTagNameIfNeed(ctx, tag), tag.key);
    report(checkOptionsOnIgnoredField(tag), tag.key);
    const checker = tagCheckers.get(tag.key);
    if (checker === undefined) {
      continue;
    }
    report(checker(ctx, tag, field), tag.key);
    analyzedTags.add(tag.key);
  }
  if (shallWarnOnUnexportedField(field.names, analyzedTags)) {
    failures.push({ node: field, failure: `tag on not-exported field ${field.names[0]!.name}`, confidence: 1 });
  }
}

function shallWarnOnUnexportedField(fieldNames: readonly (ast.Ident | null)[], tags: Set<string>): boolean {
  if (fieldNames.length !== 1) {
    return false;
  }
  const fieldName = fieldNames[0]!.name;
  if (ast.isExported(fieldName)) {
    return false;
  }
  return ![...tags].some((key) => tagKeyToSpecialField.get(key) === fieldName);
}

const keysCheckedForDuplicates = new Set(["bson", "codec", "json", "protobuf", "spanner", "xml", "yaml"]);

function checkTagNameIfNeed(ctx: CheckContext, tag: Tag): string | null {
  if (tag.name === "" || tag.name === "-" || !keysCheckedForDuplicates.has(tag.key)) {
    return null;
  }
  const tagName = getTagName(tag);
  if (tagName === "") {
    return null;
  }
  // Keying by tag key and name allows the same name in different tag keys.
  const mapKey = `${tag.key}:${tagName}`;
  if (ctx.usedTagName.has(mapKey)) {
    return `duplicated tag name ${goQuote(tagName)}`;
  }
  ctx.usedTagName.add(mapKey);
  return null;
}

function getTagName(tag: Tag): string {
  if (tag.key !== "protobuf") {
    return tag.name;
  }
  for (const option of tag.options) {
    if (option.startsWith("name=")) {
      return option.slice("name=".length);
    }
  }
  return "";
}

function isUserDefined(ctx: CheckContext, key: string, opt: string): boolean {
  const options = ctx.userDefined[key];
  return options !== undefined && options.includes(opt);
}

// checkKnownOptions accepts known options and those the user defined for key.
function checkKnownOptions(key: string, known: string[]): TagChecker {
  const knownSet = new Set(known);
  return (ctx, tag) => {
    for (const opt of tag.options) {
      if (!knownSet.has(opt) && !isUserDefined(ctx, key, opt)) {
        return msgUnknownOption(opt);
      }
    }
    return null;
  };
}

function cut(s: string, sep: string): [string, string, boolean] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, "", false] : [s.slice(0, i), s.slice(i + sep.length), true];
}

// atoi parses as strconv.Atoi does, returning null on error.
function atoi(s: string): bigint | null {
  if (!/^[+-]?[0-9]+$/.test(s)) {
    return null;
  }
  const n = BigInt(s);
  return n < -9223372036854775808n || n > 9223372036854775807n ? null : n;
}

const asn1Simple = new Set(["application", "explicit", "generalized", "ia5", "omitempty", "optional", "set", "utf8"]);

function checkASN1Tag(ctx: CheckContext, tag: Tag, field: ast.Field): string | null {
  for (const opt of [...tag.options, tag.name]) {
    if (asn1Simple.has(opt)) {
      continue;
    }
    const msg = checkCompoundASN1Option(ctx, opt, field.type!);
    if (msg !== null) {
      return msg;
    }
  }
  return null;
}

function checkCompoundASN1Option(ctx: CheckContext, opt: string, fieldType: ast.Expr): string | null {
  const [key, value] = cut(opt, ":");
  switch (key) {
    case "tag": {
      const number = atoi(value);
      if (number === null) {
        return `tag must be a number but is ${goQuote(value)}`;
      }
      if (ctx.usedTagNbr.has(`${number}`)) {
        return msgDuplicatedTagNumber(number);
      }
      ctx.usedTagNbr.add(`${number}`);
      return null;
    }
    case "default":
      return typeValueMatch(fieldType, value) ? null : msgTypeMismatch;
    default:
      return isUserDefined(ctx, "asn1", opt) ? null : msgUnknownOption(opt);
  }
}

function checkDefaultTag(_ctx: CheckContext, tag: Tag, field: ast.Field): string | null {
  return typeValueMatch(field.type!, tag.name) ? null : msgTypeMismatch;
}

function checkCborTag(ctx: CheckContext, tag: Tag): string | null {
  let hasToArray = false;
  let hasOmitEmptyOrZero = false;
  let hasKeyAsInt = false;
  for (const opt of tag.options) {
    switch (opt) {
      case "omitempty":
      case "omitzero":
        hasOmitEmptyOrZero = true;
        break;
      case "toarray":
        if (tag.name !== "") {
          return `tag name for option "toarray" should be empty`;
        }
        hasToArray = true;
        break;
      case "keyasint": {
        const intKey = atoi(tag.name);
        if (intKey === null) {
          return `tag name for option "keyasint" should be an integer`;
        }
        if (ctx.usedTagNbr.has(`${intKey}`)) {
          return `duplicated integer key ${intKey}`;
        }
        ctx.usedTagNbr.add(`${intKey}`);
        hasKeyAsInt = true;
        break;
      }
      default:
        if (!isUserDefined(ctx, "cbor", opt)) {
          return msgUnknownOption(opt);
        }
    }
  }
  if (tag.name !== "") {
    if (ctx.usedTagName.has(tag.name)) {
      return `duplicated tag name ${tag.name}`;
    }
    ctx.usedTagName.add(tag.name);
  }
  if (!hasKeyAsInt && atoi(tag.name) !== null) {
    return `integer tag names are only allowed in presence of "keyasint" option`;
  }
  if (hasToArray && hasOmitEmptyOrZero) {
    return `options "omitempty" and "omitzero" are ignored in presence of "toarray" option`;
  }
  return null;
}

const codecKnown = new Set(["omitempty", "toarray", "int", "uint", "float", "-", "omitemptyarray"]);

function checkCodecTag(ctx: CheckContext, tag: Tag, field: ast.Field): string | null {
  // See https://github.com/mgechev/revive/issues/1477#issuecomment-3191493076.
  const mustAddToCommonOptions = field.names.length === 1 && field.names[0]!.name === structTagCodecSpecialField;
  for (const opt of tag.options) {
    if (mustAddToCommonOptions) {
      ctx.commonOptions.add(opt);
    } else if (ctx.commonOptions.has(opt)) {
      return `redundant option ${goQuote(opt)}, already set for all fields`;
    }
    if (!codecKnown.has(opt) && !isUserDefined(ctx, "codec", opt)) {
      return msgUnknownOption(opt);
    }
  }
  return null;
}

function checkJSONTag(ctx: CheckContext, tag: Tag): string | null {
  for (const opt of tag.options) {
    switch (opt) {
      case "omitempty":
      case "string":
        break;
      case "":
        // A tag name of "-" may have an empty option: `json:"-,"` names the field "-".
        if (tag.name !== "-") {
          return "option can not be empty";
        }
        break;
      case "omitzero":
        if (!ctx.isAtLeastGo124) {
          return `prior Go 1.24, option "omitzero" is unsupported`;
        }
        break;
      default:
        if (!isUserDefined(ctx, "json", opt)) {
          return msgUnknownOption(opt);
        }
    }
  }
  return null;
}

function checkPropertiesTag(_ctx: CheckContext, tag: Tag, field: ast.Field): string | null {
  const seenOptions = new Set<string>();
  for (const opt of tag.options) {
    const [key, value, found] = cut(opt, "=");
    if (!found) {
      return `unknown or malformed option ${goQuote(opt)}`;
    }
    const msg = checkCompoundPropertiesOption(key, value, field.type!, seenOptions);
    if (msg !== null) {
      return msg;
    }
  }
  return null;
}

function checkCompoundPropertiesOption(key: string, value: string, fieldType: ast.Expr, seenOptions: Set<string>): string | null {
  if (seenOptions.has(key)) {
    return msgDuplicatedOption(key);
  }
  seenOptions.add(key);
  if (value.trim() === "") {
    return `option ${goQuote(key)} not of the form ${key}=value`;
  }
  if (key === "default" && !typeValueMatch(fieldType, value)) {
    return msgTypeMismatch;
  }
  if (key === "layout" && goFmt(fieldType) !== "time.Time") {
    return "layout option is only applicable to fields of type time.Time";
  }
  return null;
}

const protobufNames = new Set(["bytes", "fixed32", "fixed64", "group", "varint", "zigzag32", "zigzag64"]);
const protobufKnown = new Set(["json", "opt", "proto3", "rep", "req"]);

function checkProtobufTag(ctx: CheckContext, tag: Tag): string | null {
  if (!protobufNames.has(tag.name)) {
    return `invalid tag name ${goQuote(tag.name)}`;
  }
  const seenOptions = new Set<string>();
  let hasName = false;
  for (const option of tag.options) {
    const [opt] = cut(option, "=");
    const number = atoi(opt);
    if (number !== null) {
      if (ctx.usedTagNbr.has(`${number}`)) {
        return msgDuplicatedTagNumber(number);
      }
      ctx.usedTagNbr.add(`${number}`);
      continue;
    }
    if (opt === "name") {
      hasName = true;
    } else if (!protobufKnown.has(opt)) {
      if (isUserDefined(ctx, "protobuf", opt)) {
        continue;
      }
      return msgUnknownOption(opt);
    }
    if (seenOptions.has(opt)) {
      return msgDuplicatedOption(opt);
    }
    seenOptions.add(opt);
  }
  return hasName ? null : `mandatory option "name" not found`;
}

function checkRequiredTag(_ctx: CheckContext, tag: Tag): string | null {
  return tag.name === "true" || tag.name === "false" ? null : `required should be "true" or "false"`;
}

const urlKnown = new Set(["int", "omitempty", "numbered", "brackets", "unix", "unixmilli", "unixnano"]);
const urlDelimiters = new Set(["comma", "semicolon", "space"]);

function checkURLTag(ctx: CheckContext, tag: Tag): string | null {
  let delimiter = "";
  for (const opt of tag.options) {
    if (urlKnown.has(opt)) {
      continue;
    }
    if (urlDelimiters.has(opt)) {
      if (delimiter === "") {
        delimiter = opt;
        continue;
      }
      return `can not set both ${goQuote(opt)} and ${goQuote(delimiter)} as delimiters`;
    }
    if (!isUserDefined(ctx, "url", opt)) {
      return msgUnknownOption(opt);
    }
  }
  return null;
}

function checkValidateTag(ctx: CheckContext, tag: Tag): string | null {
  let previousOption = "";
  let seenKeysOption = false;
  for (const opt of [tag.name, ...tag.options]) {
    if (opt === "keys") {
      if (previousOption !== "dive") {
        return `option "keys" must follow a "dive" option`;
      }
      seenKeysOption = true;
    } else if (opt === "endkeys") {
      if (!seenKeysOption) {
        return `option "endkeys" without a previous "keys" option`;
      }
      seenKeysOption = false;
    } else {
      const msg = checkValidateOptionsAlternatives(ctx, opt.split("|"));
      if (msg !== null) {
        return msg;
      }
    }
    previousOption = opt;
  }
  return null;
}

function checkValidateOptionsAlternatives(ctx: CheckContext, alternatives: string[]): string | null {
  for (const raw of alternatives) {
    const alternative = raw.trim();
    const [lhs, , found] = cut(alternative, "=");
    if (found) {
      if (validateLHS.has(lhs) || isUserDefined(ctx, "validate", lhs)) {
        continue;
      }
      return msgUnknownOption(lhs);
    }
    if (validateSingleOptions.has(alternative) || isUserDefined(ctx, "validate", alternative)) {
      continue;
    }
    return msgUnknownOption(alternative);
  }
  return null;
}

function checkSpannerTag(ctx: CheckContext, tag: Tag): string | null {
  for (const opt of tag.options) {
    if (!isUserDefined(ctx, "spanner", opt)) {
      return msgUnknownOption(opt);
    }
  }
  return null;
}

// checkOptionsOnIgnoredField reports options on a field ignored with the name "-".
function checkOptionsOnIgnoredField(tag: Tag): string | null {
  if (tag.name !== "-") {
    return null;
  }
  switch (tag.options.length) {
    case 0:
      return null;
    case 1: {
      const opt = tag.options[0].trim();
      // "-," is accepted.
      return opt === "" ? null : `useless option ${opt} for ignored field`;
    }
    default:
      return `useless options ${tag.options.join(",")} for ignored field`;
  }
}

const tagCheckers = new Map<string, TagChecker>([
  ["asn1", checkASN1Tag],
  ["bson", checkKnownOptions("bson", ["inline", "minsize", "omitempty"])],
  ["cbor", checkCborTag],
  ["codec", checkCodecTag],
  ["datastore", checkKnownOptions("datastore", ["flatten", "noindex", "omitempty"])],
  ["default", checkDefaultTag],
  ["json", checkJSONTag],
  ["mapstructure", checkKnownOptions("mapstructure", ["omitempty", "reminder", "squash"])],
  ["properties", checkPropertiesTag],
  ["protobuf", checkProtobufTag],
  ["required", checkRequiredTag],
  ["spanner", checkSpannerTag],
  ["toml", checkKnownOptions("toml", ["omitempty"])],
  ["url", checkURLTag],
  ["validate", checkValidateTag],
  ["xml", checkKnownOptions("xml", ["any", "attr", "cdata", "chardata", "comment", "innerxml", "omitempty", "typeattr"])],
  ["yaml", checkKnownOptions("yaml", ["flow", "inline", "omitempty"])],
]);

function typeValueMatch(t: ast.Expr, val: string): boolean {
  if (t.$type !== "Ident") {
    return true;
  }
  switch ((t as ast.Ident).name) {
    case "bool":
      return val === "true" || val === "false";
    case "float64":
      return isFloat(val);
    case "int":
      return /^[+-]?[0-9]+$/.test(val) && atoi(val) !== null;
    default:
      return true;
  }
}

const decimalFloat = /^[+-]?(?:[0-9_]+\.?[0-9_]*|\.[0-9_]+)(?:[eE][+-]?[0-9_]+)?$/;
const hexFloat = /^[+-]?0[xX](?:[0-9a-fA-F_]+\.?[0-9a-fA-F_]*|\.[0-9a-fA-F_]+)(?:[pP][+-]?[0-9_]+)?$/;
const specialFloat = /^[+-]?(?:inf|infinity|nan)$/i;

// isFloat reports whether strconv.ParseFloat(s, 64) succeeds. It does not
// detect hexadecimal mantissas out of float64's range.
function isFloat(s: string): boolean {
  if (specialFloat.test(s)) {
    return !/^[+-]nan$/i.test(s);
  }
  if (hexFloat.test(s)) {
    // ParseFloat requires a "p" exponent and a digit in a hexadecimal mantissa.
    const mantissa = s.slice(s.search(/[xX]/) + 1).split(/[pP]/)[0];
    return /[pP]/.test(s) && /[0-9a-fA-F]/.test(mantissa) && underscoreOK(s);
  }
  if (!/[0-9]/.test(s.split(/[eE]/)[0]) || !decimalFloat.test(s) || !underscoreOK(s)) {
    return false;
  }
  return Number.isFinite(Number(s.replace(/_/g, "")));
}

// underscoreOK reports whether underscores in s sit only between digits or
// after a base prefix, as strconv requires.
function underscoreOK(s: string): boolean {
  let saw = "^";
  let i = 0;
  if (s.length >= 1 && (s[0] === "-" || s[0] === "+")) {
    s = s.slice(1);
  }
  let hex = false;
  if (s.length >= 2 && s[0] === "0" && /[bBoOxX]/.test(s[1])) {
    i = 2;
    saw = "0";
    hex = s[1] === "x" || s[1] === "X";
  }
  for (; i < s.length; i++) {
    const c = s[i];
    if ((c >= "0" && c <= "9") || (hex && /[a-fA-F]/.test(c))) {
      saw = "0";
      continue;
    }
    if (c === "_") {
      if (saw !== "0") {
        return false;
      }
      saw = "_";
      continue;
    }
    if (saw === "_") {
      return false;
    }
    saw = "!";
  }
  return saw !== "_";
}

// goQuote quotes s as Go's %q does for printable text.
function goQuote(s: string): string {
  let out = '"';
  for (const c of s) {
    const code = c.codePointAt(0)!;
    switch (c) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\r":
        out += "\\r";
        break;
      default:
        out += code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : c;
    }
  }
  return `${out}"`;
}

const validateSingleOptions = new Set([
  "alpha",
  "alphanum",
  "alphanumunicode",
  "alphaunicode",
  "ascii",
  "base32",
  "base64",
  "base64rawurl",
  "base64url",
  "bcp47_language_tag",
  "bic",
  "boolean",
  "btc_addr",
  "btc_addr_bech32",
  "cidr",
  "cidrv4",
  "cidrv6",
  "contains",
  "containsany",
  "containsrune",
  "credit_card",
  "cron",
  "cve",
  "datauri",
  "datetime",
  "dir",
  "dirpath",
  "dive",
  "dns_rfc1035_label",
  "e164",
  "ein",
  "email",
  "endsnotwith",
  "endswith",
  "eq",
  "eq_ignore_case",
  "eqcsfield",
  "eqfield",
  "eth_addr",
  "eth_addr_checksum",
  "excluded_if",
  "excluded_unless",
  "excluded_with",
  "excluded_with_all",
  "excluded_without",
  "excluded_without_all",
  "excludes",
  "excludesall",
  "excludesrune",
  "fieldcontains",
  "fieldexcludes",
  "file",
  "filepath",
  "fqdn",
  "gt",
  "gtcsfield",
  "gte",
  "gtecsfield",
  "gtefield",
  "gtfield",
  "hexadecimal",
  "hexcolor",
  "hostname",
  "hostname_port",
  "hostname_rfc1123",
  "hsl",
  "hsla",
  "html",
  "html_encoded",
  "http_url",
  "image",
  "ip",
  "ip4_addr",
  "ip6_addr",
  "ip_addr",
  "ipv4",
  "ipv6",
  "isbn",
  "isbn10",
  "isbn13",
  "isdefault",
  "iso3166_1_alpha2",
  "iso3166_1_alpha2_eu",
  "iso3166_1_alpha3",
  "iso3166_1_alpha3_eu",
  "iso3166_1_alpha_numeric",
  "iso3166_1_alpha_numeric_eu",
  "iso3166_2",
  "iso4217",
  "iso4217_numeric",
  "issn",
  "json",
  "jwt",
  "latitude",
  "len",
  "longitude",
  "lowercase",
  "lt",
  "ltcsfield",
  "lte",
  "ltecsfield",
  "ltefield",
  "ltfield",
  "luhn_checksum",
  "mac",
  "max",
  "md4",
  "md5",
  "min",
  "mongodb",
  "mongodb_connection_string",
  "multibyte",
  "ne",
  "ne_ignore_case",
  "necsfield",
  "nefield",
  "number",
  "numeric",
  "omitempty",
  "omitnil",
  "omitzero",
  "oneof",
  "oneofci",
  "port",
  "postcode_iso3166_alpha2",
  "postcode_iso3166_alpha2_field",
  "printascii",
  "required",
  "required_if",
  "required_unless",
  "required_with",
  "required_with_all",
  "required_without",
  "required_without_all",
  "rgb",
  "rgba",
  "ripemd128",
  "ripemd160",
  "semver",
  "sha256",
  "sha384",
  "sha512",
  "skip_unless",
  "spicedb",
  "ssn",
  "startsnotwith",
  "startswith",
  "tcp4_addr",
  "tcp6_addr",
  "tcp_addr",
  "tiger128",
  "tiger160",
  "tiger192",
  "timezone",
  "udp4_addr",
  "udp6_addr",
  "udp_addr",
  "ulid",
  "unique",
  "unix_addr",
  "uppercase",
  "uri",
  "url",
  "url_encoded",
  "urn_rfc2141",
  "uuid",
  "uuid3",
  "uuid3_rfc4122",
  "uuid4",
  "uuid4_rfc4122",
  "uuid5",
  "uuid5_rfc4122",
  "uuid_rfc4122",
  "validateFn",
]);

// validateLHS are the options used as <option>=<value>.
const validateLHS = new Set([
  "contains",
  "containsany",
  "containsfield",
  "containsrune",
  "datetime",
  "endsnotwith",
  "endswith",
  "eq",
  "eq_ignore_case",
  "eqcsfield",
  "eqfield",
  "excluded_if",
  "excluded_unless",
  "excluded_with",
  "excluded_with_all",
  "excluded_without",
  "excluded_without_all",
  "excludes",
  "excludesall",
  "excludesfield",
  "excludesrune",
  "fieldcontains",
  "fieldexcludes",
  "gt",
  "gtcsfield",
  "gte",
  "gtecsfield",
  "gtefield",
  "gtfield",
  "len",
  "lt",
  "ltcsfield",
  "lte",
  "ltecsfield",
  "ltefield",
  "ltfield",
  "max",
  "min",
  "ne",
  "ne_ignore_case",
  "necsfield",
  "nefield",
  "oneof",
  "oneofci",
  "required_if",
  "required_unless",
  "required_with",
  "required_with_all",
  "required_without",
  "required_without_all",
  "skip_unless",
  "spicedb",
  "startsnotwith",
  "startswith",
  "unique",
  "validateFn",
]);
