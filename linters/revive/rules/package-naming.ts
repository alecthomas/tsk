import * as filepath from "path/filepath";
import type { DeepReadonly, Failure, File, Rule } from "../lint";
import { hasUpperCaseLetter } from "../naming";

export const name = "package-naming";

export interface Options {
  /** Do not check package name conventions, such as no underscores or MixedCaps. */
  skipConventionNameCheck: boolean;
  /** A regular expression package names must match, instead of the conventions. */
  conventionNameCheckRegex: string;
  /** Do not forbid top level package names such as "pkg". */
  skipTopLevelCheck: boolean;
  /** Do not forbid the bad package names of https://go.dev/blog/package-names, such as "util". */
  skipDefaultBadNameCheck: boolean;
  /** Forbid further bad package names, such as "helpers" and "models". */
  checkExtraBadName: boolean;
  /** Package names to forbid, in any case. */
  userDefinedBadNames: string[];
  /** Allow names of commonly used standard library packages, such as "http". */
  skipCollisionWithCommonStd: boolean;
  /** Forbid the names of all public standard library packages. */
  checkCollisionWithAllStd: boolean;
}

export const defaults: Options = {
  skipConventionNameCheck: false,
  conventionNameCheckRegex: "",
  skipTopLevelCheck: false,
  skipDefaultBadNameCheck: false,
  checkExtraBadName: false,
  userDefinedBadNames: [],
  skipCollisionWithCommonStd: false,
  checkCollisionWithAllStd: false,
};

const defaultBadNames = new Set(["common", "interface", "interfaces", "misc", "type", "types", "util", "utils"]);

const extraBadNames = new Set(["api", "helpers", "miscellaneous", "models", "shared", "utilities"]);

// The most imported standard library packages, by name.
const commonStdNames = new Map([
  ["bytes", "bytes"],
  ["bufio", "bufio"],
  ["flag", "flag"],
  ["context", "context"],
  ["errors", "errors"],
  ["filepath", "path/filepath"],
  ["fmt", "fmt"],
  ["http", "net/http"],
  ["io", "io"],
  ["ioutil", "io/ioutil"],
  ["json", "encoding/json"],
  ["log", "log"],
  ["math", "math"],
  ["net", "net"],
  ["os", "os"],
  ["strconv", "strconv"],
  ["reflect", "reflect"],
  ["regexp", "regexp"],
  ["runtime", "runtime"],
  ["sort", "sort"],
  ["strings", "strings"],
  ["sync", "sync"],
  ["time", "time"],
  ["url", "net/url"],
]);

// Go 1.27's public standard library packages, by name, keeping the least
// path of those sharing a name. Revive loads the installed toolchain's.
const allStdNames = new Map(
  [
    "archive/tar archive/zip bufio bytes cmp compress/bzip2 compress/flate compress/gzip compress/lzw compress/zlib",
    "container/heap container/list container/ring context crypto crypto/aes crypto/cipher crypto/des crypto/dsa",
    "crypto/ecdh crypto/ecdsa crypto/ed25519 crypto/elliptic crypto/fips140 crypto/hkdf crypto/hmac crypto/hpke",
    "crypto/md5 crypto/mldsa crypto/mlkem crypto/mlkem/mlkemtest crypto/pbkdf2 crypto/rand crypto/rc4 crypto/rsa",
    "crypto/sha1 crypto/sha256 crypto/sha3 crypto/sha512 crypto/subtle crypto/tls crypto/x509 crypto/x509/pkix",
    "database/sql database/sql/driver debug/buildinfo debug/dwarf debug/elf debug/gosym debug/macho debug/pe",
    "debug/plan9obj embed encoding encoding/ascii85 encoding/asn1 encoding/base32 encoding/base64 encoding/binary",
    "encoding/csv encoding/gob encoding/hex encoding/json encoding/json/jsontext encoding/pem encoding/xml errors",
    "expvar flag fmt go/ast go/build go/build/constraint go/constant go/doc go/doc/comment go/format go/importer",
    "go/parser go/printer go/scanner go/token go/types go/version hash hash/adler32 hash/crc32 hash/crc64 hash/fnv",
    "hash/maphash html html/template image image/color image/color/palette image/draw image/gif image/jpeg",
    "image/png index/suffixarray io io/fs io/ioutil iter log log/slog log/syslog maps math math/big math/bits",
    "math/cmplx mime mime/multipart mime/quotedprintable net net/http net/http/cgi net/http/cookiejar",
    "net/http/fcgi net/http/httptest net/http/httptrace net/http/httputil net/http/pprof net/mail net/netip",
    "net/rpc net/rpc/jsonrpc net/smtp net/textproto net/url os os/exec os/signal os/user path path/filepath plugin",
    "reflect regexp regexp/syntax runtime runtime/cgo runtime/coverage runtime/debug runtime/metrics runtime/race",
    "runtime/trace slices sort strconv strings structs sync sync/atomic syscall testing testing/cryptotest",
    "testing/fstest testing/iotest testing/quick testing/slogtest testing/synctest text/tabwriter",
    "text/template/parse time time/tzdata unicode unicode/utf16 unicode/utf8 unique unsafe uuid weak",
  ]
    .join(" ")
    .split(" ")
    .map((path) => [path.slice(path.lastIndexOf("/") + 1), path]),
);

