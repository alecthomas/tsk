import { defineAnalyzer, type Pass } from "tsk";
import { lintFile, Package, type Rule } from "./revive/lint";
import * as addConstant from "./revive/rules/add-constant";
import * as argumentLimit from "./revive/rules/argument-limit";
import * as atomic from "./revive/rules/atomic";
import * as bannedCharacters from "./revive/rules/banned-characters";
import * as bareReturn from "./revive/rules/bare-return";
import * as blankImports from "./revive/rules/blank-imports";
import * as boolLiteralInExpr from "./revive/rules/bool-literal-in-expr";
import * as callToGc from "./revive/rules/call-to-gc";
import * as cognitiveComplexity from "./revive/rules/cognitive-complexity";
import * as commentSpacings from "./revive/rules/comment-spacings";
import * as commentsDensity from "./revive/rules/comments-density";
import * as confusingNaming from "./revive/rules/confusing-naming";
import * as confusingResults from "./revive/rules/confusing-results";
import * as constantLogicalExpr from "./revive/rules/constant-logical-expr";
import * as contextAsArgument from "./revive/rules/context-as-argument";
import * as contextKeysType from "./revive/rules/context-keys-type";
import * as cyclomatic from "./revive/rules/cyclomatic";
import * as datarace from "./revive/rules/datarace";
import * as deepExit from "./revive/rules/deep-exit";
import * as defer from "./revive/rules/defer";
import * as dotImports from "./revive/rules/dot-imports";
import * as duplicatedImports from "./revive/rules/duplicated-imports";
import * as earlyReturn from "./revive/rules/early-return";
import * as emptyBlock from "./revive/rules/empty-block";
import * as emptyLines from "./revive/rules/empty-lines";
import * as enforceMapStyle from "./revive/rules/enforce-map-style";
import * as enforceRepeatedArgTypeStyle from "./revive/rules/enforce-repeated-arg-type-style";
import * as enforceSliceStyle from "./revive/rules/enforce-slice-style";
import * as enforceSwitchStyle from "./revive/rules/enforce-switch-style";
import * as epochNaming from "./revive/rules/epoch-naming";
import * as errorNaming from "./revive/rules/error-naming";
import * as errorReturn from "./revive/rules/error-return";
import * as errorStrings from "./revive/rules/error-strings";
import * as errorf from "./revive/rules/errorf";
import * as exported from "./revive/rules/exported";
import * as fileHeader from "./revive/rules/file-header";
import * as fileLengthLimit from "./revive/rules/file-length-limit";
import * as filenameFormat from "./revive/rules/filename-format";
import * as flagParameter from "./revive/rules/flag-parameter";
import * as forbiddenCallInWgGo from "./revive/rules/forbidden-call-in-wg-go";
import * as functionLength from "./revive/rules/function-length";
import * as functionResultLimit from "./revive/rules/function-result-limit";
import * as getReturn from "./revive/rules/get-return";
import * as identicalBranches from "./revive/rules/identical-branches";
import * as identicalIfelseifBranches from "./revive/rules/identical-ifelseif-branches";
import * as identicalIfelseifConditions from "./revive/rules/identical-ifelseif-conditions";
import * as identicalSwitchBranches from "./revive/rules/identical-switch-branches";
import * as identicalSwitchConditions from "./revive/rules/identical-switch-conditions";
import * as ifReturn from "./revive/rules/if-return";
import * as importAliasNaming from "./revive/rules/import-alias-naming";
import * as importShadowing from "./revive/rules/import-shadowing";
import * as importsBlocklist from "./revive/rules/imports-blocklist";
import * as incrementDecrement from "./revive/rules/increment-decrement";
import * as indentErrorFlow from "./revive/rules/indent-error-flow";
import * as inefficientMapLookup from "./revive/rules/inefficient-map-lookup";
import * as lineLengthLimit from "./revive/rules/line-length-limit";
import * as marshalReceiver from "./revive/rules/marshal-receiver";
import * as maxControlNesting from "./revive/rules/max-control-nesting";
import * as maxPublicStructs from "./revive/rules/max-public-structs";
import * as modifiesParameter from "./revive/rules/modifies-parameter";
import * as modifiesValueReceiver from "./revive/rules/modifies-value-receiver";
import * as multilineIfInit from "./revive/rules/multiline-if-init";
import * as nestedStructs from "./revive/rules/nested-structs";
import * as optimizeOperandsOrder from "./revive/rules/optimize-operands-order";
import * as packageComments from "./revive/rules/package-comments";
import * as packageDirectoryMismatch from "./revive/rules/package-directory-mismatch";
import * as packageNaming from "./revive/rules/package-naming";
import * as range from "./revive/rules/range";
import * as rangeValAddress from "./revive/rules/range-val-address";
import * as rangeValInClosure from "./revive/rules/range-val-in-closure";
import * as receiverNaming from "./revive/rules/receiver-naming";
import * as redefinesBuiltinId from "./revive/rules/redefines-builtin-id";
import * as redundantBuildTag from "./revive/rules/redundant-build-tag";
import * as redundantImportAlias from "./revive/rules/redundant-import-alias";
import * as stringFormat from "./revive/rules/string-format";
import * as stringOfInt from "./revive/rules/string-of-int";
import * as structTag from "./revive/rules/struct-tag";
import * as superfluousElse from "./revive/rules/superfluous-else";
import * as timeDate from "./revive/rules/time-date";
import * as timeEqual from "./revive/rules/time-equal";
import * as timeNaming from "./revive/rules/time-naming";
import * as uncheckedTypeAssertion from "./revive/rules/unchecked-type-assertion";
import * as unconditionalRecursion from "./revive/rules/unconditional-recursion";
import * as unexportedNaming from "./revive/rules/unexported-naming";
import * as unexportedReturn from "./revive/rules/unexported-return";
import * as unhandledError from "./revive/rules/unhandled-error";
import * as unnecessaryFormat from "./revive/rules/unnecessary-format";
import * as unnecessaryIf from "./revive/rules/unnecessary-if";
import * as unnecessaryStmt from "./revive/rules/unnecessary-stmt";
import * as unreachableCode from "./revive/rules/unreachable-code";
import * as unsecureUrlScheme from "./revive/rules/unsecure-url-scheme";
import * as unusedParameter from "./revive/rules/unused-parameter";
import * as unusedReceiver from "./revive/rules/unused-receiver";
import * as useAny from "./revive/rules/use-any";
import * as useErrorsNew from "./revive/rules/use-errors-new";
import * as useFmtPrint from "./revive/rules/use-fmt-print";
import * as useSlicesConcat from "./revive/rules/use-slices-concat";
import * as useSlicesSort from "./revive/rules/use-slices-sort";
import * as useWaitgroupGo from "./revive/rules/use-waitgroup-go";
import * as uselessBreak from "./revive/rules/useless-break";
import * as uselessFallthrough from "./revive/rules/useless-fallthrough";
import * as varDeclaration from "./revive/rules/var-declaration";
import * as varNaming from "./revive/rules/var-naming";
import * as waitgroupByValue from "./revive/rules/waitgroup-by-value";

