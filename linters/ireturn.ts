import * as ast from "go/ast";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Interfaces that may be returned: keywords empty, anon, error, stdlib, generic, or regular expressions. */
  allow: readonly string[];
  /** Interfaces that may not be returned, in the same form; exclusive with allow. */
  reject: readonly string[];
}

const Kind = { Empty: 1, Anon: 2, Error: 4, Named: 8, NamedStd: 16, Generic: 32 } as const;
type Kind = (typeof Kind)[keyof typeof Kind];

const keywords: Record<string, Kind> = {
  empty: Kind.Empty,
  anon: Kind.Anon,
  error: Kind.Error,
  stdlib: Kind.NamedStd,
  generic: Kind.Generic,
};

interface Issue {
  name: string;
  kind: Kind;
  ofType: string;
}

// Upstream's snapshot of standard library packages, copied rather than
// computed so the same interfaces count as standard.
const std = new Set([
  "archive/tar",
  "archive/zip",
  "bufio",
  "bytes",
  "cmd/cgo",
  "cmd/fix",
  "cmd/go",
  "cmd/gofmt",
  "cmd/yacc",
  "compress/bzip2",
  "compress/flate",
  "compress/gzip",
  "compress/lzw",
  "compress/zlib",
  "container/heap",
  "container/list",
  "container/ring",
  "crypto",
  "crypto/aes",
  "crypto/cipher",
  "crypto/des",
  "crypto/dsa",
  "crypto/ecdsa",
  "crypto/elliptic",
  "crypto/hmac",
  "crypto/md5",
  "crypto/rand",
  "crypto/rc4",
  "crypto/rsa",
  "crypto/sha1",
  "crypto/sha256",
  "crypto/sha512",
  "crypto/subtle",
  "crypto/tls",
  "crypto/x509",
  "crypto/x509/pkix",
  "database/sql",
  "database/sql/driver",
  "debug/dwarf",
  "debug/elf",
  "debug/gosym",
  "debug/macho",
  "debug/pe",
  "encoding",
  "encoding/ascii85",
  "encoding/asn1",
  "encoding/base32",
  "encoding/base64",
  "encoding/binary",
  "encoding/csv",
  "encoding/gob",
  "encoding/hex",
  "encoding/json",
  "encoding/pem",
  "encoding/xml",
  "errors",
  "expvar",
  "flag",
  "fmt",
  "go/ast",
  "go/build",
  "go/doc",
  "go/format",
  "go/parser",
  "go/printer",
  "go/scanner",
  "go/token",
  "hash",
  "hash/adler32",
  "hash/crc32",
  "hash/crc64",
  "hash/fnv",
  "html",
  "html/template",
  "image",
  "image/color",
  "image/color/palette",
  "image/draw",
  "image/gif",
  "image/jpeg",
  "image/png",
  "index/suffixarray",
  "io",
  "io/ioutil",
  "log",
  "log/syslog",
  "math",
  "math/big",
  "math/cmplx",
  "math/rand",
  "mime",
  "mime/multipart",
  "net",
  "net/http",
  "net/http/cgi",
  "net/http/cookiejar",
  "net/http/fcgi",
  "net/http/httptest",
  "net/http/httputil",
  "net/http/pprof",
  "net/mail",
  "net/rpc",
  "net/rpc/jsonrpc",
  "net/smtp",
  "net/textproto",
  "net/url",
  "os",
  "os/exec",
  "os/signal",
  "os/user",
  "path",
  "path/filepath",
  "reflect",
  "regexp",
  "regexp/syntax",
  "runtime",
  "runtime/cgo",
  "runtime/debug",
  "runtime/pprof",
  "runtime/race",
  "sort",
  "strconv",
  "strings",
  "sync",
  "sync/atomic",
  "syscall",
  "testing",
  "testing/iotest",
  "testing/quick",
  "text/scanner",
  "text/tabwriter",
  "text/template",
  "text/template/parse",
  "time",
  "unicode",
  "unicode/utf16",
  "unicode/utf8",
  "unsafe",
  "cmd/addr2line",
  "cmd/nm",
  "cmd/objdump",
  "cmd/pack",
  "debug/plan9obj",
  "cmd/pprof",
  "go/constant",
  "go/importer",
  "go/types",
  "mime/quotedprintable",
  "runtime/trace",
  "context",
  "net/http/httptrace",
  "plugin",
  "math/bits",
  "crypto/ed25519",
  "hash/maphash",
  "time/tzdata",
  "embed",
  "go/build/constraint",
  "io/fs",
  "runtime/metrics",
  "testing/fstest",
  "debug/buildinfo",
  "net/netip",
  "go/doc/comment",
  "crypto/ecdh",
  "runtime/coverage",
  "cmp",
  "log/slog",
  "maps",
  "slices",
  "testing/slogtest",
  "go/version",
  "math/rand/v2",
  "iter",
  "structs",
  "unique",
  "crypto/fips140",
  "crypto/hkdf",
  "crypto/mlkem",
  "crypto/pbkdf2",
  "crypto/sha3",
  "weak",
  "testing/synctest",
  "crypto/hpke",
  "crypto/mlkem/mlkemtest",
  "testing/cryptotest",
]);

