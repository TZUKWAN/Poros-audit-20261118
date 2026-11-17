# Private security fork

Original: picomatch 4.0.7, npm registry integrity recorded in the baseline lockfile; https://github.com/micromatch/picomatch. Original MIT license and attribution retained in LICENSE. This fork is private, named @poros/picomatch-secure, version 4.0.7+poros.security.1; it is not an upstream security release. Build metadata preserves compatibility with dependent packages' existing ^4 peer requirement.

GHSA-fc5q-39xc-vjpf has no patched published version as checked 2026-11-18. Poros does not need repeated extglob syntax, so both parser entry points reject `+(...)` and `*(...)` before compiling a regular expression. No advisory is suppressed. The dependency override uses this complete, reviewed local source fork. Ordinary globs, braces and file matching remain supported and exercised by the actual build/lint/test suites. tests/api/dependency-policy.test.ts verifies both rejection and required matching behavior.

This deliberately narrows the matcher contract. Reintroducing repeated extglobs requires a separately reviewed upstream fix and regression evidence.