// Rule options are typed tables named after their rule, rather than
// revive's untyped argument lists, which tsk's config cannot express.
interface Config {
  /** Rules to run. Without any, and without enable-all-rules, the default rules run. */
  enable: string[];
  /** Rules not to run, even if enabled. */
  disable: string[];
  /** Run every rule. */
  enableAllRules: boolean;
  /** Run the default rules as well as those in enable. */
  enableDefaultRules: boolean;
  /** Failures less certain than this, from 0 to 1, are not reported. */
  confidence: number;
  /** Directives to enforce: "specify-disable-reason" or "specify-disable-rule". */
  directives: ("specify-disable-reason" | "specify-disable-rule")[];
  /** Options for dot-imports. */
  dotImports: dotImports.Options;
  /** Options for exported. */
  exported: exported.Options;
  /** Options for var-naming. */
  varNaming: varNaming.Options;
  /** Options for indent-error-flow. */
  indentErrorFlow: indentErrorFlow.Options;
  /** Options for error-strings. */
  errorStrings: errorStrings.Options;
  /** Options for receiver-naming. */
  receiverNaming: receiverNaming.Options;
  /** Options for context-as-argument. */
  contextAsArgument: contextAsArgument.Options;
  /** Options for superfluous-else. */
  superfluousElse: superfluousElse.Options;
  /** Options for unused-parameter. */
  unusedParameter: unusedParameter.Options;
  /** Options for argument-limit. */
  argumentLimit: argumentLimit.Options;
  /** Options for cyclomatic. */
  cyclomatic: cyclomatic.Options;
  /** Options for file-header. */
  fileHeader: fileHeader.Options;
  /** Options for add-constant. */
  addConstant: addConstant.Options;
  /** Options for struct-tag. */
  structTag: structTag.Options;
  /** Options for imports-blocklist. */
  importsBlocklist: importsBlocklist.Options;
  /** Options for function-result-limit. */
  functionResultLimit: functionResultLimit.Options;
  /** Options for max-public-structs. */
  maxPublicStructs: maxPublicStructs.Options;
  /** Options for line-length-limit. */
  lineLengthLimit: lineLengthLimit.Options;
  /** Options for unused-receiver. */
  unusedReceiver: unusedReceiver.Options;
  /** Options for unhandled-error. */
  unhandledError: unhandledError.Options;
  /** Options for cognitive-complexity. */
  cognitiveComplexity: cognitiveComplexity.Options;
  /** Options for string-format. */
  stringFormat: stringFormat.Options;
  /** Options for early-return. */
  earlyReturn: earlyReturn.Options;
  /** Options for defer. */
  defer: defer.Options;
  /** Options for function-length. */
  functionLength: functionLength.Options;
  /** Options for unchecked-type-assertion. */
  uncheckedTypeAssertion: uncheckedTypeAssertion.Options;
  /** Options for banned-characters. */
  bannedCharacters: bannedCharacters.Options;
  /** Options for comment-spacings. */
  commentSpacings: commentSpacings.Options;
  /** Options for import-alias-naming. */
  importAliasNaming: importAliasNaming.Options;
  /** Options for enforce-map-style. */
  enforceMapStyle: enforceMapStyle.Options;
  /** Options for enforce-repeated-arg-type-style. */
  enforceRepeatedArgTypeStyle: enforceRepeatedArgTypeStyle.Options;
  /** Options for enforce-slice-style. */
  enforceSliceStyle: enforceSliceStyle.Options;
  /** Options for max-control-nesting. */
  maxControlNesting: maxControlNesting.Options;
  /** Options for comments-density. */
  commentsDensity: commentsDensity.Options;
  /** Options for file-length-limit. */
  fileLengthLimit: fileLengthLimit.Options;
  /** Options for filename-format. */
  filenameFormat: filenameFormat.Options;
  /** Options for enforce-switch-style. */
  enforceSwitchStyle: enforceSwitchStyle.Options;
  /** Options for identical-switch-branches. */
  identicalSwitchBranches: identicalSwitchBranches.Options;
  /** Options for package-directory-mismatch. */
  packageDirectoryMismatch: packageDirectoryMismatch.Options;
  /** Options for package-naming. */
  packageNaming: packageNaming.Options;
}

