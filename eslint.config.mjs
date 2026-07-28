export default [
  {
    files: ["web/*.js", "scripts/*.mjs", "tests/*.test.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        document: "readonly",
        window: "readonly",
        fetch: "readonly",
        structuredClone: "readonly",
        console: "readonly",
        Intl: "readonly",
        URL: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        ResizeObserver: "readonly",
        matchMedia: "readonly",
        performance: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly"
      }
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", {"argsIgnorePattern": "^_"}],
      "no-unreachable": "error",
      "no-constant-condition": "error"
    }
  }
];
