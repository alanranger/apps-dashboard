#!/usr/bin/env node
/**
 * Read-only: does schema.alanranger.com serve every file of one schema-repo commit as committed (git blob ids)?
 * The same check live D–G run after their push. Usage: node scripts/check-served-files.mjs --commit b1ba40f8 [--timeout-ms 300000]
 */
import { pathToFileURL } from 'node:url';
import { committedBlobs, servedCheck, servedText } from '../runner/served-check.mjs';

const SCHEMA_REPO = 'G:/Dropbox/alan ranger photography/Website Code/Schema Tools/alanranger-schema';
const { git, normPath } = await import(pathToFileURL('G:/Dropbox/alan ranger photography/Website Code/Schema Tools/scripts/lib/deploy-schemas.mjs').href);
const arg = (f) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null; };
const commit = arg('--commit');
if (!commit) throw new Error('--commit <sha> is required');
const timeoutMs = Number(arg('--timeout-ms') || 300000);
const changed = git(SCHEMA_REPO, ['diff-tree', '--no-commit-id', '--name-status', '-r', commit]).stdout.split(/\r?\n/).filter(Boolean)
  .map((l) => l.split('\t')).filter(([s]) => s[0] !== 'D').map(([, f]) => normPath(f));
const t0 = Date.now();
const r = await servedCheck(committedBlobs(SCHEMA_REPO, commit, changed), { timeoutMs, onProgress: (l, d, t) => process.stderr.write(`${l.replace('{done}', d).replace('{total}', t)}\n`) });
console.log(JSON.stringify({ commit, files: changed.length, result: servedText(r, timeoutMs), differ: r.differ, polls: r.polls, seconds: Math.round((Date.now() - t0) / 1000) }, null, 1));
