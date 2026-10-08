import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer, type Pass } from "tsk";
import { unquote } from "./internal/strconv";

type LintFunc = "Help" | "MetricUnits" | "Counter" | "HistogramSummaryReserved" | "MetricTypeInName" | "ReservedChars" | "CamelCase" | "lintUnitAbbreviations";

interface Config {
  /** Also report metric declarations that cannot be parsed. */
  strict: boolean;
  /** promlint checks to skip, such as "Help" or "CamelCase". */
  disabledLinters: LintFunc[];
}

type MetricType = "COUNTER" | "GAUGE" | "SUMMARY" | "UNTYPED" | "HISTOGRAM";

// Family is a metric parsed from source. A null type reads as a counter, as
// protobuf's zero value does.
interface Family {
  name: string;
  help: string | null;
  type: MetricType | null;
  // labels are those of the family's sample metric, or null for none.
  labels: { name: string; value: string | null }[] | null;
}

// Opts holds the fields parsed from a composite literal such as CounterOpts.
interface Opts {
  namespace: string;
  subsystem: string;
  name: string;
  help: string | null;
  labels: string[];
  constLabels: [string, string][];
}

const metricTypes: Record<string, MetricType> = {
  Counter: "COUNTER",
  NewCounter: "COUNTER",
  NewCounterVec: "COUNTER",
  Gauge: "GAUGE",
  NewGauge: "GAUGE",
  NewGaugeVec: "GAUGE",
  NewHistogram: "HISTOGRAM",
  NewHistogramVec: "HISTOGRAM",
  NewSummary: "SUMMARY",
  NewSummaryVec: "SUMMARY",
};

const constMetricArgs: Record<string, number> = { MustNewConstMetric: 3, MustNewHistogram: 4, MustNewSummary: 4, NewLazyConstMetric: 3 };

const optsFields = new Set(["Name", "Namespace", "Subsystem", "Help"]);

// lintFuncText maps each check to text that identifies its problems.
const lintFuncText: Record<LintFunc, string[]> = {
  Help: ["no help text"],
  MetricUnits: ["use base unit"],
  Counter: ["counter metrics should"],
  HistogramSummaryReserved: ["non-histogram", "non-summary"],
  MetricTypeInName: ["metric name should not include type"],
  ReservedChars: ["metric names should not contain ':'"],
  CamelCase: ["'snake_case' not 'camelCase'"],
  lintUnitAbbreviations: ["metric names should not contain abbreviated units"],
};

export default defineAnalyzer<Config>({
  name: "promlinter",
  doc: "Check Prometheus metrics naming via promlint",
  url: "https://github.com/yeya24/promlinter",
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: { strict: false, disabledLinters: [] },
  run(pass) {
    const parser = new Parser(pass);
    for (const file of pass.files) {
      ast.inspect(file, (node) => {
        if (node?.$type === "CallExpr") {
          parser.parseCall(node);
        } else if (node?.$type === "SendStmt") {
          parser.parseSend(node);
        }
        return true;
      });
    }
    const disabled = pass.config.disabledLinters.flatMap((name) => lintFuncText[name] ?? []);
    for (const { family, pos } of parser.metrics) {
      for (const problem of lint(family).sort()) {
        if (!disabled.some((pattern) => problem.includes(pattern))) {
          pass.report({ pos, message: `Metric: ${family.name} Error: ${problem}` });
        }
      }
    }
  },
});

class Parser {
  readonly metrics: { family: Family; pos: token.Pos }[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly pass: Pass<Config>) {}

