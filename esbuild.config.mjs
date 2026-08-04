import esbuild from "esbuild";
import process from "process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";
const root = path.dirname(fileURLToPath(import.meta.url));

// epub.js and JSZip still ship Internet-Explorer-era fallbacks that create
// <script> elements and build functions from strings. Obsidian runs on
// Chromium, so those paths are dead weight: the polyfills are swapped for
// modern equivalents and the two opt-in epub.js script-injection features
// (which Tome never enables — books render with allowScriptedContent: false)
// are disabled at their entry point. The build fails loudly if upstream code
// changes shape, and the bundle is verified afterwards.
const shims = {
	immediate: "src/shims/immediate.js",
	setimmediate: "src/shims/setimmediate.js",
	localforage: "src/shims/localforage.js",
};

// JSZip ships a pre-bundled browser build with those polyfills baked in, and
// epub.js imports it by path. Both are redirected to JSZip's modular entry
// point so the polyfills resolve as real modules — and can be replaced above.
const redirects = [
	{ filter: /^jszip(\/dist\/jszip(\.min)?(\.js)?)?$/, to: "node_modules/jszip/lib/index.js" },
	{ filter: /^readable-stream$/, to: "node_modules/jszip/lib/readable-stream-browser.js" },
];

const patches = [
	{
		filter: /epubjs[\\/](lib|src)[\\/]contents\.js$/,
		from: "addScript(src) {",
		to: "addScript(src) { return Promise.resolve(false); /* Tome Reader: script injection disabled */",
	},
	{
		filter: /epubjs[\\/](lib|src)[\\/]rendition\.js$/,
		from: "injectScript(doc, section) {",
		to: "injectScript(doc, section) { return; /* Tome Reader: script injection disabled */",
	},
];

const modernizeDependencies = {
	name: "tome-modernize-dependencies",
	setup(build) {
		build.onResolve({ filter: /^(immediate|setimmediate|localforage)$/ }, (args) => ({
			path: path.join(root, shims[args.path]),
		}));

		for (const redirect of redirects) {
			build.onResolve({ filter: redirect.filter }, () => ({
				path: path.join(root, redirect.to),
			}));
		}

		for (const patch of patches) {
			build.onLoad({ filter: patch.filter }, async (args) => {
				const source = await fs.readFile(args.path, "utf8");
				if (!source.includes(patch.from)) {
					throw new Error(
						`Tome build: "${patch.from}" not found in ${args.path} — the upstream code changed, update esbuild.config.mjs`
					);
				}
				return { contents: source.split(patch.from).join(patch.to), loader: "js" };
			});
		}
	},
};

const config = {
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
		...builtinModules.map((name) => `node:${name}`),
	],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
	plugins: [modernizeDependencies],
};

// Guards against a dependency quietly reintroducing dynamic code execution.
async function verifyBundle() {
	const bundle = await fs.readFile(path.join(root, "main.js"), "utf8");
	const banned = [
		{ label: 'createElement("script")', pattern: /createElement\(\s*["'`]script["'`]/g },
		{ label: "new Function(", pattern: /new Function\s*\(/g },
		{ label: "eval(", pattern: /[^.\w]eval\s*\(/g },
	];
	const found = banned
		.map(({ label, pattern }) => ({ label, count: (bundle.match(pattern) ?? []).length }))
		.filter(({ count }) => count > 0);
	if (found.length) {
		const summary = found.map(({ label, count }) => `${label} × ${count}`).join(", ");
		throw new Error(`Tome build: dynamic code execution found in the bundle (${summary})`);
	}
	console.log("✅ bundle verified: no dynamic code execution");
}

if (prod) {
	const context = await esbuild.context(config);
	await context.rebuild();
	await context.dispose();
	await verifyBundle();
	process.exit(0);
} else {
	const context = await esbuild.context(config);
	await context.watch();
}
