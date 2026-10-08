import * as ast from "go/ast";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import * as advanced from "./testifylint/advanced";
import { newCallMeta } from "./testifylint/helpers";
import * as regular from "./testifylint/regular";

interface Config {
  /** Enable every checker. */
  enableAll: boolean;
  /** Disable every checker, leaving only those in enable. */
  disableAll: boolean;
  /** Checkers to enable besides the defaults. */
  enable: string[];
  /** Checkers to disable. */
  disable: string[];
  boolCompare: {
    /** Ignore custom types based on bool. */
    ignoreCustomTypes: boolean;
  };
  expectedActual: {
    /** Pattern for names of expected values; empty for the default. */
    pattern: string;
  };
  formatter: {
    /** Check format strings as go vet's printf check does. */
    checkFormatString: boolean;
    /** Require f-assertions, as assert.Equalf, when a format string is used. */
    requireFFuncs: boolean;
    /** Require the first element of msgAndArgs to be a string. */
    requireStringMsg: boolean;
  };
  goRequire: {
    /** Ignore HTTP handlers, such as http.HandlerFunc. */
    ignoreHttpHandlers: boolean;
  };
  requireError: {
    /** Pattern for the error assertions to check; empty for all. */
    fnPattern: string;
  };
  suiteExtraAssertCall: {
    /** Whether to "remove" or "require" an explicit Assert() call. */
    mode: "remove" | "require";
  };
}

type Checker = { kind: "regular"; checker: regular.RegularChecker } | { kind: "advanced"; checker: advanced.AdvancedChecker };

// checkers lists every checker in priority order: for each assertion, only
// the first problem found is reported.
function checkers(config: Config): { checker: Checker; enabledByDefault: boolean }[] {
  const r = (checker: regular.RegularChecker): Checker => ({ kind: "regular", checker });
  const a = (checker: advanced.AdvancedChecker): Checker => ({ kind: "advanced", checker });
  const pattern = config.expectedActual.pattern;
  const fnPattern = config.requireError.fnPattern;
  return [
    r(regular.floatCompare()),
    r(regular.boolCompare(config.boolCompare.ignoreCustomTypes)),
    r(regular.empty()),
    r(regular.negativePositive()),
    r(regular.compares()),
    r(regular.contains()),
    r(regular.errorNil()),
    r(regular.nilCompare()),
    r(regular.errorIsAs()),
    r(regular.encodedCompare()),
    r(regular.expectedActual(new RegExp(pattern === "" ? regular.defaultExpectedVarPattern : pattern))),
    r(regular.len()),
    r(regular.equalValues()),
    r(regular.regexp()),
    r(regular.suiteExtraAssertCall(config.suiteExtraAssertCall.mode)),
    r(regular.suiteDontUsePkg()),
    r(regular.uselessAssert()),
    r(regular.formatter(config.formatter)),
    a(advanced.blankImport()),
    a(advanced.goRequire(config.goRequire.ignoreHttpHandlers)),
    a(advanced.requireError(fnPattern === "" ? null : new RegExp(fnPattern))),
    a(advanced.suiteBrokenParallel()),
    a(advanced.suiteMethodSignature()),
    a(advanced.suiteSubtestRun()),
    a(advanced.suiteTHelper()),
  ].map((checker) => ({ checker, enabledByDefault: checker.checker.name !== "suite-thelper" }));
}

// enabledCheckers selects checkers as upstream does, validating the options.
function enabledCheckers(config: Config): Checker[] {
  const { enableAll, disableAll, enable, disable } = config;
  if (enableAll && disableAll) {
    throw new Error("enable-all and disable-all options must not be combined");
  }
  if (enableAll && enable.length > 0) {
    throw new Error("enable-all and enable options must not be combined");
  }
  if (disableAll && disable.length > 0) {
    throw new Error("disable-all and disable options must not be combined");
  }
  if (disableAll && enable.length === 0) {
    throw new Error("all checkers were disabled, but no one checker was enabled: at least one must be enabled");
  }
  const all = checkers(config);
  const known = new Set(all.map(({ checker }) => checker.checker.name));
  for (const name of [...enable, ...disable]) {
    if (!known.has(name)) {
      throw new Error(`unknown checker "${name}"`);
    }
  }
  const conflict = disable.find((name) => enable.includes(name));
  if (conflict !== undefined) {
    throw new Error(`checker "${conflict}" disabled and enabled at one moment`);
  }
  return all
    .filter(({ checker, enabledByDefault }) => {
      const name = checker.checker.name;
      const selected = enableAll || (!disableAll && enabledByDefault) || enable.includes(name);
      return selected && !disable.includes(name);
    })
    .map(({ checker }) => checker);
}

export default defineAnalyzer<Config>({
  name: "testifylint",
  doc: "Checks usage of github.com/stretchr/testify.",
  url: "https://github.com/antonboom/testifylint",
  requires: [inspect],
  config: {
    enableAll: false,
    disableAll: false,
    enable: [],
    disable: [],
    boolCompare: { ignoreCustomTypes: false },
    expectedActual: { pattern: "" },
    formatter: { checkFormatString: true, requireFFuncs: false, requireStringMsg: false },
    goRequire: { ignoreHttpHandlers: false },
    requireError: { fnPattern: "" },
    suiteExtraAssertCall: { mode: "remove" },
  },
  run(pass) {
    const enabled = enabledCheckers(pass.config as Config);
    const regulars = enabled.flatMap((c) => (c.kind === "regular" ? [c.checker] : []));
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = newCallMeta(pass, cursor.node() as ast.CallExpr);
      if (call === null) {
        continue;
      }
      for (const checker of regulars) {
        const diagnostic = checker.check(pass, call);
        if (diagnostic !== null) {
          pass.report(diagnostic);
          break;
        }
      }
    }
    for (const c of enabled) {
      if (c.kind === "advanced") {
        for (const diagnostic of c.checker.check(pass)) {
          pass.report(diagnostic);
        }
      }
    }
  },
});
