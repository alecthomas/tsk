// Adapted from github.com/yeya24/promlinter's tests, Apache License 2.0.
package p

import "prometheus"

var helpText = "Requests served."

func label() string { return "" }

func _(ch chan<- prometheus.Metric) {
	_ = prometheus.NewCounter(prometheus.CounterOpts{ // want "^Metric: requests Error: counter metrics should have \"_total\" suffix$"
		Name: "requests",
		Help: helpText,
	})
	_ = prometheus.NewCounter(prometheus.CounterOpts{ // want "^Metric: requests_total Error: no help text$"
		Name: "requests_total",
	})
	_ = prometheus.NewGauge(prometheus.GaugeOpts{ // want "use base unit \"seconds\" instead of \"milliseconds\"" "abbreviated units" "should not include type 'gauge'"
		Namespace: "app",
		Name:      "latency_milliseconds_ms_gauge",
		Help:      "Latency.",
	})
	_ = prometheus.NewCounterVec(prometheus.CounterOpts{ // want "label names should be written in 'snake_case' not 'camelCase'"
		Name: "events_total",
		Help: "Events.",
	}, []string{"userId"})
	_ = prometheus.NewGauge(prometheus.GaugeOpts{Name: "temperature_celsius", Help: "Temperature."})
	_ = prometheus.NewGauge(prometheus.GaugeOpts{Name: label(), Help: "Skipped."})

	desc := prometheus.NewDesc(prometheus.BuildFQName("app", "queue", "depth_total"), "Depth.", nil, nil)
	ch <- prometheus.MustNewConstMetric(desc, prometheus.GaugeValue, 1) // want "^Metric: app_queue_depth_total Error: non-counter metrics should not have \"_total\" suffix$"
}
