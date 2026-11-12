// @ts-nocheck
export default {
  testRunner: "command",
  commandRunner: {
    command: "npm test",
  },
  mutate: ["src/**/*.ts", "extensions/**/*.ts"],
  coverageAnalysis: "off",
  timeoutMS: 5000,
  timeoutFactor: 1.5,
  concurrency: 6,
  incremental: true,
  incrementalFile: ".stryker-incremental.json",
  inPlace: true,
  reporters: ["clear-text", "progress"],
  thresholds: {
    high: 100,
    low: 85,
    break: 85,
  },
};
