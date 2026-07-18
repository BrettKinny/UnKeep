#!/usr/bin/env node
import { runCli } from './cli.js';

const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.exitCode = await runCli(process.argv.slice(2), { signal: abort.signal });
