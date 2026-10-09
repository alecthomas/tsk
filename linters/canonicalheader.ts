import * as ast from "go/ast";
import * as constant from "go/constant";
import * as token from "go/token";
import * as types from "go/types";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { unquote } from "./internal/strconv";

interface Config {
  /** Header keys to accept as written, such as `exclusioN`. */
  exclusions: string[];
  /** Accept well-known non-canonical headers, such as `ETag` and `WWW-Authenticate`. */
  useDefaultExclusion: boolean;
}

// initialisms maps the canonical form of well-known headers to the form they
// are written in, from the IANA HTTP field registry.
const initialisms: Record<string, string> = {
  "A-Im": "A-IM",
  "Accept-Ch": "Accept-CH",
  Alpn: "ALPN",
  "Amp-Cache-Transform": "AMP-Cache-Transform",
  "C-Pep": "C-PEP",
  "C-Pep-Info": "C-PEP-Info",
  "Cal-Managed-Id": "Cal-Managed-ID",
  "Caldav-Timezones": "CalDAV-Timezones",
  "Cdn-Cache-Control": "CDN-Cache-Control",
  "Cdn-Loop": "CDN-Loop",
  "Content-Id": "Content-ID",
  "Content-Md5": "Content-MD5",
  Dasl: "DASL",
  Dav: "DAV",
  "Differential-Id": "Differential-ID",
  Dnt: "DNT",
  Dpop: "DPoP",
  "Dpop-Nonce": "DPoP-Nonce",
  "Ediint-Features": "EDIINT-Features",
  Etag: "ETag",
  "Expect-Ct": "Expect-CT",
  Getprofile: "GetProfile",
  "Http2-Settings": "HTTP2-Settings",
  Im: "IM",
  "Include-Referred-Token-Binding-Id": "Include-Referred-Token-Binding-ID",
  "Last-Event-Id": "Last-Event-ID",
  "Mime-Version": "MIME-Version",
  Nel: "NEL",
  "Odata-Entityid": "OData-EntityId",
  "Odata-Isolation": "OData-Isolation",
  "Odata-Maxversion": "OData-MaxVersion",
  "Odata-Version": "OData-Version",
  "Optional-Www-Authenticate": "Optional-WWW-Authenticate",
  Oscore: "OSCORE",
  "Oslc-Core-Version": "OSLC-Core-Version",
  P3p: "P3P",
  Pep: "PEP",
  "Pep-Info": "PEP-Info",
  "Pics-Label": "PICS-Label",
  Profileobject: "ProfileObject",
  "Repeatability-Client-Id": "Repeatability-Client-ID",
  "Repeatability-Request-Id": "Repeatability-Request-ID",
  "Sec-Gpc": "Sec-GPC",
  "Sec-Websocket-Accept": "Sec-WebSocket-Accept",
  "Sec-Websocket-Extensions": "Sec-WebSocket-Extensions",
  "Sec-Websocket-Key": "Sec-WebSocket-Key",
  "Sec-Websocket-Protocol": "Sec-WebSocket-Protocol",
  "Sec-Websocket-Version": "Sec-WebSocket-Version",
  Setprofile: "SetProfile",
  Slug: "SLUG",
  Soapaction: "SoapAction",
  "Status-Uri": "Status-URI",
  Tcn: "TCN",
  Te: "TE",
  Ttl: "TTL",
  Uri: "URI",
  "Www-Authenticate": "WWW-Authenticate",
  "X-Correlation-Id": "X-Correlation-ID",
  "X-Dns-Prefetch-Control": "X-DNS-Prefetch-Control",
  "X-Real-Ip": "X-Real-IP",
  "X-Request-Id": "X-Request-ID",
  "X-Ua-Compatible": "X-UA-Compatible",
  "X-Webkit-Csp": "X-WebKit-CSP",
  "X-Xss": "X-XSS",
  "X-Xss-Protection": "X-XSS-Protection",
};

const keyMethods = new Set(["Get", "Set", "Add", "Del", "Values"]);

