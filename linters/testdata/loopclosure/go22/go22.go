//go:build go1.22

package versions

func InGo22(l []int) {
	for i, v := range l {
		go func() {
			print(i) // Not reported due to file's GoVersion.
			print(v) // Not reported due to file's GoVersion.
		}()
	}
}

