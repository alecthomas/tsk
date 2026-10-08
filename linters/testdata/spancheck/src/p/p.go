// Adapted from github.com/jjti/go-spancheck's tests, MIT License.
package p

import (
	"context"
	"errors"

	"trace"
)

func _(ctx context.Context, tracer trace.Tracer) {
	_, span := tracer.Start(ctx, "ok")
	defer span.End()
}

func _(ctx context.Context, tracer trace.Tracer) error {
	_, span := tracer.Start(ctx, "leak") // want "^span.End is not called on all paths, possible memory leak$" "span.SetStatus is not called on all paths" "span.RecordError is not called on all paths"
	if ctx.Err() != nil {
		return errors.New("x") // want "^return can be reached without calling span.End$" "return can be reached without calling span.SetStatus" "return can be reached without calling span.RecordError"
	}
	span.End()
	return nil
}

func _(ctx context.Context, tracer trace.Tracer) error {
	_, span := tracer.Start(ctx, "handled")
	defer span.End()
	if err := ctx.Err(); err != nil {
		span.SetStatus(1, err.Error())
		span.RecordError(err)
		return err
	}
	return nil
}

func _(ctx context.Context, tracer trace.Tracer) {
	_, _ = tracer.Start(ctx, "discarded") // want "^span is unassigned, probable memory leak$"
}
