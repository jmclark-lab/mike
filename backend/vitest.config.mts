import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Generous timeouts so cold-start module transform/import latency
    // can't cause spurious timeout failures on a cold CI runner. Warm
    // tests finish in ~1s; this only guards the pathological cold case —
    // it does not mask hangs.
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // The whole server, not just src/lib/** + src/modules/**. The
      // previous scope still left workers/, middleware/, jobs/ and
      // app.ts out of the report entirely, so the ratchet could not see
      // a regression there — and the headline percentage described a
      // part of the codebase rather than the codebase.
      include: ["src/**"],
      // Test files and their fixtures are the measuring instrument, not
      // the thing measured. (Spelled out rather than left to vitest's
      // defaults because setting `exclude` at all replaces them.)
      exclude: ["src/**/__tests__/**", "src/**/*.test.ts", "**/*.d.ts"],
      // No-regression RATCHET floor, not a target. The measured scope
      // spans well-tested libs (access, storage keys/dispositions,
      // downloadTokens, api-key provider/env checks, chat doc
      // resolution, llm model resolution, chat citations, userLookup,
      // documentVersions, userDataCleanup, docxTrackedChanges,
      // documentTypes, chat prompts, workflow catalog ingestion), the
      // route/service layer the integration and service suites drive,
      // and the large still-untested feature libs (courtlistener, mcp,
      // chat tool dispatch, llm providers, spreadsheet handling) — so
      // the global number stays modest.
      //
      // Measured on this tree after the Library download gate: 68.4%
      // statements, 59.21% branches, 71.88% functions, 70.95% lines.
      // The floors below sit just under that, so CI fails on a real
      // *drop* rather than on measurement noise. Floors only go up: when
      // you add tests, raise them in the same PR. Backlog + per-area
      // status: docs/testing-coverage.md.
      thresholds: {
        statements: 68,
        branches: 58,
        functions: 71,
        lines: 70,
      },
    },
  },
});
