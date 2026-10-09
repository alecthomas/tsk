import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { quote } from "./internal/strconv";

interface Config {
  /** Suggest http.MethodXX. */
  httpMethod: boolean;
  /** Suggest http.StatusXX. */
  httpStatusCode: boolean;
  /** Suggest time.Weekday.String(). */
  timeWeekday: boolean;
  /** Suggest time.Month.String(). */
  timeMonth: boolean;
  /** Suggest time layout constants. */
  timeLayout: boolean;
  /** Suggest crypto.Hash.String(). */
  cryptoHash: boolean;
  /** Suggest rpc.DefaultXXPath. */
  defaultRpcPath: boolean;
  /** Suggest sql.LevelXX.String(). */
  sqlIsolationLevel: boolean;
  /** Suggest tls.SignatureScheme.String(). */
  tlsSignatureScheme: boolean;
  /** Suggest constant.Kind.String(). */
  constantKind: boolean;
  /** Suggest time.Month constants in time.Date. */
  timeDateMonth: boolean;
}

const httpMethods = new Map(
  ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "CONNECT", "OPTIONS", "TRACE"].map((m) => [m, `http.Method${m[0]}${m.slice(1).toLowerCase()}`]),
);

const httpStatusCodes = new Map<string, string>(
  (
    [
      [100, "Continue"],
      [101, "SwitchingProtocols"],
      [102, "Processing"],
      [103, "EarlyHints"],
      [200, "OK"],
      [201, "Created"],
      [202, "Accepted"],
      [203, "NonAuthoritativeInfo"],
      [204, "NoContent"],
      [205, "ResetContent"],
      [206, "PartialContent"],
      [207, "MultiStatus"],
      [208, "AlreadyReported"],
      [226, "IMUsed"],
      [300, "MultipleChoices"],
      [301, "MovedPermanently"],
      [302, "Found"],
      [303, "SeeOther"],
      [304, "NotModified"],
      [305, "UseProxy"],
      [307, "TemporaryRedirect"],
      [308, "PermanentRedirect"],
      [400, "BadRequest"],
      [401, "Unauthorized"],
      [402, "PaymentRequired"],
      [403, "Forbidden"],
      [404, "NotFound"],
      [405, "MethodNotAllowed"],
      [406, "NotAcceptable"],
      [407, "ProxyAuthRequired"],
      [408, "RequestTimeout"],
      [409, "Conflict"],
      [410, "Gone"],
      [411, "LengthRequired"],
      [412, "PreconditionFailed"],
      [413, "RequestEntityTooLarge"],
      [414, "RequestURITooLong"],
      [415, "UnsupportedMediaType"],
      [416, "RequestedRangeNotSatisfiable"],
      [417, "ExpectationFailed"],
      [418, "Teapot"],
      [421, "MisdirectedRequest"],
      [422, "UnprocessableEntity"],
      [423, "Locked"],
      [424, "FailedDependency"],
      [425, "TooEarly"],
      [426, "UpgradeRequired"],
      [428, "PreconditionRequired"],
      [429, "TooManyRequests"],
      [431, "RequestHeaderFieldsTooLarge"],
      [451, "UnavailableForLegalReasons"],
      [500, "InternalServerError"],
      [501, "NotImplemented"],
      [502, "BadGateway"],
      [503, "ServiceUnavailable"],
      [504, "GatewayTimeout"],
      [505, "HTTPVersionNotSupported"],
      [506, "VariantAlsoNegotiates"],
      [507, "InsufficientStorage"],
      [508, "LoopDetected"],
      [510, "NotExtended"],
      [511, "NetworkAuthenticationRequired"],
    ] as [number, string][]
  ).map(([code, name]) => [String(code), `http.Status${name}`]),
);

// stringers maps each value to the stringer call that produces it.
function stringers(pkg: string, entries: [string, string][]): Map<string, string> {
  return new Map(entries.map(([value, name]) => [value, `${pkg}.${name}.String()`]));
}

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const timeWeekday = stringers(
  "time",
  weekdays.map((d) => [d, d]),
);
const timeMonth = stringers(
  "time",
  months.map((m) => [m, m]),
);
const timeDateMonth = new Map(months.map((m, i) => [String(i + 1), `time.${m}`]));

