// testifylint's advanced checkers, which examine a whole package.
import * as ast from "go/ast";
import type * as types from "go/types";
import type { Diagnostic } from "tsk";
import {
  type AnyPass,
  type CallMeta,
  callString,
  type FuncID,
  findSurroundingFunc,
  hasTestingTParam,
  implementsSuiteInterface,
  implementsTestifySuite,
  implementsTestingT,
  isAssertionStmt,
  isIdentWithName,
  isSubTestRun,
  isSuiteMethod,
  isSuiteServiceMethod,
  isSuiteTestMethod,
  isTestingFuncOrMethod,
  nearest,
  newCallMeta,
  newDiagnostic,
  nodeString,
  testifyPackages,
  walkWithStack,
} from "./helpers";

export interface AdvancedChecker {
  name: string;
  check(pass: AnyPass): Diagnostic[];
}

// walkNodes visits nodes of the given types like inspector.Nodes: visit is
// called on entering a node, and again on leaving it unless entering
// returned false, which also skips its children.
function walkNodes(pass: AnyPass, kinds: Set<string>, visit: (node: ast.Node, push: boolean) => boolean): void {
  for (const file of pass.files) {
    const entered: (ast.Node | null)[] = [];
    ast.inspect(file, (node) => {
      if (node === null) {
        const left = entered.pop();
        if (left) {
          visit(left, false);
        }
        return true;
      }
      if (!kinds.has(node.$type)) {
        entered.push(null);
        return true;
      }
      if (!visit(node, true)) {
        return false;
      }
      entered.push(node);
      return true;
    });
  }
}

function preorder<T extends ast.Node["$type"]>(pass: AnyPass, type: T, visit: (node: Extract<ast.Node, { $type: T }>) => void): void {
  for (const file of pass.files) {
    ast.inspect(file, (node) => {
      if (node?.$type === type) {
        visit(node as Extract<ast.Node, { $type: T }>);
      }
      return true;
    });
  }
}

export function blankImport(): AdvancedChecker {
  const name = "blank-import";
  return {
    name,
    check(pass) {
      const diagnostics: Diagnostic[] = [];
      for (const file of pass.files) {
        for (const imp of file.imports) {
          const path = imp!.path!.value.slice(1, -1);
          if (imp!.name?.name === "_" && testifyPackages.has(path)) {
            diagnostics.push(newDiagnostic(name, imp!, `avoid blank import of ${path} as it does nothing`));
          }
        }
      }
      return diagnostics;
    },
  };
}

type Verdict = "noExit" | "require" | "assertFailNow";

function callVerdict(call: CallMeta): Verdict {
  if (!call.isAssert) {
    return "require";
  }
  return call.fn.nameFTrimmed === "FailNow" ? "assertFailNow" : "noExit";
}

