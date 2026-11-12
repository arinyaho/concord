import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'Usage: node scripts/release-version.mjs <semver-version>';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function skipWhitespace(text, index) {
  while (/\s/.test(text[index])) index += 1;
  return index;
}

function parseString(text, index) {
  if (text[index] !== '"') throw new Error('Expected JSON string');

  let end = index + 1;
  while (end < text.length) {
    if (text[end] === '\\') {
      end += 2;
    } else if (text[end] === '"') {
      end += 1;
      return { end, value: JSON.parse(text.slice(index, end)) };
    } else {
      end += 1;
    }
  }

  throw new Error('Unterminated JSON string');
}

function skipValue(text, index) {
  let depth = 0;
  let cursor = index;

  while (cursor < text.length) {
    if (text[cursor] === '"') {
      cursor = parseString(text, cursor).end;
    } else if (text[cursor] === '{' || text[cursor] === '[') {
      depth += 1;
      cursor += 1;
    } else if (text[cursor] === '}' || text[cursor] === ']') {
      if (depth === 0) return cursor;
      depth -= 1;
      cursor += 1;
    } else if (text[cursor] === ',' && depth === 0) {
      return cursor;
    } else {
      cursor += 1;
    }
  }

  return cursor;
}

function replaceVersion(manifestText, expectedVersion, releaseVersion) {
  let cursor = skipWhitespace(manifestText, 0);
  if (manifestText[cursor] !== '{') throw new Error('Plugin manifest must be a JSON object');
  cursor += 1;

  let versionToken;
  while (true) {
    cursor = skipWhitespace(manifestText, cursor);
    if (manifestText[cursor] === '}') break;

    const key = parseString(manifestText, cursor);
    cursor = skipWhitespace(manifestText, key.end);
    if (manifestText[cursor] !== ':') throw new Error('Expected JSON property separator');
    cursor = skipWhitespace(manifestText, cursor + 1);

    if (key.value === 'version') {
      const value = parseString(manifestText, cursor);
      versionToken = { start: cursor, end: value.end, value: value.value };
    }

    cursor = skipWhitespace(manifestText, skipValue(manifestText, cursor));
    if (manifestText[cursor] === ',') {
      cursor += 1;
    } else if (manifestText[cursor] === '}') {
      break;
    } else {
      throw new Error('Expected JSON property separator');
    }
  }

  if (!versionToken || versionToken.value !== expectedVersion) {
    throw new Error('Plugin manifest version must be a string');
  }

  return `${manifestText.slice(0, versionToken.start)}${JSON.stringify(releaseVersion)}${manifestText.slice(versionToken.end)}`;
}

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
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  return [manifestPath, replaceVersion(manifestText, manifest.version, releaseVersion)];
});

const versionFile = path.join(root, 'VERSION');
for (const target of [versionFile, ...manifests]) {
  fs.accessSync(target, fs.constants.W_OK);
}

fs.writeFileSync(versionFile, `${releaseVersion}\n`);

for (const [manifestPath, contents] of updatedManifests) {
  fs.writeFileSync(manifestPath, contents);
}