type RuleConfig = Pass<Config>["config"];

// rules creates each rule from its options, in revive's order.
const rules: Record<string, (config: RuleConfig) => Rule> = {
  "var-declaration": () => varDeclaration.create(),
  "package-comments": () => packageComments.create(),
  "dot-imports": (config) => dotImports.create(config.dotImports),
  "blank-imports": () => blankImports.create(),
  exported: (config) => exported.create(config.exported),
  "var-naming": (config) => varNaming.create(config.varNaming),
  "indent-error-flow": (config) => indentErrorFlow.create(config.indentErrorFlow),
  range: () => range.create(),
  errorf: () => errorf.create(),
  "error-naming": () => errorNaming.create(),
  "error-strings": (config) => errorStrings.create(config.errorStrings),
  "receiver-naming": (config) => receiverNaming.create(config.receiverNaming),
  "increment-decrement": () => incrementDecrement.create(),
  "error-return": () => errorReturn.create(),
  "unexported-return": () => unexportedReturn.create(),
  "time-naming": () => timeNaming.create(),
  "context-keys-type": () => contextKeysType.create(),
  "context-as-argument": (config) => contextAsArgument.create(config.contextAsArgument),
  "empty-block": () => emptyBlock.create(),
  "superfluous-else": (config) => superfluousElse.create(config.superfluousElse),
  "unused-parameter": (config) => unusedParameter.create(config.unusedParameter),
  "unreachable-code": () => unreachableCode.create(),
  "redefines-builtin-id": () => redefinesBuiltinId.create(),
  "argument-limit": (config) => argumentLimit.create(config.argumentLimit),
  cyclomatic: (config) => cyclomatic.create(config.cyclomatic),
  "file-header": (config) => fileHeader.create(config.fileHeader),
  "confusing-naming": () => confusingNaming.create(),
  "get-return": () => getReturn.create(),
  "modifies-parameter": () => modifiesParameter.create(),
  "confusing-results": () => confusingResults.create(),
  "deep-exit": () => deepExit.create(),
  "add-constant": (config) => addConstant.create(config.addConstant),
  "flag-parameter": () => flagParameter.create(),
  "unnecessary-stmt": () => unnecessaryStmt.create(),
  "struct-tag": (config) => structTag.create(config.structTag),
  "modifies-value-receiver": () => modifiesValueReceiver.create(),
  "constant-logical-expr": () => constantLogicalExpr.create(),
  "bool-literal-in-expr": () => boolLiteralInExpr.create(),
  "imports-blocklist": (config) => importsBlocklist.create(config.importsBlocklist),
  "function-result-limit": (config) => functionResultLimit.create(config.functionResultLimit),
  "max-public-structs": (config) => maxPublicStructs.create(config.maxPublicStructs),
  "range-val-in-closure": () => rangeValInClosure.create(),
  "range-val-address": () => rangeValAddress.create(),
  "waitgroup-by-value": () => waitgroupByValue.create(),
  atomic: () => atomic.create(),
  "empty-lines": () => emptyLines.create(),
  "line-length-limit": (config) => lineLengthLimit.create(config.lineLengthLimit),
  "call-to-gc": () => callToGc.create(),
  "duplicated-imports": () => duplicatedImports.create(),
  "import-shadowing": () => importShadowing.create(),
  "bare-return": () => bareReturn.create(),
  "unused-receiver": (config) => unusedReceiver.create(config.unusedReceiver),
  "unhandled-error": (config) => unhandledError.create(config.unhandledError),
  "cognitive-complexity": (config) => cognitiveComplexity.create(config.cognitiveComplexity),
  "string-of-int": () => stringOfInt.create(),
  "string-format": (config) => stringFormat.create(config.stringFormat),
  "early-return": (config) => earlyReturn.create(config.earlyReturn),
  "unconditional-recursion": () => unconditionalRecursion.create(),
  "identical-branches": () => identicalBranches.create(),
  defer: (config) => defer.create(config.defer),
  "unexported-naming": () => unexportedNaming.create(),
  "function-length": (config) => functionLength.create(config.functionLength),
  "nested-structs": () => nestedStructs.create(),
  "useless-break": () => uselessBreak.create(),
  "unchecked-type-assertion": (config) => uncheckedTypeAssertion.create(config.uncheckedTypeAssertion),
  "time-equal": () => timeEqual.create(),
  "time-date": () => timeDate.create(),
  "banned-characters": (config) => bannedCharacters.create(config.bannedCharacters),
  "optimize-operands-order": () => optimizeOperandsOrder.create(),
  "use-any": () => useAny.create(),
  datarace: () => datarace.create(),
  "comment-spacings": (config) => commentSpacings.create(config.commentSpacings),
  "if-return": () => ifReturn.create(),
  "redundant-import-alias": () => redundantImportAlias.create(),
  "import-alias-naming": (config) => importAliasNaming.create(config.importAliasNaming),
  "enforce-map-style": (config) => enforceMapStyle.create(config.enforceMapStyle),
  "enforce-repeated-arg-type-style": (config) => enforceRepeatedArgTypeStyle.create(config.enforceRepeatedArgTypeStyle),
  "enforce-slice-style": (config) => enforceSliceStyle.create(config.enforceSliceStyle),
  "max-control-nesting": (config) => maxControlNesting.create(config.maxControlNesting),
  "comments-density": (config) => commentsDensity.create(config.commentsDensity),
  "file-length-limit": (config) => fileLengthLimit.create(config.fileLengthLimit),
  "filename-format": (config) => filenameFormat.create(config.filenameFormat),
  "redundant-build-tag": () => redundantBuildTag.create(),
  "use-errors-new": () => useErrorsNew.create(),
  "unnecessary-format": () => unnecessaryFormat.create(),
  "use-fmt-print": () => useFmtPrint.create(),
  "enforce-switch-style": (config) => enforceSwitchStyle.create(config.enforceSwitchStyle),
  "identical-switch-conditions": () => identicalSwitchConditions.create(),
  "identical-ifelseif-conditions": () => identicalIfelseifConditions.create(),
  "identical-ifelseif-branches": () => identicalIfelseifBranches.create(),
  "identical-switch-branches": (config) => identicalSwitchBranches.create(config.identicalSwitchBranches),
  "useless-fallthrough": () => uselessFallthrough.create(),
  "package-directory-mismatch": (config) => packageDirectoryMismatch.create(config.packageDirectoryMismatch),
  "use-waitgroup-go": () => useWaitgroupGo.create(),
  "unsecure-url-scheme": () => unsecureUrlScheme.create(),
  "inefficient-map-lookup": () => inefficientMapLookup.create(),
  "forbidden-call-in-wg-go": () => forbiddenCallInWgGo.create(),
  "unnecessary-if": () => unnecessaryIf.create(),
  "epoch-naming": () => epochNaming.create(),
  "use-slices-sort": () => useSlicesSort.create(),
  "use-slices-concat": () => useSlicesConcat.create(),
  "package-naming": (config) => packageNaming.create(config.packageNaming),
  "multiline-if-init": () => multilineIfInit.create(),
  "marshal-receiver": () => marshalReceiver.create(),
};

