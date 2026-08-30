// Vitest injects the DB_*/AWS_* environment in vitest.config.mts, before any
// module reads process.env at import time. Nothing else is needed here yet,
// but the file is referenced by setupFiles so it stays as the single place to
// add global test wiring.
export {};
