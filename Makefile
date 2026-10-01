# crest - Development Experiment 058
#
# No dependencies to install: everything here is Node 22 and its standard library.
# `make` on its own runs the demo, which needs no input file.

NODE ?= node

.PHONY: all run test demo app build synth explain clean check

all: run

## run: plan a synthetic collection (no input needed)
run:
	$(NODE) src/cli.mjs demo --exam-in 14 --budget 60

## test: run the full suite
test:
	$(NODE) --test test/

## check: tests plus a demo run, i.e. what CI should do
check: test run

## app: serve the browser app on http://localhost:8173
app:
	$(NODE) tools/serve.mjs

## build: produce dist/crest.html, the whole app in one offline file
build:
	$(NODE) tools/build-app.mjs

## synth: write a synthetic collection to cards.csv
synth:
	$(NODE) src/cli.mjs synth --count 400 --out cards.csv

## explain: show what each possible review day is worth for one card
explain: cards.csv
	$(NODE) src/cli.mjs explain --cards cards.csv --card c00001 --exam-in 14

cards.csv:
	$(NODE) src/cli.mjs synth --count 400 --out cards.csv

clean:
	$(NODE) -e "import('node:fs').then(fs => { for (const p of ['dist', 'cards.csv']) fs.rmSync(p, { recursive: true, force: true }); })"
