export default {
  testRunner: "command",
  commandRunner: {
    command: "npm test",
  },
  mutate: ["src/**/*.ts", "extensions/**/*.ts"],
  coverageAnalysis: "off",
  timeoutMS: 10000,
  timeoutFactor: 2,
  concurrency: 12,
  reporters: ["clear-text", "progress"],
  thresholds: {
    high: 100,
    low: 85,
    break: 85,
  },
};
