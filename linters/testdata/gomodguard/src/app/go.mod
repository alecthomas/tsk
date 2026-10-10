module example.com/app

go 1.25

require (
	example.com/local v1.0.0
	github.com/allowed/mod v1.0.0
	github.com/blocked/mod v1.2.3
	github.com/old/mod v0.9.0
)

replace example.com/local => ../example.com/local
