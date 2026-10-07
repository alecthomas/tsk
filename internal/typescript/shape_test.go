package typescript_test

import (
	"context"
	"testing"

	"github.com/alecthomas/assert/v2"

	ts "github.com/microsoft/TypeScript/tsc/shim/typescript"
)

const declaration = `declare module "lib" {
  type ConfigProperty<C> = {} extends C ? { config?: NoInfer<C> } : { config: NoInfer<C> };
  interface NoConfig { readonly [key: string]: never }
  export function define<C extends object = NoConfig>(definition: { name: string } & ConfigProperty<C>): void;
}
`

func TestConfigPropertyTyping(t *testing.T) {
	tests := []struct {
		Name   string
		Script string
		Error  string
	}{
		{Name: "NoConfig", Script: `define({ name: "a" });`},
		{Name: "RequiredDefaults", Script: `define<{ a: string }>({ name: "a", config: { a: "" } });`},
		{Name: "OptionalOnly", Script: `define<{ a?: string }>({ name: "a" });`},
		{Name: "MissingDefaults", Script: `define<{ a: string }>({ name: "a" });`, Error: "Property 'config' is missing"},
		{Name: "InferenceBlocked", Script: `define({ name: "a", config: { a: "" } });`, Error: "is not assignable to type 'never'"},
	}
	for _, test := range tests {
		t.Run(test.Name, func(t *testing.T) {
			_, err := ts.NewProgram(context.Background(), map[string]string{
				"/lib.d.ts": declaration,
				"/script.ts": `import { define } from "lib";
` + test.Script,
			})
			if test.Error == "" {
				assert.NoError(t, err)
				return
			}
			assert.Error(t, err)
			assert.Contains(t, err.Error(), test.Error)
		})
	}
}

func TestDescribe(t *testing.T) {
	program, err := ts.NewProgram(context.Background(), map[string]string{
		"/lib.d.ts": declaration,
		"/script.ts": `import { define } from "lib";
interface Rule {
  /** The function or method writing. */
  writer: string;
  target: string;
}
interface Config {
  /**
   * Rules allowing reads.
   * One per line.
   */
  allowReads: Rule[];
  // Plain comments are not documentation.
  mode?: "strict" | "loose";
  generated: boolean;
  limit: number;
  labels: Record<string, string>;
}
define<Config>({ name: "a", config: { allowReads: [], generated: false, limit: 1, labels: {} } });
define<{ f: () => void }>({ name: "b", config: { f() {} } });
`,
	})
	assert.NoError(t, err)
	calls, err := program.Calls("/script.ts", "/lib.d.ts", "define")
	assert.NoError(t, err)
	assert.Equal(t, 2, len(calls))
	assert.Equal(t, "script.ts:19:1", calls[0].Location)
	shape, err := program.Describe(calls[0].TypeArguments[0])
	assert.NoError(t, err)
	assert.Equal(t, ts.Shape(ts.ObjectShape{Properties: []ts.Property{
		{Name: "allowReads", Doc: "Rules allowing reads.\nOne per line.", Shape: ts.ArrayShape{Element: ts.ObjectShape{Properties: []ts.Property{
			{Name: "writer", Doc: "The function or method writing.", Shape: ts.StringShape{}},
			{Name: "target", Shape: ts.StringShape{}},
		}}}},
		{Name: "mode", Optional: true, Shape: ts.EnumShape{Values: []string{"loose", "strict"}}},
		{Name: "generated", Shape: ts.BooleanShape{}},
		{Name: "limit", Shape: ts.NumberShape{}},
		{Name: "labels", Shape: ts.RecordShape{Element: ts.StringShape{}}},
	}}), shape)
	_, err = program.Describe(calls[1].TypeArguments[0])
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "property f: ")
	assert.Contains(t, err.Error(), "type () => void is not supported")
}
