import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import moment from 'moment-timezone';

if (!process.argv[2]) throw new Error('Usage: node scripts/extract-timezones.mjs <vzic-output>');
const directory = resolve(process.argv[2]);
const output = fileURLToPath(new URL('../src/data/timezones.json', import.meta.url));
const manifest = fileURLToPath(new URL('../src/data/timezones-manifest.json', import.meta.url));
if (moment.tz.version !== '0.6.5' || moment.tz.dataVersion !== '2026e') throw new Error('Pinned Moment data mismatch');
const assets = {}, aliases = {};
for (const file of readdirSync(directory, { recursive: true }).filter(file => file.endsWith('.ics')).sort()) {
  const real = realpathSync(resolve(directory, file));
  const zone = relative(directory, real).slice(0, -4);
  const calendar = readFileSync(real, 'utf8');
  // vzic inserts wall-clock build time here. This optional property carries no
  // rule semantics; omit it so the same pinned sources regenerate identical data.
  const component = calendar.match(/BEGIN:VTIMEZONE[\s\S]*END:VTIMEZONE/)[0]
    .replace(/^LAST-MODIFIED:[^\r\n]*\r\n/gm, '');
  if (!component.includes(`TZID:${zone}\r\n`)) throw new Error('TZID mismatch: ' + zone);
  assets[zone] = component + '\r\n';
  aliases[file.slice(0, -4)] = zone;
}
const result = { iana: '2026e', ianaCommit: '039ef27cc5f062a2055cb67435d6d71adbefd27d',
  generatorCommit: '0dec1575bc81de232b8bea18f5d9c22fbc0daa12', momentTimezone: moment.tz.version,
  generatorOptions: ['--pure', '--no-rrules', '--no-rdates'],
  momentDataVersion: moment.tz.dataVersion, assets, aliases };
writeFileSync(output, JSON.stringify(result));
const text = JSON.stringify(result);
writeFileSync(manifest, JSON.stringify({
  iana: result.iana, momentDataVersion: result.momentDataVersion,
  ianaCommit: result.ianaCommit, generatorCommit: result.generatorCommit,
  generatorOptions: result.generatorOptions,
  canonicalZones: Object.keys(assets).length, names: Object.keys(aliases).length,
  bytes: Buffer.byteLength(text), gzipBytes: gzipSync(text).length,
  sha256: createHash('sha256').update(text).digest('hex'),
}, null, 2) + '\n');
