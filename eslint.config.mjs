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
  // SHE-8 — OSS↔SaaS build-graph boundary (fast editor-time mirror of the
  // authoritative .dependency-cruiser.cjs check). The platform-portable core
  // (music/abc/providers) and the headless orchestrator must not import the
  // SaaS surface (billing/auth). Usage/cost → @/lib/metering; request helpers →
  // @/lib/http (both allowed by simply not being in the forbidden group).
  {
    files: [
      "src/lib/music/**/*.{ts,tsx}",
      "src/lib/abc/**/*.{ts,tsx}",
      "src/lib/providers/**/*.{ts,tsx}",
      "src/lib/orchestrator/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/billing", "@/lib/billing/*", "@/lib/auth", "@/lib/auth/*"],
              message:
                "Core/render/orchestrator code must not import billing or auth (SaaS surface). Use @/lib/metering for usage/cost and @/lib/http for request helpers. See SHE-8 boundary (.dependency-cruiser.cjs).",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
