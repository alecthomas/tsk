package typescript

import (
	"context"
	"maps"
	"slices"
	"strings"
	"testing/fstest"

	"github.com/alecthomas/errors"
	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/bundled"
	"github.com/microsoft/TypeScript/tsc/internal/checker"
	"github.com/microsoft/TypeScript/tsc/internal/collections"
	"github.com/microsoft/TypeScript/tsc/internal/compiler"
	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/diagnosticwriter"
	"github.com/microsoft/TypeScript/tsc/internal/locale"
	"github.com/microsoft/TypeScript/tsc/internal/ls"
	"github.com/microsoft/TypeScript/tsc/internal/tsoptions"
	"github.com/microsoft/TypeScript/tsc/internal/tspath"
	"github.com/microsoft/TypeScript/tsc/internal/vfs/iovfs"
)

// Program is a type-checked set of files. Its checker and every type it returns
// belong to this program and must not be mixed with another's.
type Program struct {
	program *compiler.Program
	checker *checker.Checker
}

// NewProgram type-checks files as one strict ES2020 project with ES2025 iterator helpers and no DOM.
// Names are absolute and slash-separated, and every file is a root. Any diagnostic is an error.
// An import of "<root>/<file>" for each of roots resolves to "/<root>/<file>".
func NewProgram(ctx context.Context, files map[string]string, roots []string) (*Program, error) {
	tree := fstest.MapFS{}
	for name, text := range files {
		if !strings.HasPrefix(name, "/") {
			return nil, errors.Errorf("program file %s is not absolute", name)
		}
		tree[strings.TrimPrefix(name, "/")] = &fstest.MapFile{Data: []byte(text)}
	}
	fileSystem := bundled.WrapFS(iovfs.From(tree, true))
	host := compiler.NewCompilerHost("/", fileSystem, bundled.LibPath(), nil, nil, nil)
	var paths *collections.OrderedMap[string, []string] //nolint:optionalnil // The compiler reads nil as no mappings.
	if len(roots) > 0 {
		paths = collections.NewOrderedMapWithSizeHint[string, []string](len(roots))
	}
	for _, root := range roots {
		paths.Set(root+"/*", []string{"/" + root + "/*"})
	}
	program := compiler.NewProgram(compiler.ProgramOptions{
		Config: tsoptions.NewParsedCommandLine(
			&core.CompilerOptions{
				Paths:                      paths,
				Target:                     core.ScriptTargetES2020,
				Module:                     core.ModuleKindESNext,
				ModuleResolution:           core.ModuleResolutionKindBundler,
				Lib:                        []string{"lib.es2020.d.ts", "lib.es2025.iterator.d.ts"},
				Types:                      []string{},
				Strict:                     core.TSTrue,
				IsolatedModules:            core.TSTrue,
				NoEmit:                     core.TSTrue,
				AllowImportingTsExtensions: core.TSTrue,
				SkipDefaultLibCheck:        core.TSTrue,
			},
			slices.Sorted(maps.Keys(files)),
			nil,
			tspath.ComparePathsOptions{UseCaseSensitiveFileNames: true, CurrentDirectory: "/"},
		),
		// One checker keeps diagnostics and type identities in a single checker.
		SingleThreaded: core.TSTrue,
		Host:           host,
	})
	diagnostics, err := programDiagnostics(ctx, program)
	if err != nil {
		return nil, err
	}
	if len(diagnostics) > 0 {
		var report strings.Builder
		diagnosticwriter.WriteFormatDiagnostics(&report, diagnosticwriter.FromASTDiagnostics(compiler.SortAndDeduplicateDiagnostics(diagnostics)),
			&diagnosticwriter.FormattingOptions{
				Locale:                    locale.Default,
				UseCaseSensitiveFileNames: true,
				CurrentDirectory:          "/",
				NewLine:                   "\n",
			})
		return nil, errors.New(strings.TrimSpace(report.String()))
	}
	checker, _ := program.GetTypeChecker(ctx)
	return &Program{program: program, checker: checker}, nil
}

// programDiagnostics reports cancellation as an error. A cancelled checker panics
// when asked about its next file, so that panic is recovered once ctx is done.
func programDiagnostics(ctx context.Context, program *compiler.Program) (diagnostics []*ast.Diagnostic, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			if ctx.Err() == nil {
				panic(recovered)
			}
			diagnostics, err = nil, errors.WithStack(ctx.Err())
		}
	}()
	diagnostics = compiler.GetDiagnosticsOfAnyProgram(ctx, program, nil, false, program.GetBindDiagnostics, program.GetSemanticDiagnostics)
	return diagnostics, errors.WithStack(ctx.Err())
}

// Calls returns every call in file that the checker resolves to function, as
// declared in declarationFile, including calls through aliases.
func (p *Program) Calls(file, declarationFile, function string) ([]Call, error) {
	source := p.program.GetSourceFile(file)
	if source == nil {
		return nil, errors.Errorf("%s is not in the program", file)
	}
	var calls []Call
	var visit func(node *ast.Node) bool
	visit = func(node *ast.Node) bool {
		if node.Kind == ast.KindCallExpression && p.callsDeclaration(node, declarationFile, function) {
			call := Call{
				Offset:       node.AsCallExpression().Arguments.Loc.Pos(),
				HasArguments: len(node.Arguments()) > 0,
				Location:     location(node),
			}
			for _, argument := range node.TypeArguments() {
				call.TypeArguments = append(call.TypeArguments, p.checker.GetTypeFromTypeNode(argument))
			}
			calls = append(calls, call)
		}
		return node.ForEachChild(visit)
	}
	source.AsNode().ForEachChild(visit)
	return calls, nil
}