  parseCall(call: ast.CallExpr): void {
    const fun = call.fun;
    let name: string;
    if (fun?.$type === "Ident") {
      name = fun.name;
    } else if (fun?.$type === "SelectorExpr") {
      name = fun.sel!.name;
      if (name === "NewFamilyGenerator" && call.args.length === 5) {
        this.parseKSMMetric(call.args[0]!, call.args[1]!, call.args[2]!);
        return;
      }
    } else {
      return;
    }
    if (name === "NewCounterFunc" || name === "NewGaugeFunc") {
      this.parseOpts(call.args as ast.Expr[], name === "NewCounterFunc" ? "COUNTER" : "GAUGE");
      return;
    }
    const type = metricTypes[name];
    if (type === undefined) {
      return;
    }
    const argNum = name.endsWith("Vec") ? 2 : 1;
    if (call.args.length < argNum && this.pass.config.strict) {
      this.issue(call.pos(), `${name} should have at least ${argNum} arguments`);
      return;
    }
    this.parseOpts(call.args as ast.Expr[], type);
  }

  parseSend(send: ast.SendStmt): void {
    const call = send.value;
    if (call?.$type !== "CallExpr") {
      return;
    }
    const fun = call.fun;
    const method = fun?.$type === "Ident" ? fun.name : fun?.$type === "SelectorExpr" ? fun.sel!.name : "";
    const required = constMetricArgs[method];
    if (required === undefined) {
      return;
    }
    if (call.args.length < required && this.pass.config.strict) {
      this.issue(call.pos(), `${method} should have at least ${required} arguments`);
      return;
    }
    // Upstream crashes on calls too short to parse.
    if (call.args.length < 2) {
      return;
    }
    const desc = this.parseDescArg(call.args[0]!);
    if (desc === null) {
      return;
    }
    let labels: Family["labels"] = null;
    if (desc.labels.length > 0) {
      labels = [...desc.labels.map((name) => ({ name, value: null })), ...desc.constLabels.map(([name, value]) => ({ name, value }))];
    }
    let type: MetricType | null = null;
    if (method === "MustNewHistogram") {
      type = "HISTOGRAM";
    } else if (method === "MustNewSummary") {
      type = "SUMMARY";
    } else {
      const valueType = call.args[1]!;
      const typeName = valueType.$type === "Ident" ? valueType.name : valueType.$type === "SelectorExpr" ? valueType.sel!.name : null;
      if (typeName !== null) {
        type = typeName === "CounterValue" ? "COUNTER" : typeName === "GaugeValue" ? "GAUGE" : "UNTYPED";
      }
    }
    this.add({ name: desc.name, help: desc.help, type, labels }, call.pos());
  }

  private parseOpts(args: ast.Expr[], type: MetricType): void {
    if (args.length === 0) {
      return;
    }
    const opts = this.parseOptsExpr(args[0]);
    let labels: Family["labels"] = null;
    if (args.length > 1) {
      const labelOpts = this.parseOptsExpr(args[1]);
      if (labelOpts !== null && labelOpts.labels.length > 0) {
        labels = labelOpts.labels.map((name) => ({ name, value: null }));
      }
    }
    if (opts === null) {
      return;
    }
    // Stub metrics without a name are skipped.
    const name = buildFQName(opts.namespace, opts.subsystem, opts.name);
    if (name !== "") {
      this.add({ name, help: opts.help, type, labels }, args[0].pos());
    }
  }

  // parseKSMMetric parses a kube-state-metrics family generator.
  private parseKSMMetric(nameArg: ast.Expr, helpArg: ast.Expr, typeArg: ast.Expr): void {
    const name = this.parseValue("name", nameArg);
    const help = name === null ? null : this.parseValue("help", helpArg);
    if (name === null || help === null) {
      return;
    }
    let type: MetricType | null = null;
    if (typeArg.$type === "SelectorExpr") {
      const t = metricTypes[typeArg.sel!.name];
      if (t === undefined) {
        return;
      }
      type = t;
    }
    this.add({ name, help, type, labels: null }, nameArg.pos());
  }