const timeLayout = new Map(
  (
    [
      ["01/02 03:04:05PM '06 -0700", "Layout"],
      ["Mon Jan _2 15:04:05 2006", "ANSIC"],
      ["Mon Jan _2 15:04:05 MST 2006", "UnixDate"],
      ["Mon Jan 02 15:04:05 -0700 2006", "RubyDate"],
      ["02 Jan 06 15:04 MST", "RFC822"],
      ["02 Jan 06 15:04 -0700", "RFC822Z"],
      ["Monday, 02-Jan-06 15:04:05 MST", "RFC850"],
      ["Mon, 02 Jan 2006 15:04:05 MST", "RFC1123"],
      ["Mon, 02 Jan 2006 15:04:05 -0700", "RFC1123Z"],
      ["2006-01-02T15:04:05Z07:00", "RFC3339"],
      ["2006-01-02T15:04:05.999999999Z07:00", "RFC3339Nano"],
      ["3:04PM", "Kitchen"],
      ["Jan _2 15:04:05", "Stamp"],
      ["Jan _2 15:04:05.000", "StampMilli"],
      ["Jan _2 15:04:05.000000", "StampMicro"],
      ["Jan _2 15:04:05.000000000", "StampNano"],
      ["2006-01-02 15:04:05", "DateTime"],
      ["2006-01-02", "DateOnly"],
      ["15:04:05", "TimeOnly"],
    ] as [string, string][]
  ).map(([layout, name]) => [layout, `time.${name}`]),
);

const cryptoHash = stringers("crypto", [
  ["MD4", "MD4"],
  ["MD5", "MD5"],
  ["SHA-1", "SHA1"],
  ["SHA-224", "SHA224"],
  ["SHA-256", "SHA256"],
  ["SHA-384", "SHA384"],
  ["SHA-512", "SHA512"],
  ["MD5+SHA1", "MD5SHA1"],
  ["RIPEMD-160", "RIPEMD160"],
  ["SHA3-224", "SHA3_224"],
  ["SHA3-256", "SHA3_256"],
  ["SHA3-384", "SHA3_384"],
  ["SHA3-512", "SHA3_512"],
  ["SHA-512/224", "SHA512_224"],
  ["SHA-512/256", "SHA512_256"],
  ["BLAKE2s-256", "BLAKE2s_256"],
  ["BLAKE2b-256", "BLAKE2b_256"],
  ["BLAKE2b-384", "BLAKE2b_384"],
  ["BLAKE2b-512", "BLAKE2b_512"],
]);

const rpcDefaultPath = new Map([
  ["/_goRPC_", "rpc.DefaultRPCPath"],
  ["/debug/rpc", "rpc.DefaultDebugPath"],
]);

const sqlIsolationLevel = stringers("sql", [
  ["Read Uncommitted", "LevelReadUncommitted"],
  ["Read Committed", "LevelReadCommitted"],
  ["Write Committed", "LevelWriteCommitted"],
  ["Repeatable Read", "LevelRepeatableRead"],
]);

const tlsSignatureScheme = stringers(
  "tls",
  [
    "PSSWithSHA256",
    "ECDSAWithP256AndSHA256",
    "Ed25519",
    "PSSWithSHA384",
    "PSSWithSHA512",
    "PKCS1WithSHA256",
    "PKCS1WithSHA384",
    "PKCS1WithSHA512",
    "ECDSAWithP384AndSHA384",
    "ECDSAWithP521AndSHA512",
    "PKCS1WithSHA1",
    "ECDSAWithSHA1",
  ].map((s) => [s, s]),
);

const constantKind = stringers(
  "constant",
  ["Bool", "String", "Int", "Float", "Complex"].map((k) => [k, k]),
);

export default defineAnalyzer<Config>({
  name: "usestdlibvars",
  doc: "A linter that detect the possibility to use variables/constants from the Go standard library.",
  url: "https://github.com/sashamelentyev/usestdlibvars",
  requires: [inspect],
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: {
    httpMethod: true,
    httpStatusCode: true,
    timeWeekday: false,
    timeMonth: false,
    timeLayout: false,
    cryptoHash: false,
    defaultRpcPath: false,
    sqlIsolationLevel: false,
    tlsSignatureScheme: false,
    constantKind: false,
    timeDateMonth: false,
  },
  run(pass) {
    const c = pass.config;
    const literalChecks: [boolean, Map<string, string>][] = [
      [c.timeWeekday, timeWeekday],
      [c.timeMonth, timeMonth],
      [c.timeLayout, timeLayout],
      [c.cryptoHash, cryptoHash],
      [c.defaultRpcPath, rpcDefaultPath],
      [c.sqlIsolationLevel, sqlIsolationLevel],
      [c.tlsSignatureScheme, tlsSignatureScheme],
      [c.constantKind, constantKind],
    ];
    const kinds = [ast.CallExpr, ast.BasicLit, ast.CompositeLit, ast.BinaryExpr, ast.SwitchStmt];
    for (const cursor of pass
      .resultOf(inspect)
      .root()
      .preorder(...kinds)) {
      const node = cursor.node()!;
      switch (node.$type) {
        case "CallExpr":
          if (node.fun?.$type === "SelectorExpr" && node.fun.x?.$type === "Ident") {
            checkCall(pass, node.fun.x.name, node.fun.sel!.name, node.args as ast.Expr[]);
          }
          break;
        case "BasicLit":
          for (const [enabled, mapping] of literalChecks) {
            if (enabled) {
              check(pass, node, mapping);
            }
          }
          break;
        case "CompositeLit":
          if (node.type?.$type === "SelectorExpr" && node.type.x?.$type === "Ident") {
            checkComposite(pass, node.type.x.name, node.type.sel!.name, node.elts as ast.Expr[]);
          }
          break;
        case "BinaryExpr": {
          const ignoredOps = [token.LSS, token.GTR, token.LEQ, token.GEQ, token.QUO, token.ADD, token.SUB, token.MUL];
          if (!ignoredOps.includes(node.op) && node.x?.$type === "SelectorExpr" && node.y?.$type === "BasicLit") {
            const mapping = fieldMapping(pass, node.x.sel!.name);
            if (mapping !== null) {
              check(pass, node.y, mapping);
            }
          }
          break;
        }
        case "SwitchStmt": {
          const mapping = node.tag?.$type === "SelectorExpr" ? fieldMapping(pass, node.tag.sel!.name) : null;
          for (const clause of mapping === null ? [] : node.body!.list) {
            for (const expr of clause?.$type === "CaseClause" ? clause.list : []) {
              if (expr?.$type === "BasicLit") {
                check(pass, expr, mapping!);
              }
            }
          }
          break;
        }
      }
    }
  },
});

