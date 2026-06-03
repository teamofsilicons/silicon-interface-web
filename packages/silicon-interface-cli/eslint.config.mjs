const globals = Object.fromEntries(
  [
    "Blob",
    "FormData",
    "URLSearchParams",
    "WebSocket",
    "clearInterval",
    "console",
    "fetch",
    "process",
    "setInterval",
    "setTimeout",
  ].map((name) => [name, "readonly"]),
);

const config = [
  {
    ignores: ["node_modules/**"],
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      globals,
      sourceType: "module",
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];

export default config;
