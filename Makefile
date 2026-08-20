TSC ?= tsc

.PHONY: build watch check test clean

build:
	$(TSC) -p .

test: build
	node --test test/

watch:
	$(TSC) -p . --watch

check:
	$(TSC) -p . --noEmit

clean:
	rm -rf dist
