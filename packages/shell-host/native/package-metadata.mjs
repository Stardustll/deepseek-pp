import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHELL_HOST_PACKAGE_NAME = '@tflystar/deepseek-pp-shell-host';

export function readShellHostPackageMetadata(moduleUrl = import.meta.url) {
  const runtimeDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(runtimeDir, 'package.json'),
    resolve(runtimeDir, '..', 'package.json'),
  ];

  for (const packagePath of candidates) {
    if (!existsSync(packagePath)) continue;
    let value;
    try {
      value = JSON.parse(readFileSync(packagePath, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid Shell Host package metadata at ${packagePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid Shell Host package metadata at ${packagePath}: expected an object.`);
    }
    if (value.name !== SHELL_HOST_PACKAGE_NAME) {
      throw new Error(`Invalid Shell Host package metadata at ${packagePath}: unexpected package name.`);
    }
    if (typeof value.version !== 'string' || value.version.trim().length === 0) {
      throw new Error(`Invalid Shell Host package metadata at ${packagePath}: version is missing.`);
    }
    return { name: value.name, version: value.version };
  }

  throw new Error(`Shell Host package metadata was not found beside ${runtimeDir}.`);
}
