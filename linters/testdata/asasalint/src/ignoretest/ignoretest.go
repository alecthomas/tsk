package ignoretest

func variadic(args ...any) {}

func calls() {
	variadic([]any{1}) // want `pass \[\]any as any`
}
