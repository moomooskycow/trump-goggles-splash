#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const REQUIRED_FILES = [
  'index.html',
  'styles/main.css',
  'scripts/main.js',
  'scripts/sentry.js',
  'api/health.js',
  'api/sentry-config.js',
  'api/canary/api/v1/errors.js',
  'server.js',
  'src/worker.mjs',
  'Dockerfile',
  'tools/verify-retirement.js',
  'tools/verify-browser.js',
  'tools/verify-server.js',
  'tools/verify-worker.mjs',
  'favicon.ico',
];

const RETIRED_CANARY_FILES = [
  'scripts/canary.js',
  'tools/smoke-canary-production.js',
  'tools/verify-canary.js',
];

const FORBIDDEN_DEPENDENCY_FILES = [
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
];

function rootPath(relativePath) {
  return path.join(ROOT, relativePath);
}

function requireFile(relativePath) {
  const absolutePath = rootPath(relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`missing required file: ${relativePath}`);
  }
}

function readText(relativePath) {
  return fs.readFileSync(rootPath(relativePath), 'utf8');
}

function listJavaScriptFiles(dir = ROOT) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') return [];
        return listJavaScriptFiles(absolutePath);
      }
      if (!entry.isFile() || !(entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) return [];
      return [path.relative(ROOT, absolutePath).split(path.sep).join(path.posix.sep)];
    })
    .sort();
}

function localReferencePath(reference, baseDir) {
  const trimmed = reference.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (trimmed.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;

  const withoutHash = trimmed.split('#')[0];
  const pathname = withoutHash.split('?')[0];
  if (!pathname) return null;

  const normalized = pathname.startsWith('/')
    ? path.posix.normalize(pathname.slice(1))
    : path.posix.normalize(path.posix.join(baseDir, pathname));

  if (!normalized || normalized === '.') return null;
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`local reference escapes repository root: ${reference}`);
  }

  return normalized;
}

function assertNoDependencyBuildStep() {
  FORBIDDEN_DEPENDENCY_FILES.forEach((relativePath) => {
    if (fs.existsSync(rootPath(relativePath))) {
      throw new Error(`unexpected dependency/build metadata: ${relativePath}`);
    }
  });

  const trackedNodeModules = spawnSync('git', ['ls-files', 'node_modules'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (trackedNodeModules.status === 0 && trackedNodeModules.stdout.trim()) {
    throw new Error('node_modules is tracked by git');
  }
}

function assertProviderRetirement() {
  for (const retiredPath of ['vercel.json', '.vercelignore']) {
    if (fs.existsSync(rootPath(retiredPath))) {
      throw new Error(`retired provider file remains: ${retiredPath}`);
    }
  }

  for (const relativePath of [
    'CLAUDE.md',
    'README.md',
    'api/health.js',
    'api/canary/api/v1/errors.js',
  ]) {
    const source = readText(relativePath);
    if (/\bVercel\b|VERCEL_|x-vercel-/i.test(source)) {
      throw new Error(`retired provider marker remains: ${relativePath}`);
    }
  }
}

function assertCanaryRetired() {
  RETIRED_CANARY_FILES.forEach((relativePath) => {
    if (fs.existsSync(rootPath(relativePath))) {
      throw new Error(`retired canary file must not return: ${relativePath}`);
    }
  });

  const forbidden = [
    /canary\.mistystep\.io/i,
    /CANARY_API_KEY/,
    /CANARY_ENDPOINT/,
    /CANARY_SERVICE_NAME/,
    /CANARY_ENVIRONMENT/,
    /CANARY_READ/,
    /forwardToCanary/,
  ];
  for (const relativePath of [
    'index.html',
    'scripts/sentry.js',
    'api/health.js',
    'api/sentry-config.js',
    'api/canary/api/v1/errors.js',
    'server.js',
    'src/worker.mjs',
    'wrangler.jsonc',
    'README.md',
    'CLAUDE.md',
  ]) {
    const source = readText(relativePath);
    for (const pattern of forbidden) {
      if (pattern.test(source)) {
        throw new Error(`retired canary wiring remains in ${relativePath}: ${pattern}`);
      }
    }
  }

  const tombstone = readText('api/canary/api/v1/errors.js');
  if (/fetch\s*\(/.test(tombstone)) {
    throw new Error('the canary tombstone must not forward');
  }
  if (/JSON\.parse|readBody|MAX_BODY_BYTES/.test(tombstone)) {
    throw new Error('the canary tombstone must not parse or buffer bodies');
  }
}

function assertWorkerSourceIsNotAnAsset() {
  const ignored = readText('.assetsignore')
    .split(/\r?\n/)
    .map((line) => line.trim());
  for (const required of ['src/', '.dev.vars*', '.env*', 'node_modules/']) {
    if (!ignored.includes(required)) {
      throw new Error(
        `.assetsignore must exclude ${required} from the asset upload`
      );
    }
  }
}

function assertHtmlReferences() {
  const html = readText('index.html');
  const ids = new Set();
  for (const match of html.matchAll(/\sid=["']([^"']+)["']/g)) {
    ids.add(match[1]);
  }

  for (const match of html.matchAll(/\s(href|src)=["']([^"']+)["']/g)) {
    const [, attribute, value] = match;
    if (attribute === 'href' && value.startsWith('#')) {
      const id = value.slice(1);
      if (id && !ids.has(id)) {
        throw new Error(`missing in-page anchor target: ${value}`);
      }
      continue;
    }

    const localPath = localReferencePath(value, '');
    if (localPath) requireFile(localPath);
  }
}

function assertCssReferences() {
  const cssFiles = ['styles/main.css'];
  cssFiles.forEach((cssFile) => {
    const baseDir = path.posix.dirname(cssFile);
    const css = readText(cssFile);
    for (const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) {
      const localPath = localReferencePath(match[2], baseDir);
      if (localPath) requireFile(localPath);
    }
  });
}

function assertJavaScriptSyntax() {
  listJavaScriptFiles().forEach((relativePath) => {
    const result = spawnSync(process.execPath, ['--check', relativePath], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(`JavaScript syntax check failed: ${relativePath}`);
    }
  });
}

function runNodeScript(relativePath) {
  const result = spawnSync(process.execPath, [relativePath], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  if (result.status !== 0) {
    throw new Error(`command failed: node ${relativePath}`);
  }
}

function step(name, fn) {
  fn();
  console.log(`[ok] ${name}`);
}

function main() {
  step('required static files exist', () => REQUIRED_FILES.forEach(requireFile));
  step('zero-dependency static-site contract is intact', assertNoDependencyBuildStep);
  step('retired provider cannot be recreated', assertProviderRetirement);
  step('retired canary wiring cannot return', assertCanaryRetired);
  step('index.html local references resolve', assertHtmlReferences);
  step('CSS local references resolve', assertCssReferences);
  step('JavaScript parses', assertJavaScriptSyntax);
  step('liveness and retirement contracts hold', () =>
    runNodeScript('tools/verify-retirement.js')
  );
  step('browser bootstrap honors injectable config', () =>
    runNodeScript('tools/verify-browser.js')
  );
  step('DigitalOcean server adapter preserves behavior', () =>
    runNodeScript('tools/verify-server.js')
  );
  step('Worker entrypoint preserves behavior', () =>
    runNodeScript('tools/verify-worker.mjs')
  );
  step('worker sources stay out of the asset store', assertWorkerSourceIsNotAnAsset);
  console.log('trump-goggles-splash CI gate passed');
}

main();