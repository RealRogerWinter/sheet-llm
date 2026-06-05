import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local Claude Code worktrees / scratch checkouts — not part of
    // the canonical source tree.
    ".claude/**",
  ]),
  // PR-8 (red-team should-fix): forbid a hard-coded Opus model id in the
  // orchestrator handlers and the chat route. Opus routing MUST go through the
  // resolveModelClass seam (providers/modelClass.ts) + selectProvider, so the
  // Opus credit hold sized in billing/valueTier.ts can never be bypassed by a
  // call that hard-codes the expensive model. Opus ids legitimately live only in
  // providers/registry.ts (the tier map) and billing/{pricing,valueTier}.ts (the
  // billing bounds), which are outside this scope. Haiku/Sonnet recording-site
  // literals are harmless (they can't under-provision a hold) and not matched.
  {
    files: ["src/lib/orchestrator/**/*.ts", "src/app/api/chat/route.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // String literal: 'claude-opus-4-7'
          selector: "Literal[value=/claude-opus/]",
          message:
            "Do not hard-code an Opus model id here — route model selection through resolveModelClass (providers/modelClass.ts) + selectProvider so the Opus credit hold (billing/valueTier.ts) can't be bypassed.",
        },
        {
          // Template literal: `claude-opus-4-7` / `...claude-opus...`
          selector: "TemplateElement[value.raw=/claude-opus/]",
          message:
            "Do not hard-code an Opus model id here — route model selection through resolveModelClass (providers/modelClass.ts) + selectProvider so the Opus credit hold (billing/valueTier.ts) can't be bypassed.",
        },
      ],
    },
  },
]);

export default eslintConfig;