export function goRequire(ignoreHTTPHandlers: boolean): AdvancedChecker {
  const name = "go-require";
  return {
    name,
    check(pass) {
      const diagnostics: Diagnostic[] = [];
      const testsDecls = new Map<types.Func, ast.FuncDecl>();
      preorder(pass, "FuncDecl", (fd) => {
        const fn = isTestingFuncOrMethod(pass, fd) ? pass.typesInfo.objectOf(fd.name!) : null;
        if (fn?.$type === "Func") {
          testsDecls.set(fn, fd);
        }
      });
      const calledDecl = (ce: ast.CallExpr): ast.FuncDecl | null => {
        const fun = ce.fun;
        let ident: ast.Ident | null = null;
        if (fun?.$type === "SelectorExpr") {
          ident = fun.sel;
        } else if (fun?.$type === "Ident") {
          ident = fun;
        } else if ((fun?.$type === "IndexExpr" || fun?.$type === "IndexListExpr") && fun.x?.$type === "Ident") {
          ident = fun.x;
        }
        const object = ident === null ? null : pass.typesInfo.objectOf(ident);
        return object?.$type === "Func" ? (testsDecls.get(object) ?? null) : null;
      };
      const processed = new Map<ast.FuncDecl, Verdict>();
      // inProgress guards against mutual recursion, on which upstream would
      // recurse forever.
      const inProgress = new Set<ast.FuncDecl>();
      const checkFunc = (fd: ast.FuncDecl): Verdict => {
        const cached = processed.get(fd);
        if (cached !== undefined) {
          return cached;
        }
        if (inProgress.has(fd)) {
          return "noExit";
        }
        inProgress.add(fd);
        let result: Verdict = "noExit";
        ast.inspect(fd, (node) => {
          if (result !== "noExit" || node?.$type === "GoStmt") {
            return false;
          }
          if (node?.$type !== "CallExpr") {
            return true;
          }
          const testifyCall = newCallMeta(pass, node);
          if (testifyCall !== null) {
            const verdict = callVerdict(testifyCall);
            if (verdict !== "noExit") {
              result = verdict;
              processed.set(fd, verdict);
            }
            return false;
          }
          const called = calledDecl(node);
          if (called === null || called === fd) {
            return true;
          }
          const verdict = checkFunc(called);
          if (verdict !== "noExit") {
            result = verdict;
            return false;
          }
          return true;
        });
        inProgress.delete(fd);
        return result;
      };
      // inTestGoroutine holds, for each enclosing context, whether it runs
      // in the test's goroutine.
      const inTestGoroutine: boolean[] = [];
      const scoped = (push: boolean, value: boolean) => {
        if (push) {
          inTestGoroutine.push(value);
        } else {
          inTestGoroutine.pop();
        }
        return true;
      };
      walkNodes(pass, new Set(["FuncDecl", "FuncType", "GoStmt", "CallExpr"]), (node, push) => {
        if (node.$type === "FuncDecl") {
          return isTestingFuncOrMethod(pass, node) && scoped(push, true);
        }
        if (node.$type === "FuncType") {
          return hasTestingTParam(pass, node) && scoped(push, true);
        }
        if (node.$type === "GoStmt") {
          return scoped(push, false);
        }
        const ce = node as ast.CallExpr;
        if (isSubTestRun(pass, ce)) {
          return scoped(push, true);
        }
        if (!push) {
          return false;
        }
        if (inTestGoroutine.length === 0 || inTestGoroutine[inTestGoroutine.length - 1]) {
          return true;
        }
        const testifyCall = newCallMeta(pass, ce);
        if (testifyCall !== null) {
          const verdict = callVerdict(testifyCall);
          if (verdict !== "noExit") {
            const what = verdict === "require" ? "require" : callString(testifyCall);
            diagnostics.push(newDiagnostic(name, ce, `${what} must only be used in the goroutine running the test function`));
          }
          return false;
        }
        const called = calledDecl(ce);
        if (called !== null && checkFunc(called) !== "noExit") {
          diagnostics.push(
            newDiagnostic(name, ce, `${nodeString(pass, ce.fun!)} contains assertions that must only be used in the goroutine running the test function`),
          );
        }
        return true;
      });
      if (!ignoreHTTPHandlers) {
        walkWithStack(pass, (node, stack) => {
          if (node.$type !== "CallExpr" || stack.length < 3) {
            return true;
          }
          const fn = findSurroundingFunc(pass, stack);
          const testifyCall = fn?.isHTTPHandler ? newCallMeta(pass, node) : null;
          if (testifyCall === null) {
            return true;
          }
          const verdict = callVerdict(testifyCall);
          if (verdict !== "noExit") {
            const what = verdict === "require" ? "require" : callString(testifyCall);
            diagnostics.push(newDiagnostic(name, node, `do not use ${what} in http handlers`));
          }
          return false;
        });
      }
      return diagnostics;
    },
  };
}

interface RequireErrorCall {
  call: ast.CallExpr;
  testifyCall: CallMeta | null;
  // rootIf is the first if of an if-else chain, and parentIf the nearest.
  rootIf: ast.IfStmt | null;
  parentIf: ast.IfStmt | null;
  parentBlock: ast.BlockStmt | null;
  // inIfCond is set for code like `if assert.ErrorAs(t, err, &target) {`.
  inIfCond: boolean;
  // inBoolExpr is set for code like `assert.Error(t, err) && ...`.
  inBoolExpr: boolean;
  // inNoErrorSeq is set for a sequence of NoError assertions.
  inNoErrorSeq: boolean;
}

const errorAssertions = new Set(["Error", "ErrorIs", "ErrorAs", "EqualError", "ErrorContains", "NoError", "NotErrorIs"]);

