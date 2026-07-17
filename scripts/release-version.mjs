import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'Usage: node scripts/release-version.mjs <semver-version>';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const [releaseVersion] = process.argv.slice(2);
if (process.argv.length !== 3 || !SEMVER.test(releaseVersion)) {
  throw new Error(USAGE);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.CONCORD_VERSION_ROOT || path.resolve(scriptDirectory, '..');
const manifests = [
  path.join(root, 'plugins/concord/.claude-plugin/plugin.json'),
  path.join(root, 'plugins/concord-codex/.codex-plugin/plugin.json'),
];

const updatedManifests = manifests.map((manifestPath) => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = releaseVersion;
  return [manifestPath, `${JSON.stringify(manifest, null, 2)}\n`];
});

fs.writeFileSync(path.join(root, 'VERSION'), `${releaseVersion}\n`);

for (const [manifestPath, contents] of updatedManifests) {
  fs.writeFileSync(manifestPath, contents);
}
