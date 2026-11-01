/**
 * Publish gate: verifies that the publishable tarball is self-contained.
 *
 * `bun pm pack` cannot notice that a module reachable from `omp.extensions` is
 * missing from `files`, so this walks the import graph from every declared
 * entry, requires each relative import to be covered by `files`, and requires
 * every bare specifier to be declared in `dependencies`/`peerDependencies`.
 *
 * Run by `prepublishOnly`, by CI and by the publish workflow.
 * Usage: `bun run check:package`
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const REQUIRED_FIELDS = ["name", "version", "description", "license"] as const;
const GLOB_CHARS = ["*", "?", "!"];
const STATIC_SPECIFIER = /(?:\bfrom|\bimport)\s*["']([^"']+)["']/g;
const DYNAMIC_SPECIFIER = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

interface Manifest {
	name?: string;
	version?: string;
	description?: string;
	license?: string;
	private?: boolean;
	files?: string[];
	omp?: { extensions?: string[] };
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

function fail(message: string): never {
	console.error(`check-package: ${message}`);
	process.exit(1);
}

function readManifest(): Manifest {
	return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as Manifest;
}

/** Package root of a specifier: `@scope/name` or the first path segment. */
function packageNameOf(spec: string): string {
	const parts = spec.split("/");
	return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

/** Repo-relative POSIX path, the form `files` entries use. */
function relOf(abs: string): string {
	return path.relative(ROOT, abs).split(path.sep).join("/");
}

const isInsideRoot = (abs: string) => abs.startsWith(`${ROOT}${path.sep}`);

/** True when `files` ships `rel`, either explicitly or via a shipped directory. */
function coveredByFiles(rel: string, files: string[]): boolean {
	for (const entry of files) {
		const clean = path.posix.normalize(entry).replace(/\/$/, "");
		if (clean === rel) return true;
		if (clean !== "" && rel.startsWith(`${clean}/`) && existsSync(path.join(ROOT, clean))) return true;
	}
	return false;
}

function specifiersOf(source: string): string[] {
	const found = new Set<string>();
	for (const pattern of [STATIC_SPECIFIER, DYNAMIC_SPECIFIER]) {
		pattern.lastIndex = 0;
		for (const match of source.matchAll(pattern)) {
			const spec = match[1];
			if (spec) found.add(spec);
		}
	}
	return [...found];
}

function requireFields(manifest: Manifest): void {
	for (const field of REQUIRED_FIELDS) {
		const value = manifest[field];
		if (typeof value !== "string" || value.trim() === "") fail(`missing package.json field: ${field}`);
	}
	if (manifest.private === true) fail(`package.json is private: ${manifest.name}`);
}

function declaredEntries(manifest: Manifest): string[] {
	const extensions = manifest.omp?.extensions;
	if (!Array.isArray(extensions) || extensions.length === 0) fail("omp.extensions is empty");
	return extensions;
}

function declaredFiles(manifest: Manifest): string[] {
	const files = manifest.files ?? [];
	for (const entry of files) {
		if (GLOB_CHARS.some(c => entry.includes(c))) fail(`unsupported glob in "files": ${entry}`);
		if (!existsSync(path.join(ROOT, entry))) fail(`missing "files" entry: ${entry}`);
	}
	return files;
}

/** Absolute path of a declared extension entry, validated as a shipped module. */
function entryPath(entry: string): string {
	const abs = path.resolve(ROOT, entry);
	if (!isInsideRoot(abs)) fail(`entry escapes the package root: ${entry}`);
	const rel = relOf(abs);
	if (!existsSync(abs)) fail(`missing file: ${rel}`);
	if (!/\.(ts|js)$/.test(abs)) fail(`unsupported entry: ${rel}`);
	return abs;
}

/** Resolve a relative import, failing on escape, absence or missing coverage. */
function resolveRelative(spec: string, importer: string, files: string[]): string {
	const target = path.resolve(path.dirname(importer), spec);
	const importerRel = relOf(importer);
	if (!isInsideRoot(target)) fail(`relative import escapes the package root: ${spec} in ${importerRel}`);
	const rel = relOf(target);
	if (!existsSync(target)) fail(`missing file: ${rel} (imported by ${importerRel})`);
	if (!coveredByFiles(rel, files)) fail(`${rel} is not covered by "files" in package.json`);
	return target;
}

function checkBare(spec: string, importerRel: string, declared: ReadonlySet<string>): void {
	if (spec.startsWith("node:")) return;
	const name = packageNameOf(spec);
	if (!declared.has(name)) fail(`undeclared dependency "${name}" imported by ${importerRel}`);
}

function readSource(abs: string, importedBy?: string): string {
	try {
		return readFileSync(abs, "utf8");
	} catch {
		const rel = relOf(abs);
		fail(importedBy ? `missing file: ${rel} (imported by ${importedBy})` : `missing file: ${rel}`);
	}
}

/** Breadth-first walk of the shipped import graph; returns the shipped modules. */
function walk(manifest: Manifest, files: string[], entries: string[]): string[] {
	const declared = new Set([
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	]);
	const visited = new Set<string>();
	const shipped: string[] = [];
	const queue = entries.map(abs => ({ abs, importedBy: undefined as string | undefined }));
	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) break;
		const rel = relOf(item.abs);
		if (visited.has(rel)) continue;
		visited.add(rel);
		shipped.push(rel);
		for (const spec of specifiersOf(readSource(item.abs, item.importedBy))) {
			if (spec.startsWith(".")) queue.push({ abs: resolveRelative(spec, item.abs, files), importedBy: rel });
			else checkBare(spec, rel, declared);
		}
	}
	return shipped;
}

function main(): void {
	const manifest = readManifest();
	requireFields(manifest);
	const files = declaredFiles(manifest);
	const entries = declaredEntries(manifest).map(entryPath);
	const shipped = walk(manifest, files, entries);
	console.log(`check-package: ok — ${shipped.length} shipped modules (${manifest.name}@${manifest.version})`);
}

main();
