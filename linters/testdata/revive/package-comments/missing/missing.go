// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test of missing package comment.

package foo // want "^package-comments: should have a package comment$"