func (p *Program) callsDeclaration(call *ast.Node, declarationFile, function string) bool {
	signature := p.checker.GetResolvedSignature(call)
	if signature == nil || signature.Declaration() == nil {
		return false
	}
	declaration := signature.Declaration()
	file := ast.GetSourceFileOfNode(declaration)
	return file != nil && file.FileName() == declarationFile &&
		declaration.Name() != nil && declaration.Name().Text() == function
}

// Describe converts a type to a Shape, or reports why it is not JSON-like.
// Recursive types are rejected because their values could not be defaulted.
func (p *Program) Describe(t *Type) (Shape, error) {
	return p.describe(t, nil)
}

func (p *Program) describe(t *Type, ancestors []*Type) (Shape, error) {
	if slices.Contains(ancestors, t) {
		return nil, errors.Errorf("recursive type %s is not supported", p.checker.TypeToString(t))
	}
	ancestors = append(ancestors, t)
	flags := t.Flags()
	switch {
	case flags&checker.TypeFlagsString != 0:
		return StringShape{}, nil
	case flags&checker.TypeFlagsNumber != 0:
		return NumberShape{}, nil
	case flags&(checker.TypeFlagsBoolean|checker.TypeFlagsBooleanLiteral) != 0:
		return BooleanShape{}, nil
	case flags&checker.TypeFlagsStringLiteral != 0:
		return p.describeUnion([]*Type{t})
	case flags&checker.TypeFlagsUnion != 0:
		// Optional properties add undefined, which Property.Optional records,
		// so string | undefined describes as string.
		members := slices.DeleteFunc(slices.Clone(t.Types()), func(member *Type) bool {
			return member.Flags()&checker.TypeFlagsUndefined != 0
		})
		if len(members) == 1 {
			return p.describe(members[0], ancestors)
		}
		return p.describeUnion(members)
	case flags&checker.TypeFlagsObject != 0:
		return p.describeObject(t, ancestors)
	}
	return nil, errors.Errorf("type %s is not supported", p.checker.TypeToString(t))
}

// describeUnion accepts string literal unions.
func (p *Program) describeUnion(members []*Type) (Shape, error) {
	var values []string
	booleans := 0
	for _, member := range members {
		flags := member.Flags()
		switch {
		case flags&checker.TypeFlagsBooleanLiteral != 0:
			booleans++
		case flags&checker.TypeFlagsStringLiteral != 0:
			value, _ := member.AsLiteralType().Value().(string)
			values = append(values, value)
		default:
			return nil, errors.Errorf("union member %s is not a string literal", p.checker.TypeToString(member))
		}
	}
	switch {
	case booleans > 0 && len(values) == 0:
		return BooleanShape{}, nil
	case booleans > 0 || len(values) == 0:
		return nil, errors.Errorf("union mixes booleans and string literals")
	}
	// The checker orders members by type identity, so sort for stable output.
	slices.Sort(values)
	return EnumShape{Values: values}, nil
}

func (p *Program) describeObject(t *Type, ancestors []*Type) (Shape, error) {
	c := p.checker
	if c.IsArrayType(t) {
		element, err := p.describe(c.GetTypeArguments(t)[0], ancestors)
		if err != nil {
			return nil, err
		}
		return ArrayShape{Element: element}, nil
	}
	if checker.IsTupleType(t) || len(c.GetSignaturesOfType(t, checker.SignatureKindCall)) > 0 ||
		len(c.GetSignaturesOfType(t, checker.SignatureKindConstruct)) > 0 {
		return nil, errors.Errorf("type %s is not supported", c.TypeToString(t))
	}
	properties := c.GetPropertiesOfType(t)
	indexes := c.GetIndexInfosOfType(t)
	if len(indexes) > 0 {
		if len(properties) > 0 || len(indexes) > 1 || indexes[0].KeyType().Flags()&checker.TypeFlagsString == 0 {
			return nil, errors.Errorf("type %s mixes properties and index signatures", c.TypeToString(t))
		}
		element, err := p.describe(indexes[0].ValueType(), ancestors)
		if err != nil {
			return nil, err
		}
		return RecordShape{Element: element}, nil
	}
	object := ObjectShape{}
	for _, symbol := range properties {
		if symbol.Flags&ast.SymbolFlagsProperty == 0 {
			return nil, errors.Errorf("member %s of %s is not a property", symbol.Name, c.TypeToString(t))
		}
		shape, err := p.describe(c.GetTypeOfSymbol(symbol), ancestors)
		if err != nil {
			return nil, errors.Wrapf(err, "property %s", symbol.Name)
		}
		object.Properties = append(object.Properties, Property{
			Name:     symbol.Name,
			Optional: symbol.Flags&ast.SymbolFlagsOptional != 0,
			Shape:    shape,
			Doc:      ls.GetSymbolDocumentationComment(c, symbol),
		})
	}
	return object, nil
}

// TypeString renders a type as TypeScript would print it.
func (p *Program) TypeString(t *Type) string {
	return p.checker.TypeToString(t)
}
