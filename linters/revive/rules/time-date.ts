import type * as ast from "go/ast";
import * as constant from "go/constant";
import * as token from "go/token";
import { goFmt, isIdent, isPkgDotName, walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "time-date";

const argumentNames = ["year", "month", "day", "hour", "minute", "second", "nanosecond", "timezone"];
const arity = argumentNames.length;

const boundaries = new Map<string, [bigint, bigint]>([
  ["month", [1n, 12n]],
  ["day", [1n, 31n]],
  ["hour", [0n, 23n]],
  ["minute", [0n, 59n]],
  ["second", [0n, 60n]],
  ["nanosecond", [0n, 999999999n]],
]);

const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const errOctal = "octal notation";
const errOctalWithZero = "octal notation with leading zero";
const errOctalWithPaddingZeroes = "octal notation with padding zeroes";
const errHexadecimal = "hexadecimal notation";
const errBinary = "binary notation";
const errFloat = "float literal";
const errExponential = "exponential notation";
const errAlternative = "alternative notation";
const errInvalid = "invalid notation";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  walk(
    {
      visit(n) {
        if (n !== null && n.$type === "CallExpr") {
          check(n as ast.CallExpr, failures);
        }
        return this;
      },
    },
    file.ast,
  );
  return failures;
}

function check(ce: ast.CallExpr, failures: Failure[]): void {
  if (ce.args.length !== arity || !isPkgDotName(ce.fun, "time", "Date")) {
    return;
  }
  const tzArg = ce.args[arity - 1]!;
  if (isIdent(tzArg, "nil")) {
    failures.push({ node: tzArg, confidence: 1, failure: "time.Date timezone argument cannot be nil, it would panic on runtime" });
  }
  let year = 0n;
  let month = 0n;
  ce.args.slice(0, arity - 1).forEach((a, pos) => {
    const arg = a!;
    const fieldName = argumentNames[pos];
    const bl = checkArgSign(arg, fieldName, failures);
    if (bl === null) {
      return;
    }
    const [value, err] = parseDecimalInteger(bl);
    if (err === null) {
      if (fieldName === "year") {
        year = value;
        return;
      }
      const bounds = boundaries.get(fieldName);
      if (bounds === undefined) {
        return;
      }
      let [minValue, maxValue] = bounds;
      if (fieldName === "month") {
        month = value;
        if (value === 0n) {
          failures.push({ node: arg, confidence: 1, failure: "time.Date month argument should not be zero" });
          return;
        }
      } else if (fieldName === "day") {
        if (value === 0n) {
          failures.push({ node: arg, confidence: 1, failure: "time.Date day argument should not be zero" });
          return;
        } else if (month >= 1n && month <= 12n) {
          maxValue = daysInMonth(year, Number(month));
          let monthName = monthNames[Number(month) - 1];
          if (month === 2n) {
            monthName += ` ${year}`;
          }
          if (value > maxValue) {
            failures.push({ node: arg, confidence: 0.8, failure: `time.Date day argument is ${value}, but ${monthName} has only ${maxValue} days` });
            return;
          }
        } else if (month > 12n && month <= 31n && value <= 12n) {
          const realMonth = value;
          const realDay = month;
          if (realDay <= daysInMonth(year, Number(realMonth))) {
            failures.push({
              node: arg,
              confidence: 0.5,
              failure: `time.Date month and day arguments appear to be swapped: ${year}-${pad2(realMonth)}-${pad2(realDay)} vs ${year}-${pad2(month)}-${pad2(value)}`,
            });
          }
        }
      }
      if (value < minValue || value > maxValue) {
        failures.push({ node: arg, confidence: 0.8, failure: `time.Date ${fieldName} argument should be between ${minValue} and ${maxValue}: ${goFmt(arg)}` });
      }
      return;
    }
    // Upstream logs unparsable literals and moves on.
    if (err === errInvalid) {
      return;
    }
    let confidence = 0.8;
    const replacedValue = `${value}`;
    let instructions = `use ${replacedValue} instead of ${goFmt(arg)}`;
    if (err === errOctalWithZero) {
      confidence = 0.5;
    } else if (err === errOctalWithPaddingZeroes) {
      confidence = 1;
      const strippedValue = bl.value.replace(/^0+/, "") || "0";
      if (strippedValue !== replacedValue) {
        instructions = `choose between ${strippedValue} and ${replacedValue} (decimal value of ${strippedValue} octal value)`;
      }
    }
    failures.push({ node: bl, confidence, failure: `use decimal digits for time.Date ${fieldName} argument: ${err} found: ${instructions}` });
  });
}

