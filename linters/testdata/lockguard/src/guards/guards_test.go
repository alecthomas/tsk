package guards

// rename writes after construction, but in a test, so "Cache.name" stays
// immutable.
func rename(c *Cache) {
	c.name = "test"
}
