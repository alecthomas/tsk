// Package trace stands in for go.opentelemetry.io/otel/trace.
package trace

import "context"

type Span interface {
	End()
	SetStatus(code int, msg string)
	RecordError(err error)
}

type Tracer interface {
	Start(ctx context.Context, name string) (context.Context, Span)
}
