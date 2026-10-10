// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package useslicessort tests use-slices-sort.
package useslicessort

import "sort"

func useSlicesSort() {
	names := []string{}
	years := []int{}
	temperatures := []float64{}

	sort.Strings(names)                  // want "^use-slices-sort: replace sort.Strings by slices.Sort$"
	sort.Ints(years)                     // want "^use-slices-sort: replace sort.Ints by slices.Sort$"
	sort.Float64s(temperatures)          // want "^use-slices-sort: replace sort.Float64s by slices.Sort$"
	sort.IntsAreSorted(years)            // want "^use-slices-sort: replace sort.IntsAreSorted by slices.IsSorted$"
	sort.StringsAreSorted(names)         // want "^use-slices-sort: replace sort.StringsAreSorted by slices.IsSorted$"
	sort.Float64sAreSorted(temperatures) // want "^use-slices-sort: replace sort.Float64sAreSorted by slices.IsSorted$"

	sortable := sortable{}
	sort.Sort(sortable)                                             // want "^use-slices-sort: replace sort.Sort by slices.SortFunc$"
	sort.Slice(years, func(i, j int) bool { return false })         // want "^use-slices-sort: replace sort.Slice by slices.SortFunc$"
	sort.Stable(sortable)                                           // want "^use-slices-sort: replace sort.Stable by slices.SortStableFunc$"
	sort.SliceStable(years, func(i, j int) bool { return false })   // want "^use-slices-sort: replace sort.SliceStable by slices.SortStableFunc$"
	sort.IsSorted(sortable)                                         // want "^use-slices-sort: replace sort.IsSorted by slices.IsSortedFunc$"
	sort.SliceIsSorted(years, func(i, j int) bool { return false }) // want "^use-slices-sort: replace sort.SliceIsSorted by slices.IsSortedFunc$"
	_ = sort.SearchInts(years, 1)
}

type sortable []int

func (sortable) Len() int           { return 0 }
func (sortable) Less(i, j int) bool { return true }
func (sortable) Swap(i, j int)      {}