  private add(family: Family, pos: token.Pos): void {
    const key = JSON.stringify(family);
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.metrics.push({ family, pos });
    }
  }

  private parseOptsExpr(expr: ast.Expr): Opts | null {
    switch (expr.$type) {
      case "CompositeLit":
        return this.parseCompositeOpts(expr);
      case "Ident": {
        const decl = declOf(expr);
        const rhs = decl?.$type === "AssignStmt" ? decl.rhs[0] : null;
        return rhs?.$type === "CompositeLit" ? this.parseCompositeOpts(rhs) : null;
      }
      case "UnaryExpr":
        return this.parseOptsExpr(expr.x!);
      default:
        return null;
    }
  }

  private parseCompositeOpts(lit: ast.CompositeLit): Opts | null {
    const opts: Opts = { namespace: "", subsystem: "", name: "", help: null, labels: [], constLabels: [] };
    for (const elt of lit.elts) {
      if (elt?.$type === "BasicLit") {
        opts.labels.push(trimQuotes(elt.value));
        continue;
      }
      if (elt?.$type !== "KeyValueExpr") {
        continue;
      }
      const key = elt.key;
      if (key?.$type === "BasicLit") {
        // Only literal values are kept; others use a placeholder.
        const value = elt.value?.$type === "BasicLit" ? elt.value.value : "?";
        const existing = opts.constLabels.findIndex(([k]) => k === key.value);
        if (existing >= 0) {
          opts.constLabels[existing][1] = value;
        } else {
          opts.constLabels.push([key.value, value]);
        }
        continue;
      }
      if (key?.$type !== "Ident" || !optsFields.has(key.name)) {
        continue;
      }
      const value = this.parseValue(key.name, elt.value!);
      if (value === null) {
        return null;
      }
      if (key.name === "Namespace") {
        opts.namespace = value;
      } else if (key.name === "Subsystem") {
        opts.subsystem = value;
      } else if (key.name === "Name") {
        opts.name = value;
      } else {
        opts.help = value;
      }
    }
    return opts;
  }

  // parseValue evaluates a string built from literals, constants, +, and
  // prometheus.BuildFQName, or returns null.
  private parseValue(field: string, node: ast.Node): string | null {
    switch (node.$type) {
      case "BasicLit":
        return node.kind === token.STRING ? unquote(node.value) : null;
      case "Ident": {
        const decl = declOf(node);
        // Upstream reads the spec's first value, whichever name this is.
        return decl?.$type === "ValueSpec" ? this.parseValue(field, decl) : null;
      }
      case "ValueSpec":
        return node.values.length === 0 ? null : this.parseValue(field, node.values[0]!);
      case "BinaryExpr": {
        if (node.op !== token.ADD) {
          return null;
        }
        const x = this.parseValue(field, node.x!);
        const y = x === null ? null : this.parseValue(field, node.y!);
        return x === null || y === null ? null : x + y;
      }
      case "CallExpr":
        return this.parseValueCall(field, node);
      default:
        if (this.pass.config.strict) {
          this.issue(node.pos(), `parsing ${field} with type *ast.${node.$type} is not supported`);
        }
        return null;
    }
  }

  private parseValueCall(field: string, call: ast.CallExpr): string | null {
    const fun = call.fun;
    const method = fun?.$type === "SelectorExpr" ? fun.sel!.name : fun?.$type === "Ident" ? fun.name : null;
    if (method === null) {
      return null;
    }
    if (method === "BuildFQName" && call.args.length === 3) {
      const namespace = this.parseValue("namespace", call.args[0]!);
      const subsystem = namespace === null ? null : this.parseValue("subsystem", call.args[1]!);
      const name = subsystem === null ? null : this.parseValue("name", call.args[2]!);
      return namespace === null || subsystem === null || name === null ? null : buildFQName(namespace, subsystem, name);
    }
    if (this.pass.config.strict) {
      this.issue(call.pos(), `parsing ${field} with function ${method} is not supported`);
    }
    return null;
  }

  // parseDescArg parses the *prometheus.Desc argument of a const metric.
  private parseDescArg(expr: ast.Expr): Desc | null {
    if (expr.$type === "CallExpr") {
      return this.parseNewDesc(expr);
    }
    if (expr.$type !== "Ident") {
      if (this.pass.config.strict) {
        this.issue(expr.pos(), `parsing desc of type *ast.${expr.$type} is not supported`);
      }
      return null;
    }
    if (expr.obj === null) {
      return null;
    }
    const decl = declOf(expr);
    const value = decl?.$type === "AssignStmt" ? decl.rhs[0] : decl?.$type === "ValueSpec" ? decl.values[0] : null;
    if (value?.$type === "CallExpr") {
      return this.parseNewDesc(value);
    }
    if (this.pass.config.strict) {
      this.issue(expr.pos(), `parsing desc of type ${decl === null ? "<nil>" : `*ast.${decl.$type}`} is not supported`);
    }
    return null;
  }

  private parseNewDesc(call: ast.CallExpr): Desc | null {
    const fun = call.fun!;
    const strict = this.pass.config.strict;
    if (fun.$type === "Ident" || fun.$type === "SelectorExpr") {
      const name = fun.$type === "Ident" ? fun : fun.sel!;
      if (name.name !== "NewDesc") {
        if (strict) {
          this.issue(name.pos(), `parsing desc with function ${name.name} is not supported`);
        }
        return null;
      }
    } else {
      if (strict) {
        this.issue(fun.pos(), `parsing desc of *ast.${fun.$type} is not supported`);
      }
      return null;
    }
    // k8s.io/component-base/metrics.NewDesc takes 6 arguments, prometheus.NewDesc 4.
    if (call.args.length < 4) {
      if (strict) {
        this.issue(call.pos(), "NewDesc should have at least 4 args");
      }
      return null;
    }
    const name = this.parseValue("fqName", call.args[0]!);
    const help = name === null ? null : this.parseValue("help", call.args[1]!);
    if (name === null || help === null) {
      return null;
    }
    const desc: Desc = { name, help, labels: [], constLabels: [] };
    const labels = call.args[2];
    if (labels?.$type === "CompositeLit") {
      const opts = this.parseCompositeOpts(labels);
      if (opts === null) {
        return null;
      }
      desc.labels = opts.labels;
    }
    const constLabels = call.args[3];
    if (constLabels?.$type === "CompositeLit") {
      const opts = this.parseCompositeOpts(constLabels);
      if (opts === null) {
        return null;
      }
      desc.constLabels = opts.constLabels;
    }
    return desc;
  }

  private issue(pos: token.Pos, text: string): void {
    this.pass.report({ pos, message: `Metric:  Error: ${text}` });
  }
}

