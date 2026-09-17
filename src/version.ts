import { createRequire } from "node:module";

/** The package version, read from package.json so reports and bug reports carry it. */
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
