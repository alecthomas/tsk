package clones

import "fmt"

type item struct {
	name  string
	count int
}

func summarizeA(items []item) map[string]int { // want `10-30 lines are duplicate of .*clones\.go:32-52`
	totals := map[string]int{}
	for _, it := range items {
		if it.count <= 0 {
			continue
		}
		if _, ok := totals[it.name]; !ok {
			totals[it.name] = 0
		}
		totals[it.name] += it.count
		if totals[it.name] > 100 {
			fmt.Println("large", it.name)
		}
	}
	for name, total := range totals {
		if total%2 == 0 {
			fmt.Println("even", name)
		}
	}
	return totals
}

func summarizeB(entries []item) map[string]int { // want `32-52 lines are duplicate of .*clones\.go:10-30`
	sums := map[string]int{}
	for _, e := range entries {
		if e.count <= 0 {
			continue
		}
		if _, found := sums[e.name]; !found {
			sums[e.name] = 0
		}
		sums[e.name] += e.count
		if sums[e.name] > 200 {
			fmt.Println("big", e.name)
		}
	}
	for key, sum := range sums {
		if sum%3 == 0 {
			fmt.Println("odd", key)
		}
	}
	return sums
}

// Short duplicates fall under the threshold.
func shortA(a, b int) int { return a + b*2 }

func shortB(x, y int) int { return x + y*3 }
