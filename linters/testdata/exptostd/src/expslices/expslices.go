package expslices

// Every use has a replacement, so only the import is reported.
import "golang.org/x/exp/slices" // want `^Import statement 'golang.org/x/exp/slices' may be replaced by 'slices'$`

func use(s []int) {
	_ = slices.Contains(s, 1)
	_ = slices.Index(s, 1)
}
