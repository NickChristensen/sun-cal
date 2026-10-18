import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const projectIds = {
  'sun-cal': '4512279041212416',
  'anylist-worker': '4512279057268736',
  'copilot-graphql-proxy': '4512279059562496',
  link: '4512279061331968',
};
const { name: service } = JSON.parse(await readFile('package.json', 'utf8'));
if (!Object.hasOwn(projectIds, service)) throw new Error('Unsupported service.');
const sha = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected a full Git commit SHA.');
const release = service === 'sun-cal' ? sha : `${service}@${sha}`;
const anylist = service === 'anylist-worker';
const artifacts = anylist ? 'dist' : '.cloudflare/output/v0/workers/default/bundle';
const roots = anylist ? ['dist'] : ['.cloudflare/output/v0', ...(existsSync('public') ? ['public'] : [])];
const manifestPath = '.sentry-build/artifact-manifest.json';
const runtimePath = '.sentry-build/runtime-secrets.json';
const env = { ...process.env, GITHUB_SHA: sha, SENTRY_RELEASE: sha, SENTRY_LOCAL_SOURCEMAPS: '1',
  CF_SEND_TELEMETRY: 'false', DO_NOT_TRACK: '1', WRANGLER_SEND_METRICS: 'false' };
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit', env });
const digest = async filename => createHash('sha256').update(await readFile(filename)).digest('hex');

function project() {
  if (process.env.SENTRY_PROJECT !== service) throw new Error('SENTRY_PROJECT does not match this service.');
}

function validateDsn(dsn) {
  let parsed;
  try { parsed = new URL(dsn); } catch { throw new Error('SENTRY_DSN must be a valid approved ingestion DSN.'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'o4511486651924480.ingest.us.sentry.io' ||
      parsed.pathname !== `/${projectIds[service]}` || !/^[a-f0-9]{32}$/.test(parsed.username) ||
      parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw new Error('SENTRY_DSN does not match the approved organization and service project.');
  }
}

async function hashes() {
  const files = {};
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) files[filename] = await digest(filename);
      else throw new Error('Build output must not contain symlinks or special files.');
    }
  }
  for (const root of roots) await walk(root);
  if (anylist) files['.sentry-build/wrangler.prebuilt.json'] = await digest('.sentry-build/wrangler.prebuilt.json');
  if (existsSync(runtimePath)) files[runtimePath] = await digest(runtimePath);
  return files;
}

async function verify() {
  const saved = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (saved.service !== service || saved.release !== release || saved.sha !== sha ||
      JSON.stringify(saved.files) !== JSON.stringify(await hashes())) {
    throw new Error('Build output, runtime configuration, or release identity changed. Refusing upload/deploy.');
  }
  console.log(`Verified immutable build for ${service} at ${sha}.`);
}

switch (process.argv[2]) {
  case 'configure': {
    project();
    validateDsn(process.env.SENTRY_DSN);
    await mkdir('.sentry-build', { recursive: true });
    await writeFile(runtimePath, JSON.stringify({ SENTRY_DSN: process.env.SENTRY_DSN }) + '\n', { mode: 0o600 });
    console.log(`Validated SENTRY_DSN binding for ${service}, Sentry project ${projectIds[service]}.`);
    break;
  }
  case 'prepare': {
    if (anylist) {
      run('npm', ['run', 'build']);
      const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
      delete config.build;
      delete config.$schema;
      config.main = '../dist/index.js';
      await mkdir('.sentry-build', { recursive: true });
      await writeFile('.sentry-build/wrangler.prebuilt.json', JSON.stringify(config, null, 2) + '\n');
      run('./node_modules/.bin/wrangler', ['deploy', '--config', '.sentry-build/wrangler.prebuilt.json', '--dry-run']);
    } else run('npm', ['run', 'deploy:dry-run']);
    const bundle = await readFile(join(artifacts, 'index.js'));
    const map = JSON.parse(await readFile(join(artifacts, 'index.js.map'), 'utf8'));
    if (bundle.length === 0 || map.version !== 3 || !map.mappings || !map.sources?.length ||
        map.sources.length !== map.sourcesContent?.length) throw new Error('Missing complete source-map artifacts.');
    await mkdir('.sentry-build', { recursive: true });
    await writeFile(manifestPath, JSON.stringify({ service, sha, release, files: await hashes() }, null, 2) + '\n');
    await verify();
    break;
  }
  case 'verify': await verify(); break;
  case 'upload': {
    await verify();
    project();
    if (process.env.SENTRY_ORG !== 'nick-3u' || !process.env.SENTRY_AUTH_TOKEN) {
      throw new Error('Approved SENTRY_ORG and SENTRY_AUTH_TOKEN are required.');
    }
    if (!existsSync(runtimePath)) throw new Error('Validated runtime configuration is required before upload.');
    validateDsn(JSON.parse(await readFile(runtimePath, 'utf8')).SENTRY_DSN);
    const scope = ['--org', 'nick-3u', '--project', service];
    run('./node_modules/.bin/sentry-cli', ['releases', ...scope, 'new', release]);
    run('./node_modules/.bin/sentry-cli', ['sourcemaps', ...scope, 'upload', '--release', release,
      '--url-prefix', 'app:///', '--validate', '--strict', '--wait', '--no-rewrite', artifacts]);
    await verify();
    break;
  }
  default: throw new Error('Usage: node scripts/sentry-release.mjs configure|prepare|verify|upload');
}
