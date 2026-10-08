package expmaps

import (
	"golang.org/x/exp/maps" // want `^Import statement 'golang.org/x/exp/maps' may be replaced by 'maps'$`
)

func use(m map[string]int) {
	_ = maps.Keys(m)     // want `^golang.org/x/exp/maps.Keys\(\) can be replaced by slices.AppendSeq\(make\(\[\]T, 0, len\(data\)\), maps.Keys\(data\)\)$`
	_ = maps.Equal(m, m) // want `^golang.org/x/exp/maps.Equal\(\) can be replaced by maps.Equal\(\)$`
	maps.Clear(m)        // want `^golang.org/x/exp/maps.Clear\(\) can be replaced by clear\(\)$`
}