// List matches interfaces against keywords and regular expressions. Every
// entry, keywords included, is also tried as a regular expression.
class List {
  private quick = 0;
  private readonly res: RegExp[] = [];

  constructor(patterns: readonly string[]) {
    for (const pattern of patterns) {
      this.quick |= keywords[pattern] ?? 0;
      try {
        this.res.push(new RegExp(pattern));
      } catch {
        // Upstream drops patterns that do not compile.
      }
    }
  }

  has(issue: Issue): boolean {
    if ((this.quick & issue.kind) !== 0) {
      return true;
    }
    if ((issue.kind & (Kind.Named | Kind.NamedStd)) === 0) {
      return false;
    }
    return this.res.some((re) => re.test(issue.name));
  }
}

export default defineAnalyzer<Config>({
  name: "ireturn",
  doc: "Accept Interfaces, Return Concrete Types",
  requires: [inspect],
  config: { allow: [], reject: [] },
  run(pass) {
    const allow = toList(pass.config.allow);
    const reject = toList(pass.config.reject);
    if (allow.length !== 0 && reject.length !== 0) {
      throw new Error("can't have both `-accept` and `-reject` specified at same time");
    }
    // An allow list, by default empty, error, anon and stdlib, or a reject list.
    const list = new List(reject.length !== 0 ? reject : allow.length !== 0 ? allow : ["empty", "error", "anon", "stdlib"]);
    const valid = (issue: Issue) => (reject.length !== 0 ? !list.has(issue) : list.has(issue));
    const root = pass.resultOf(inspect).root();
    const dotImported = new Set<string>();
    for (const cursor of root.preorder(ast.ImportSpec)) {
      const spec = cursor.node() as ast.ImportSpec;
      if (spec.name?.name === ".") {
        dotImported.add(spec.path!.value.replace(/^"+|"+$/g, ""));
      }
    }
    for (const cursor of root.preorder(ast.FuncDecl)) {
      const fn = cursor.node() as ast.FuncDecl;
      if (fn.type?.results === null || fn.type === null) {
        continue;
      }
      const seen = new Set<string>();
      for (const issue of interfaces(pass, fn.type.results!, dotImported)) {
        if (valid(issue)) {
          continue;
        }
        const message =
          issue.kind !== Kind.Generic
            ? `${fn.name!.name} returns interface (${issue.name})`
            : issue.ofType !== ""
              ? `${fn.name!.name} returns generic interface (${issue.name}) of type param ${issue.ofType}`
              : `${fn.name!.name} returns generic interface (${issue.name})`;
        if (!seen.has(message)) {
          seen.add(message);
          pass.report({ pos: fn.pos(), message });
        }
      }
    }
  },
});

function toList(patterns: readonly string[]): string[] {
  return patterns
    .join(",")
    .split(",")
    .map((p) => p.replace(/^[ \t]+|[ \t]+$/g, ""))
    .filter((p) => p !== "");
}

function interfaces(pass: Pass<Config>, results: ast.FieldList, dotImported: Set<string>): Issue[] {
  const found: Issue[] = [];
  const add = (name: string, kind: Kind, ofType = "") => found.push({ name, kind, ofType });
  for (const field of results.list) {
    const expr = field!.type;
    if (expr?.$type === "InterfaceType") {
      if (expr.methods!.list.length === 0) {
        add("interface{}", Kind.Empty);
      } else {
        add("anonymous interface", Kind.Anon);
      }
    } else if (expr?.$type === "Ident") {
      const t = pass.typesInfo.typeOf(expr);
      const iface = t?.underlying();
      if (iface?.$type !== "Interface") {
        continue;
      }
      const name = t!.string();
      if (iface.empty() && name === "any") {
        add(name, Kind.Empty);
      } else if (name === "error") {
        add(name, Kind.Error);
      } else if (!name.includes(".")) {
        // A type parameter: report its constraint's terms.
        add(
          name,
          Kind.Generic,
          iface
            .string()
            .replace(/^interface\{/, "")
            .replace(/\}$/, ""),
        );
      } else if (dotImported.size > 0 && dotImported.has(stdPackage(name))) {
        add(name, Kind.NamedStd);
      } else {
        add(name, Kind.Named);
      }
    } else if (expr?.$type === "SelectorExpr") {
      const t = pass.typesInfo.typeOf(expr);
      if (!types.isInterface(t?.underlying() ?? null)) {
        continue;
      }
      const name = t!.string();
      add(name, stdPackage(name) !== "" ? Kind.NamedStd : Kind.Named);
    }
  }
  return found;
}

// stdPackage returns the package of a named interface if it is in the
// standard library.
function stdPackage(named: string): string {
  const i = named.lastIndexOf(".");
  return i >= 0 && std.has(named.slice(0, i)) ? named.slice(0, i) : "";
}