export function requireError(fnPattern: RegExp | null): AdvancedChecker {
  const name = "require-error";
  return {
    name,
    check(pass) {
      const callsByFunc = new Map<string, { fn: FuncID; calls: RequireErrorCall[] }>();
      walkWithStack(pass, (node, stack) => {
        if (node.$type !== "CallExpr" || stack.length < 3) {
          return true;
        }
        const fn = findSurroundingFunc(pass, stack);
        if (fn === null) {
          return true;
        }
        const parent = stack[stack.length - 2];
        const grandparent = stack[stack.length - 3];
        const testifyCall = newCallMeta(pass, node);
        const call: RequireErrorCall = {
          call: node,
          testifyCall,
          rootIf: rootIf(stack),
          parentIf: nearest(stack, "IfStmt")[0],
          parentBlock: nearest(stack, "BlockStmt")[0],
          inIfCond: parent.$type === "IfStmt" || (grandparent.$type === "IfStmt" && parent.$type === "AssignStmt"),
          inBoolExpr: parent.$type === "BinaryExpr",
          inNoErrorSeq: false,
        };
        const entry = callsByFunc.get(fn.key) ?? { fn, calls: [] };
        entry.calls.push(call);
        callsByFunc.set(fn.key, entry);
        // Assertions within assertions are not checked.
        return testifyCall === null;
      });
      const callsByBlock = new Map<ast.BlockStmt, RequireErrorCall[]>();
      for (const { calls } of callsByFunc.values()) {
        for (const c of calls) {
          if (c.parentBlock !== null) {
            callsByBlock.set(c.parentBlock, [...(callsByBlock.get(c.parentBlock) ?? []), c]);
          }
        }
      }
      markNoErrorSequences(callsByBlock);
      const diagnostics: Diagnostic[] = [];
      for (const { fn, calls } of callsByFunc.values()) {
        if (fn.isTestCleanup || fn.isGoroutine || fn.isHTTPHandler) {
          continue;
        }
        calls.forEach((c, i) => {
          const tc = c.testifyCall;
          if (tc === null || !tc.isAssert || !errorAssertions.has(tc.fn.nameFTrimmed)) {
            return;
          }
          if (skipForContext(c, i, calls, callsByBlock) || (fnPattern !== null && !fnPattern.test(tc.fn.name))) {
            return;
          }
          diagnostics.push(newDiagnostic(name, tc.call, "for error assertions use require"));
        });
      }
      return diagnostics;
    },
  };
}

function rootIf(stack: ast.Node[]): ast.IfStmt | null {
  let [root, i] = nearest(stack, "IfStmt");
  for (; i > 0 && stack[i - 1].$type === "IfStmt"; i--) {
    root = stack[i - 1] as ast.IfStmt;
  }
  return root;
}

function isNoError(name: string): boolean {
  return name === "NoError" || name === "NoErrorf";
}

function markNoErrorSequences(callsByBlock: Map<ast.BlockStmt, RequireErrorCall[]>): void {
  for (const calls of callsByBlock.values()) {
    calls.forEach((c, i) => {
      if (c.testifyCall === null) {
        return;
      }
      const prev = i > 0 ? calls[i - 1].testifyCall : null;
      const next = i < calls.length - 1 ? calls[i + 1].testifyCall : null;
      const neighbour = (prev !== null && isNoError(prev.fn.name)) || (next !== null && isNoError(next.fn.name));
      if (isNoError(c.testifyCall.fn.name) && neighbour) {
        c.inNoErrorSeq = true;
      }
    });
  }
}

// skipForContext reports whether an error assertion's context makes assert
// reasonable, as when it is a condition or the block's last call.
function skipForContext(curr: RequireErrorCall, index: number, others: RequireErrorCall[], callsByBlock: Map<ast.BlockStmt, RequireErrorCall[]>): boolean {
  if (curr.inIfCond || curr.inBoolExpr || curr.inNoErrorSeq) {
    return true;
  }
  if (curr.rootIf !== null && others.some((other) => other.rootIf === curr.rootIf && other.inIfCond)) {
    return true;
  }
  const block = curr.parentBlock!;
  const blockCalls = callsByBlock.get(block)!;
  const isLastInBlock = blockCalls[blockCalls.length - 1] === curr;
  let noCallsAfter = true;
  if (block.list[block.list.length - 1]?.$type !== "ReturnStmt") {
    for (const next of others.slice(index + 1)) {
      let inElse = false;
      const elseStmt = curr.parentIf?.else ?? null;
      if (elseStmt !== null) {
        ast.inspect(elseStmt, (n) => {
          if (n === next.call) {
            inElse = true;
          }
          return !inElse;
        });
      }
      if (!inElse) {
        noCallsAfter = false;
        break;
      }
    }
  }
  return isLastInBlock && noCallsAfter;
}

