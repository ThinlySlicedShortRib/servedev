import { expect, test } from "bun:test"

import { entryBounds } from "../ui/src/lib/log-entries"

const log = [
  "[2026-09-29 05:24:13.989] INFO: capcon express listening", // 0
  "    port: 3002", // 1
  "    express_role: \"all\"", // 2
  "[2026-09-29 05:24:14.100] INFO: next entry", // 3
  "", // 4
  "Error: Cannot find module 'x'", // 5
  "    at Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)", // 6
  "    at require (node:internal/modules/helpers:177:18)", // 7
  "@keel/web:dev:  GET /clients 307 in 41ms", // 8
  "@keel/connectors:dev: worker iteration failed: {", // 9
  "@keel/connectors:dev:   code: 'ECONNREFUSED'", // 10
  "@keel/connectors:dev: }", // 11
]

test("entries group structured fields, stack traces and turbo-prefixed blocks", () => {
  expect(entryBounds(log, 0)).toEqual([0, 2])
  expect(entryBounds(log, 2)).toEqual([0, 2]) // hovering a field selects its whole entry
  expect(entryBounds(log, 3)).toEqual([3, 3])
  expect(entryBounds(log, 4)).toEqual([4, 4]) // blank line: just itself
  expect(entryBounds(log, 7)).toEqual([5, 7])
  expect(entryBounds(log, 8)).toEqual([8, 8]) // turbo prefix alone doesn't make a continuation
  expect(entryBounds(log, 10)).toEqual([9, 11])
})
