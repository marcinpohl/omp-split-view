import js from "@eslint/js";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

/**
 * pylint equivalent: ESLint + typescript-eslint + sonarjs static analysis.
 * radon equivalent: the complexity/cognitive-complexity/raw-size rules below,
 * plus `bun run complexity` (ts-complex) for a per-function report.
 */
export default tseslint.config(
	{ ignores: ["node_modules/**"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	sonarjs.configs.recommended,
	{
		files: ["**/*.ts"],
		rules: {
			// radon cc / raw metrics analog
			complexity: ["warn", 12],
			"max-depth": ["warn", 4],
			"max-params": ["warn", 4],
			"max-lines-per-function": ["warn", { max: 100, skipBlankLines: true, skipComments: true }],
			"sonarjs/cognitive-complexity": ["warn", 15],
			// pylint W/E analog
			eqeqeq: "error",
			"no-console": "warn",
			"prefer-const": "error",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
		},
	},
	{
		// The sanitizer matches control characters on purpose.
		files: ["helpers.ts"],
		rules: { "no-control-regex": "off", "sonarjs/no-control-regex": "off" },
	},
	{
		// Tests exercise failure paths, hostile text and temp dirs on purpose;
		// complexity limits are a source-code signal, not a test signal.
		files: ["test/**/*.ts"],
		rules: {
			"no-console": "off",
			"no-control-regex": "off",
			"sonarjs/no-control-regex": "off",
			"sonarjs/no-duplicate-string": "off",
			"sonarjs/prefer-specific-assertions": "off",
			"sonarjs/publicly-writable-directories": "off",
			"sonarjs/cognitive-complexity": "off",
			complexity: "off",
			"max-lines-per-function": "off",
		},
	},
);