export function suiteBrokenParallel(): AdvancedChecker {
  const name = "suite-broken-parallel";
  return {
    name,
    check(pass) {
      const diagnostics: Diagnostic[] = [];
      walkWithStack(pass, (node, stack) => {
        if (node.$type !== "CallExpr" || node.fun?.$type !== "SelectorExpr") {
          return true;
        }
        const se = node.fun;
        if (!isIdentWithName("Parallel", se.sel) || !implementsTestingT(pass, se.x!)) {
          return true;
        }
        const inSuiteMethod = stack.slice(0, -1).some((n) => n.$type === "FuncDecl" && isSuiteMethod(pass, n));
        if (!inSuiteMethod) {
          return true;
        }
        const nextLine = pass.fset.position(node.pos()).line + 1;
        diagnostics.push(
          newDiagnostic(name, node, "testify v1 does not support suite's parallel tests and subtests", {
            message: `Remove \`${nodeString(pass, node)}\` call`,
            textEdits: [{ pos: node.pos(), end: pass.fset.file(node.pos())!.lineStart(nextLine), newText: "" }],
          }),
        );
        return false;
      });
      return diagnostics;
    },
  };
}

const suiteMethodToInterface = new Map([
  ["SetupSuite", "SetupAllSuite"],
  ["SetupTest", "SetupTestSuite"],
  ["TearDownSuite", "TearDownAllSuite"],
  ["TearDownTest", "TearDownTestSuite"],
  ["BeforeTest", "BeforeTest"],
  ["AfterTest", "AfterTest"],
  ["HandleStats", "WithStats"],
  ["SetupSubTest", "SetupSubTest"],
  ["TearDownSubTest", "TearDownSubTest"],
]);

export function suiteMethodSignature(): AdvancedChecker {
  const name = "suite-method-signature";
  return {
    name,
    check(pass) {
      const diagnostics: Diagnostic[] = [];
      preorder(pass, "FuncDecl", (fd) => {
        if (!isSuiteMethod(pass, fd)) {
          return;
        }
        const method = fd.name!.name;
        if (isSuiteTestMethod(method) && (fd.type!.params!.numFields() > 0 || (fd.type!.results?.numFields() ?? 0) > 0)) {
          diagnostics.push(newDiagnostic(name, fd, "test method should not have any arguments or returning values"));
          return;
        }
        const iface = suiteMethodToInterface.get(method);
        if (iface !== undefined && implementsSuiteInterface(pass, fd.recv!.list[0]!.type!, iface) === false) {
          diagnostics.push(newDiagnostic(name, fd, `method conflicts with suite.${iface} interface`));
        }
      });
      return diagnostics;
    },
  };
}

export function suiteSubtestRun(): AdvancedChecker {
  const name = "suite-subtest-run";
  return {
    name,
    check(pass) {
      const diagnostics: Diagnostic[] = [];
      // s.T().Run
      preorder(pass, "CallExpr", (ce) => {
        const se = ce.fun;
        if (se?.$type !== "SelectorExpr" || !isIdentWithName("Run", se.sel) || se.x?.$type !== "CallExpr") {
          return;
        }
        const tCall = se.x;
        const tSel = tCall.fun;
        if (tSel?.$type !== "SelectorExpr" || !isIdentWithName("T", tSel.sel)) {
          return;
        }
        if (implementsTestifySuite(pass, tSel.x!) && implementsTestingT(pass, tCall)) {
          diagnostics.push(newDiagnostic(name, ce, `use ${nodeString(pass, tSel.x!)}.Run to run subtest`));
        }
      });
      return diagnostics;
    },
  };
}

export function suiteTHelper(): AdvancedChecker {
  const name = "suite-thelper";
  return {
    name,
    check(pass) {
      const diagnostics: Diagnostic[] = [];
      preorder(pass, "FuncDecl", (fd) => {
        const method = fd.name?.name;
        if (!isSuiteMethod(pass, fd) || method === undefined || isSuiteTestMethod(method) || isSuiteServiceMethod(method)) {
          return;
        }
        if (fd.body === null || !fd.body.list.some((stmt) => isAssertionStmt(pass, stmt))) {
          return;
        }
        const rcv = fd.recv!.list[0]!;
        if (rcv.names.length !== 1 || rcv.names[0] === null) {
          return;
        }
        const helper = `${rcv.names[0].name}.T().Helper()`;
        const first = fd.body.list[0]!;
        if (nodeString(pass, first) === helper) {
          return;
        }
        diagnostics.push(
          newDiagnostic(name, fd, `suite helper method must start with ${helper}`, {
            message: `Insert \`${helper}\``,
            textEdits: [{ pos: first.pos(), end: first.pos(), newText: `${helper}\n\n` }],
          }),
        );
      });
      return diagnostics;
    },
  };
}
