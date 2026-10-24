/**
 * Development entry point, used by `npm run dev` and the browser tests.
 *
 * main.ts on its own runs as production unless NODE_ENV says otherwise (see
 * env.ts), so this sets NODE_ENV=development before anything reads the
 * environment, then starts the same server. Done in code rather than in the
 * npm script so it works the same on every OS.
 */
process.env.NODE_ENV ??= "development";
await import("./main.js");