export default defineAnalyzer<Config>({
  name: "canonicalheader",
  doc: `check that net/http.Header keys are canonical

Header methods canonicalize keys on every call, so a literal key in canonical
form, such as "Content-Type", avoids the work and reads as it is stored.`,
  requires: [inspect],
  config: { exclusions: [], useDefaultExclusion: true },
  run(pass) {
    // Packages that never name http.Header are skipped, as upstream does.
    let headerType: types.Type | null = null;
    for (const object of pass.typesInfo.uses.values()) {
      if (object?.pkg()?.path() === "net/http" && object.name() === "Header") {
        headerType = object.type();
        break;
      }
    }
    if (headerType === null) {
      return;
    }
    const exclusions = new Map<string, string>(pass.config.useDefaultExclusion ? Object.entries(initialisms) : []);
    for (const exclusion of pass.config.exclusions) {
      exclusions.set(canonicalHeaderKey(exclusion), exclusion);
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      checkCall(pass, cursor.node() as ast.CallExpr, headerType, exclusions);
    }
  },
});

function checkCall(pass: Pass<Config>, call: ast.CallExpr, headerType: types.Type, exclusions: Map<string, string>): void {
  const method = headerMethod(pass, call);
  if (method === null || !types.identical(method.receiver, headerType) || !keyMethods.has(method.name) || call.args.length === 0) {
    return;
  }
  // See through conversions such as string(myString).
  let arg = call.args[0]!;
  while (arg.$type === "CallExpr") {
    if (arg.args.length === 0) {
      return;
    }
    if (arg.fun?.$type !== "Ident") {
      break;
    }
    const object = pass.typesInfo.objectOf(arg.fun);
    if (object === null) {
      break;
    }
    if (object.type()?.$type === "Signature") {
      return;
    }
    arg = arg.args[0]!;
  }
  let key: string;
  let quote: string | null = null;
  if (arg.$type === "BasicLit") {
    const unquoted = arg.kind === token.STRING ? unquote(arg.value) : null;
    if (unquoted === null) {
      return;
    }
    key = unquoted;
    quote = arg.value[0];
  } else if (arg.$type === "Ident") {
    const object = pass.typesInfo.objectOf(arg);
    if (object?.$type !== "Const") {
      return;
    }
    key = constant.stringVal(object.val());
  } else {
    return;
  }
  const canonical = exclusions.get(canonicalHeaderKey(key)) ?? canonicalHeaderKey(key);
  if (key === canonical) {
    return;
  }
  const message = `use ${JSON.stringify(canonical)} instead of ${JSON.stringify(key)}`;
  if (quote === null) {
    pass.report({ pos: arg.pos(), end: arg.end(), message });
    return;
  }
  pass.report({
    pos: arg.pos(),
    end: arg.end(),
    message,
    suggestedFixes: [
      {
        message: `should be replaced ${JSON.stringify(key)} with ${JSON.stringify(canonical)}`,
        textEdits: [{ pos: arg.pos(), end: arg.end(), newText: quote + canonical + quote }],
      },
    ],
  });
}

// headerMethod finds the receiver type and method name of a call, either
// direct, as h.Get(k), or through a method value assigned earlier, as f := h.Get.
function headerMethod(pass: Pass<Config>, call: ast.CallExpr): { receiver: types.Type | null; name: string } | null {
  const callee = typeutil.callee(pass.typesInfo, call);
  if (callee?.$type === "Func") {
    const recv = (callee.type() as types.Signature).recv();
    if (recv === null || call.fun?.$type !== "SelectorExpr") {
      return null;
    }
    return { receiver: recv.type(), name: call.fun.sel!.name };
  }
  if (callee?.$type !== "Var" || call.fun?.$type !== "Ident") {
    return null;
  }
  const ident = call.fun;
  const assign = ident.obj?.decl;
  if (assign == null || (assign as ast.Node).$type !== "AssignStmt") {
    return null;
  }
  const stmt = assign as ast.AssignStmt;
  let index = -1;
  stmt.lhs.forEach((lhs, i) => {
    if (lhs?.$type === "Ident" && lhs.name === ident.name) {
      index = i;
    }
  });
  const rhs = index === -1 ? null : stmt.rhs[index];
  if (rhs?.$type !== "SelectorExpr" || rhs.x?.$type !== "Ident") {
    return null;
  }
  return { receiver: pass.typesInfo.objectOf(rhs.x)?.type() ?? null, name: rhs.sel!.name };
}

// canonicalHeaderKey mirrors net/http.CanonicalHeaderKey: a key with any
// character outside the HTTP token set is returned unchanged.
function canonicalHeaderKey(key: string): string {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]*$/.test(key)) {
    return key;
  }
  let upper = true;
  let result = "";
  for (const char of key) {
    result += upper ? char.toUpperCase() : char.toLowerCase();
    upper = char === "-";
  }
  return result;
}