interface Desc {
  name: string;
  help: string;
  labels: string[];
  constLabels: [string, string][];
}

// declOf returns the declaration ast.Object resolution found for an
// identifier in its file.
function declOf(ident: ast.Ident): ast.Node | null {
  return (ident.obj?.decl ?? null) as ast.Node | null;
}

function buildFQName(namespace: string, subsystem: string, name: string): string {
  return name === "" ? "" : [namespace, subsystem, name].filter((part) => part !== "").join("_");
}

function trimQuotes(s: string): string {
  return s.replace(/^"+|"+$/g, "");
}

// lint runs promlint's checks on a family, returning each problem's text.
function lint(family: Family): string[] {
  const name = family.name;
  const lower = name.toLowerCase();
  const type = family.type ?? "COUNTER";
  const labels = family.labels ?? [];
  const problems: string[] = [];
  if (family.help === null) {
    problems.push("no help text");
  }
  const unit = metricUnit(name);
  if (unit !== null && unit.unit !== unit.base) {
    problems.push(`use base unit ${JSON.stringify(unit.base)} instead of ${JSON.stringify(unit.unit)}`);
  }
  const isCounter = type === "COUNTER";
  const isUntyped = type === "UNTYPED";
  const isHistogram = type === "HISTOGRAM";
  const isSummary = type === "SUMMARY";
  const hasTotal = name.endsWith("_total");
  if (isCounter && !hasTotal) {
    problems.push(`counter metrics should have "_total" suffix`);
  } else if (!isUntyped && !isCounter && hasTotal) {
    problems.push(`non-counter metrics should not have "_total" suffix`);
  }
  if (!isUntyped) {
    if (!isHistogram && name.endsWith("_bucket")) {
      problems.push(`non-histogram metrics should not have "_bucket" suffix`);
    }
    if (!isHistogram && !isSummary && name.endsWith("_count")) {
      problems.push(`non-histogram and non-summary metrics should not have "_count" suffix`);
    }
    if (!isHistogram && !isSummary && name.endsWith("_sum")) {
      problems.push(`non-histogram and non-summary metrics should not have "_sum" suffix`);
    }
    for (const label of labels) {
      if (!isHistogram && label.name === "le") {
        problems.push(`non-histogram metrics should not have "le" label`);
      }
      if (!isSummary && label.name === "quantile") {
        problems.push(`non-summary metrics should not have "quantile" label`);
      }
    }
  }
  for (const typeName of ["counter", "gauge", "summary", "histogram"]) {
    if (lower.includes(`_${typeName}_`) || lower.endsWith(`_${typeName}`)) {
      problems.push(`metric name should not include type '${typeName}'`);
    }
  }
  if (name.includes(":")) {
    problems.push("metric names should not contain ':'");
  }
  const camelCase = /[a-z][A-Z]/;
  if (camelCase.test(name)) {
    problems.push("metric names should be written in 'snake_case' not 'camelCase'");
  }
  for (const label of labels) {
    if (camelCase.test(label.name)) {
      problems.push("label names should be written in 'snake_case' not 'camelCase'");
    }
  }
  for (const abbreviation of unitAbbreviations) {
    if (lower.includes(`_${abbreviation}_`) || lower.endsWith(`_${abbreviation}`)) {
      problems.push("metric names should not contain abbreviated units");
    }
  }
  return problems;
}