const forbiddenTopLevelNames = new Set(["pkg"]);

const invalid = "invalid argument to the package-naming rule";

export function create(options: DeepReadonly<Options>): Rule {
  let conventionRegex: RegExp | undefined;
  // The regular expression is JavaScript's, where revive's is Go's.
  if (options.conventionNameCheckRegex !== "") {
    try {
      conventionRegex = new RegExp(options.conventionNameCheckRegex);
    } catch (e) {
      throw new Error(`${invalid}: invalid regex for conventionNameCheckRegex: ${e}`);
    }
  }
  options.userDefinedBadNames.forEach((n, i) => {
    if (n === "") {
      throw new Error(`${invalid}: userDefinedBadNames cannot contain empty string (index ${i})`);
    }
  });
  const userDefinedBadNames = new Set(options.userDefinedBadNames.map((n) => n.toLowerCase()));
  if (options.skipConventionNameCheck && conventionRegex !== undefined) {
    throw new Error("invalid configuration for package-naming rule: skipConventionNameCheck and conventionNameCheckRegex cannot be both set");
  }
  if (options.skipCollisionWithCommonStd && options.checkCollisionWithAllStd) {
    throw new Error("invalid configuration for package-naming rule: skipCollisionWithCommonStd and checkCollisionWithAllStd cannot be both set");
  }
  // Each directory is checked once, by its first file.
  const alreadyChecked = new Set<string>();
  return {
    name,
    apply(file: File): Failure[] {
      const fileDir = filepath.dir(file.name);
      if (alreadyChecked.has(fileDir)) {
        return [];
      }
      alreadyChecked.add(fileDir);
      const node = file.ast.name!;
      const pkgName = node.name;
      const q = (s: string): string => JSON.stringify(s);
      const fail = (failure: string): Failure[] => [{ failure, confidence: 1, node }];
      const withoutTestSuffix = pkgName.endsWith("_test") ? pkgName.slice(0, -"_test".length) : pkgName;
      if (conventionRegex !== undefined) {
        if (!conventionRegex.test(withoutTestSuffix)) {
          return fail(`package name ${q(pkgName)} doesn't match the convention defined by conventionNameCheckRegex`);
        }
      } else if (!options.skipConventionNameCheck) {
        if (withoutTestSuffix.includes("_")) {
          return fail(`don't use package name ${q(pkgName)} that contains an underscore`);
        }
        if (hasUpperCaseLetter(withoutTestSuffix)) {
          return fail(`don't use package name ${q(pkgName)} that contains MixedCaps`);
        }
      }
      const lower = pkgName.toLowerCase();
      if (!options.skipTopLevelCheck && forbiddenTopLevelNames.has(lower) && filepath.base(fileDir) !== pkgName) {
        return fail(`don't use ${q(pkgName)} as a root level package name`);
      }
      if (!options.skipDefaultBadNameCheck && defaultBadNames.has(lower)) {
        return fail(`don't use ${q(pkgName)} because it is a bad package name according to https://go.dev/blog/package-names#bad-package-names`);
      }
      if (options.checkExtraBadName && extraBadNames.has(lower)) {
        return fail(`don't use ${q(pkgName)} because it is a bad package name (extra)`);
      }
      if (userDefinedBadNames.has(lower)) {
        return fail(`don't use ${q(pkgName)} because it is a bad package name (user-defined)`);
      }
      if (options.checkCollisionWithAllStd) {
        const std = allStdNames.get(lower);
        if (std !== undefined) {
          return fail(`don't use ${q(pkgName)} because it conflicts with Go standard library package ${q(std)}`);
        }
      } else if (!options.skipCollisionWithCommonStd) {
        const std = commonStdNames.get(lower);
        if (std !== undefined) {
          return fail(`don't use ${q(pkgName)} because it conflicts with common Go standard library package ${q(std)}`);
        }
      }
      return [];
    },
  };
}
