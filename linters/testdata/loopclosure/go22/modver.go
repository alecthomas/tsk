package versions

func At22FromTheModuleVersion(l []int) {
	for i, v := range l {
		go func() {
			print(i) // Not reported due to module's GoVersion.
			print(v) // Not reported due to module's GoVersion.
		}()
	}
}