function pad2(n: bigint): string {
  const s = `${n}`;
  return s.length < 2 ? `0${s}` : s;
}

function checkArgSign(arg: ast.Expr, fieldName: string, failures: Failure[]): ast.BasicLit | null {
  if (arg.$type === "BasicLit") {
    return arg as ast.BasicLit;
  }
  if (arg.$type !== "UnaryExpr") {
    return null;
  }
  const node = arg as ast.UnaryExpr;
  if (node.x === null || node.x.$type !== "BasicLit") {
    return null;
  }
  const bl = node.x as ast.BasicLit;
  if (fieldName === "year" && node.op === token.SUB) {
    return bl;
  }
  if (node.op === token.SUB) {
    failures.push({ node: arg, confidence: 0.5, failure: `time.Date ${fieldName} argument is negative: ${goFmt(arg)}` });
  } else if (node.op === token.ADD) {
    failures.push({ node: arg, confidence: 0.8, failure: `time.Date ${fieldName} argument contains a useless plus sign: ${goFmt(arg)}` });
  }
  return null;
}

// isLeapYear follows the proleptic Gregorian calendar, as time.Date does.
function isLeapYear(year: bigint): boolean {
  return year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
}

function daysInMonth(year: bigint, month: number): bigint {
  switch (month) {
    case 4:
    case 6:
    case 9:
    case 11:
      return 30n;
    case 2:
      return isLeapYear(year) ? 29n : 28n;
  }
  return 31n;
}

const maxInt64 = 9223372036854775807n;

function parseDecimalInteger(bl: ast.BasicLit): [bigint, string | null] {
  const currentValue = bl.value.toLowerCase();
  if (currentValue === "0") {
    return [0n, null];
  }
  if (bl.kind === token.FLOAT) {
    const parsed = constant.float64Val(constant.makeFromLiteral(bl.value, token.FLOAT, 0));
    if (parsed === undefined || !Number.isFinite(parsed)) {
      return [0n, errInvalid];
    }
    const value = BigInt(Math.trunc(parsed));
    return [value, currentValue.includes("e") ? errExponential : errFloat];
  }
  if (bl.kind !== token.INT) {
    return [0n, errInvalid];
  }
  // strconv.ParseInt with base 0 reads a leading "0" as octal.
  let digits = currentValue.replace(/_/g, "");
  if (/^0[0-7]+$/.test(digits)) {
    digits = `0o${digits.slice(1)}`;
  }
  let value: bigint;
  try {
    value = BigInt(digits);
  } catch {
    return [0n, errInvalid];
  }
  if (value > maxInt64) {
    return [0n, errInvalid];
  }
  if (currentValue.startsWith("0b")) {
    return [value, errBinary];
  }
  if (currentValue.startsWith("0x")) {
    return [value, errHexadecimal];
  }
  if (currentValue.startsWith("0")) {
    if (/^0[0-7]$/.test(currentValue)) {
      return [value, errOctalWithZero];
    }
    if (currentValue.startsWith("00")) {
      return [value, errOctalWithPaddingZeroes];
    }
    return [value, errOctal];
  }
  if (`${value}` !== currentValue) {
    return [value, errAlternative];
  }
  return [value, null];
}
