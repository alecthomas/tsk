// Adapted from github.com/yeya24/promlinter's tests, Apache License 2.0.
package strict

import "prometheus"

func name() string { return "" }

func _() {
	_ = prometheus.NewGauge(prometheus.GaugeOpts{Name: name(), Help: "x"}) // want "^Metric:  Error: parsing Name with function name is not supported$"
	_ = prometheus.NewGauge(prometheus.GaugeOpts{Name: "up", Help: "x"})
}