// fieldMapping returns the mapping for comparisons with a StatusCode or
// Method field, if enabled.
function fieldMapping(pass: Pass<Config>, field: string): Map<string, string> | null {
  if (field === "StatusCode" && pass.config.httpStatusCode) {
    return httpStatusCodes;
  }
  if (field === "Method" && pass.config.httpMethod) {
    return httpMethods;
  }
  return null;
}

// argument returns args[idx] if a call has count arguments and it is a
// literal of the kind.
function argument(args: ast.Expr[], count: number, idx: number, kind: token.Token): ast.BasicLit | null {
  const arg = args.length === count ? args[idx] : undefined;
  return arg?.$type === "BasicLit" && arg.kind === kind ? arg : null;
}

function checkCall(pass: Pass<Config>, x: string, name: string, args: ast.Expr[]): void {
  const c = pass.config;
  const method = (count: number, idx: number) => c.httpMethod && checkMaybe(pass, argument(args, count, idx, token.STRING), httpMethods);
  const status = (count: number, idx: number) => c.httpStatusCode && checkMaybe(pass, argument(args, count, idx, token.INT), httpStatusCodes);
  if (x === "http") {
    // As http.NewRequest(http.MethodGet, url, body).
    const calls: Record<string, () => void> = {
      NewRequest: () => method(3, 0),
      NewRequestWithContext: () => method(4, 1),
      Error: () => status(3, 2),
      StatusText: () => status(1, 0),
      Redirect: () => status(4, 3),
      RedirectHandler: () => status(2, 1),
    };
    calls[name]?.();
  } else if (x === "httptest") {
    if (name === "NewRequest") {
      method(3, 0);
    }
  } else if (x === "time") {
    if (name === "Date" && c.timeDateMonth) {
      checkMaybe(pass, argument(args, 8, 1, token.INT), timeDateMonth);
    }
  } else if (x !== "syslog" && name === "WriteHeader") {
    status(1, 0);
  }
}

function checkComposite(pass: Pass<Config>, x: string, name: string, elts: ast.Expr[]): void {
  const c = pass.config;
  if (x === "http" && name === "Request" && c.httpMethod) {
    checkMaybe(pass, keyedLiteral(elts, "Method"), httpMethods);
  } else if (x === "http" && name === "Response" && c.httpStatusCode) {
    checkMaybe(pass, keyedLiteral(elts, "StatusCode"), httpStatusCodes);
  } else if (x === "httptest" && name === "ResponseRecorder" && c.httpStatusCode) {
    checkMaybe(pass, keyedLiteral(elts, "Code"), httpStatusCodes);
  }
}

// keyedLiteral returns the first literal given for a key in a composite
// literal.
function keyedLiteral(elts: ast.Expr[], key: string): ast.BasicLit | null {
  for (const elt of elts) {
    if (elt.$type === "KeyValueExpr" && elt.key?.$type === "Ident" && elt.key.name === key && elt.value?.$type === "BasicLit") {
      return elt.value;
    }
  }
  return null;
}

function checkMaybe(pass: Pass<Config>, lit: ast.BasicLit | null, mapping: Map<string, string>): void {
  if (lit !== null) {
    check(pass, lit, mapping);
  }
}

function check(pass: Pass<Config>, lit: ast.BasicLit, mapping: Map<string, string>): void {
  // Upstream drops every double quote, so raw strings keep their backquotes.
  const value = lit.value.split('"').join("");
  const replacement = mapping === httpMethods ? mapping.get(value.toUpperCase()) : mapping.get(value);
  if (replacement === undefined) {
    return;
  }
  pass.report({
    pos: lit.pos(),
    message: `${quote(value)} can be replaced by ${replacement}`,
    suggestedFixes: [{ message: "", textEdits: [{ pos: lit.pos(), end: lit.end(), newText: replacement }] }],
  });
}