const allRules = Object.keys(rules);

const defaultRules = [
  "var-declaration",
  "package-comments",
  "dot-imports",
  "blank-imports",
  "exported",
  "var-naming",
  "indent-error-flow",
  "range",
  "errorf",
  "error-naming",
  "error-strings",
  "receiver-naming",
  "increment-decrement",
  "error-return",
  "unexported-return",
  "time-naming",
  "context-keys-type",
  "context-as-argument",
  "empty-block",
  "superfluous-else",
  "unused-parameter",
  "unreachable-code",
  "redefines-builtin-id",
];

// ruleName resolves the old name revive still accepts for a rule.
function ruleName(name: string): string {
  const actual = name === "imports-blacklist" ? "imports-blocklist" : name;
  if (!allRules.includes(actual)) {
    throw new Error(`cannot find rule: ${name}`);
  }
  return actual;
}

// enabledRules selects rules as revive does, except that disabling a rule
// does not, alone, turn the default rules off.
function enabledRules(config: RuleConfig): string[] {
  if (config.enableAllRules && config.enableDefaultRules) {
    throw new Error("config options enable-all-rules and enable-default-rules cannot be combined");
  }
  const enable = config.enable.map(ruleName);
  const disable = new Set(config.disable.map(ruleName));
  let selected: Set<string>;
  if (config.enableAllRules) {
    selected = new Set(allRules);
  } else if (config.enableDefaultRules || enable.length === 0) {
    selected = new Set([...defaultRules, ...enable]);
  } else {
    selected = new Set(enable);
  }
  return allRules.filter((name) => selected.has(name) && !disable.has(name));
}

