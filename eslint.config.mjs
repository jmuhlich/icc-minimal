import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig({
  files: ["*.ts"],
  extends: [js.configs.recommended, tseslint.configs.recommended],
  rules: {
    semi: "error",
    "prefer-const": "error",
  },
});