// units maps unit names to their base units.
const units: [string, string][] = [
  ["amperes", "amperes"],
  ["bytes", "bytes"],
  ["celsius", "celsius"],
  ["grams", "grams"],
  ["joules", "joules"],
  ["kelvin", "kelvin"],
  ["meters", "meters"],
  ["metres", "metres"],
  ["seconds", "seconds"],
  ["volts", "volts"],
  ["minutes", "seconds"],
  ["hours", "seconds"],
  ["days", "seconds"],
  ["weeks", "seconds"],
  ["kelvins", "kelvin"],
  ["fahrenheit", "celsius"],
  ["rankine", "celsius"],
  ["inches", "meters"],
  ["yards", "meters"],
  ["miles", "meters"],
  ["bits", "bytes"],
  ["calories", "joules"],
  ["pounds", "grams"],
  ["ounces", "grams"],
];

const unitPrefixes = [
  "pico",
  "nano",
  "micro",
  "milli",
  "centi",
  "deci",
  "deca",
  "hecto",
  "kilo",
  "kibi",
  "mega",
  "mibi",
  "giga",
  "gibi",
  "tera",
  "tebi",
  "peta",
  "pebi",
  "",
];

const unitAbbreviations = ["s", "ms", "us", "ns", "sec", "b", "kb", "mb", "gb", "tb", "pb", "m", "h", "d"];

// metricUnit finds a known unit, possibly prefixed, among a name's words.
// Upstream checks units in map order, so a name with several units may
// report any of them; this checks them in a fixed order.
function metricUnit(name: string): { unit: string; base: string } | null {
  const words = name.split("_");
  for (const [unit, base] of units) {
    for (const prefix of unitPrefixes) {
      if (words.includes(prefix + unit)) {
        return { unit: prefix + unit, base };
      }
    }
  }
  return null;
}