export default defineAnalyzer<Config>({
  name: "revive",
  doc: "Fast, configurable, extensible, flexible, and beautiful linter for Go. Drop-in replacement of golint.",
  // Revive type-checks packages itself and lints with partial type information.
  runDespiteErrors: true,
  config: {
    enable: [],
    disable: [],
    enableAllRules: false,
    enableDefaultRules: false,
    confidence: 0.8,
    directives: [],
    dotImports: dotImports.defaults,
    exported: exported.defaults,
    varNaming: varNaming.defaults,
    indentErrorFlow: indentErrorFlow.defaults,
    errorStrings: errorStrings.defaults,
    receiverNaming: receiverNaming.defaults,
    contextAsArgument: contextAsArgument.defaults,
    superfluousElse: superfluousElse.defaults,
    unusedParameter: unusedParameter.defaults,
    argumentLimit: argumentLimit.defaults,
    cyclomatic: cyclomatic.defaults,
    fileHeader: fileHeader.defaults,
    addConstant: addConstant.defaults,
    structTag: structTag.defaults,
    importsBlocklist: importsBlocklist.defaults,
    functionResultLimit: functionResultLimit.defaults,
    maxPublicStructs: maxPublicStructs.defaults,
    lineLengthLimit: lineLengthLimit.defaults,
    unusedReceiver: unusedReceiver.defaults,
    unhandledError: unhandledError.defaults,
    cognitiveComplexity: cognitiveComplexity.defaults,
    stringFormat: stringFormat.defaults,
    earlyReturn: earlyReturn.defaults,
    defer: defer.defaults,
    functionLength: functionLength.defaults,
    uncheckedTypeAssertion: uncheckedTypeAssertion.defaults,
    bannedCharacters: bannedCharacters.defaults,
    commentSpacings: commentSpacings.defaults,
    importAliasNaming: importAliasNaming.defaults,
    enforceMapStyle: enforceMapStyle.defaults,
    enforceRepeatedArgTypeStyle: enforceRepeatedArgTypeStyle.defaults,
    enforceSliceStyle: enforceSliceStyle.defaults,
    maxControlNesting: maxControlNesting.defaults,
    commentsDensity: commentsDensity.defaults,
    fileLengthLimit: fileLengthLimit.defaults,
    filenameFormat: filenameFormat.defaults,
    enforceSwitchStyle: enforceSwitchStyle.defaults,
    identicalSwitchBranches: identicalSwitchBranches.defaults,
    packageDirectoryMismatch: packageDirectoryMismatch.defaults,
    packageNaming: packageNaming.defaults,
  },
  run(pass) {
    const config = pass.config;
    // Rules are created per package, so state they keep never crosses packages.
    const enabled = enabledRules(config).map((name) => rules[name](config));
    const directives = {
      specifyDisableReason: config.directives.includes("specify-disable-reason"),
      specifyDisableRule: config.directives.includes("specify-disable-rule"),
    };
    // Without a go.mod, revive assumes Go 1.0.
    const pkg = new Package(pass, pass.module?.goVersion || "1.0");
    for (const file of pkg.files) {
      for (const failure of lintFile(file, enabled, config.confidence, directives)) {
        pass.report({ pos: failure.pos, end: failure.end, message: `${failure.ruleName}: ${failure.failure}` });
      }
    }
  },
});
