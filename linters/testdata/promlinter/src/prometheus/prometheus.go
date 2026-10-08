// Package prometheus stands in for github.com/prometheus/client_golang's.
package prometheus

type Opts struct{ Namespace, Subsystem, Name, Help string }

type (
	CounterOpts Opts
	GaugeOpts   Opts
)

type (
	Metric    interface{}
	Desc      struct{}
	ValueType int
)

const (
	CounterValue ValueType = iota
	GaugeValue
)

func NewCounter(CounterOpts) Metric                         { return nil }
func NewCounterVec(CounterOpts, []string) Metric            { return nil }
func NewGauge(GaugeOpts) Metric                             { return nil }
func NewDesc(string, string, []string, map[string]string) *Desc { return nil }
func BuildFQName(string, string, string) string             { return "" }

func MustNewConstMetric(*Desc, ValueType, float64, ...string) Metric { return nil }
