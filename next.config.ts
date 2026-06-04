import type { NextConfig } from "next";

// App-wide security headers (PR-3). Deliberately MINIMAL on CSP: only
// `frame-ancestors` (clickjacking) — NOT `script-src` — because the app ships
// inline bootstrap scripts (the pre-hydration theme reader in layout.tsx) and
// Next.js emits inline hydration scripts; a strict script-src would break them.
// The credential-entry login modal lives on the client-rendered app shell, so
// these MUST be app-wide, not scoped to /auth routes.
const securityHeaders = [
  // X-Frame-Options DENY (legacy UAs) + CSP frame-ancestors 'none' (modern) —
  // the app never frames itself, so both fully deny framing (clickjacking). The
  // two agree (DENY ⇔ 'none') to avoid a latent policy mismatch.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The app uses none of these powerful features; deny them everywhere.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // HSTS only matters over HTTPS (browsers ignore it on plain HTTP). Skip it in
  // localhost-HTTP dev (SL_INSECURE_COOKIE_OK=1) so a dev can't pin HSTS for
  // localhost.
  ...(process.env.SL_INSECURE_COOKIE_OK === "1"
    ? []
    : [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains",
        },
      ]),
];

const nextConfig: NextConfig = {
  // Containerized self-host (deploy-vps): emit a standalone server bundle
  // (.next/standalone/server.js) so the Docker image runs `node server.js`
  // under Litestream supervision instead of `next start`.
  output: "standalone",
  // better-sqlite3 is a NATIVE addon — Next/Turbopack must NOT bundle it into
  // the server output or the prebuilt .node fails to load at runtime
  // (ERR_DLOPEN / NODE_MODULE_VERSION). Keep it external so the standalone
  // trace copies the real module + its compiled .node.
  // nodemailer (SMTP email provider) uses dynamic requires that the bundler
  // mishandles; keep it external so the standalone trace copies the real module.
  serverExternalPackages: ["better-sqlite3", "nodemailer"],
  // The Drizzle migrations dir is read at boot by ensureMigrationsApplied()
  // (src/lib/db) via path.resolve(process.cwd(), 'drizzle'); it is NOT a route
  // asset, so standalone tracing won't include it on its own. Trace it in for
  // all routes — and the Dockerfile ALSO COPYs drizzle/ explicitly, since the
  // FATAL boot gate refuses to start if the folder is missing.
  outputFileTracingIncludes: {
    "/*": ["./drizzle/**"],
  },
  // Hide the Next.js on-screen dev indicator (bottom-left floating menu).
  // Build/runtime errors are still surfaced. See node_modules/next/dist/
  // docs/.../devIndicators.md — `false` is the v16 way (the old
  // appIsrStatus/buildActivity options were removed in v16).
  devIndicators: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
