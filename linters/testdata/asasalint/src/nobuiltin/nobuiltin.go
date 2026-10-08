package nobuiltin

import "fmt"

func variadic(args ...any) {}

func calls() {
	values := []any{1}
	fmt.Println(values) // want `pass \[\]any as any to func fmt\.Println func\(a \.\.\.any\) \(n int, err error\)`
	variadic(values)
}
