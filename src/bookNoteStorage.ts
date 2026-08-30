// Per-book data storage via Markdown book notes.
//
// Reading position (CFI) and bookmarks are stored in each book note's
// frontmatter instead of the plugin's global data.json, so syncing a vault
// across devices (e.g. via MEGA) no longer conflicts when different books are
// read on different devices.
//
// This module owns:
// - Shared note resolution (find/create the book note for a given EPUB)
// - In-memory cache of CFI and bookmarks per open book
// - Bookmark persistence (explicit add/delete actions)
// - One-time migration of legacy data.json entries to notes
//
// CFI persistence is handled by progressSync.ts, which merges tome_cfi into
// its existing debounced progress write to avoid a second Markdown rewrite.

import { App, Notice, TFile, Vault, MetadataCache, EventRef } from "obsidian";

export interface TomeBookmark {
	cfi: string;
	label: string;
	created: number;
}

export type FrontmatterMutator = (frontmatter: Record<string, unknown>) => void;

// Normalize a vault path or an in-archive href for exact comparison:
// lowercased, forward slashes, no "." / ".." segments.
function normPath(p: string): string {
	return (p ?? "")
		.replace(/\\/g, "/")
		.toLowerCase()
		.split("/")
		.filter((seg) => seg && seg !== "." && seg !== "..")
		.join("/");
}

function isMissing(value: unknown): boolean {
	return value === undefined || value === null;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && !isNaN(value) ? value : null;
}

// Parse tome_bookmarks from frontmatter into validated TomeBookmark[].
// Ignores malformed entries rather than failing.
function parseBookmarks(raw: unknown): TomeBookmark[] {
	if (!Array.isArray(raw)) return [];
	const result: TomeBookmark[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const cfi = asString(e.cfi);
		const label = asString(e.label);
		const created = asNumber(e.created);
		if (!cfi) continue;
		result.push({ cfi, label, created: created ?? Date.now() });
	}
	return result;
}

interface BookData {
	cfi: string;
	bookmarks: TomeBookmark[];
}

export class BookNoteStorage {
	private app: App;
	private vault: Vault;
	private metadataCache: MetadataCache;

	// In-memory state per normalized EPUB path, shared across all open views.
	private cfiCache = new Map<string, string>();
	private bookmarkCache = new Map<string, TomeBookmark[]>();
	private noteCache = new Map<string, TFile | null>();
	private writeQueues = new Map<string, Promise<void>>();

	// Lazily built index: normalized book_file → matching note files.
	private index: Map<string, TFile[]> | null = null;
	private indexBuilt = false;

	// Event refs for index invalidation.
	private eventRefs: EventRef[] = [];

	constructor(app: App) {
		this.app = app;
		this.vault = app.vault;
		this.metadataCache = app.metadataCache;
		this.registerListeners();
	}

	private registerListeners(): void {
		// Invalidate affected index entries on file changes rather than
		// rebuilding the whole index after every Tome write.
		const changed = this.metadataCache.on("changed", (file) => {
			if (!(file instanceof TFile) || !this.indexBuilt) return;
			this.invalidateIndexForFile(file);
		});
		const deleted = this.vault.on("delete", (file) => {
			if (!(file instanceof TFile) || !this.indexBuilt) return;
			this.invalidateIndexForFile(file);
		});
		const renamed = this.vault.on("rename", (file, oldPath) => {
			if (!(file instanceof TFile) || !this.indexBuilt) return;
			this.invalidateIndexForFile(file);
			// Also invalidate the old path's note cache entry
			const oldNorm = normPath(oldPath);
			for (const [epubPath, note] of this.noteCache.entries()) {
				if (note && normPath(note.path) === oldNorm) {
					this.noteCache.delete(epubPath);
				}
			}
		});
		this.eventRefs.push(changed, deleted, renamed);
	}

	private invalidateIndexForFile(file: TFile): void {
		if (!this.index) return;
		const cache = this.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		const bf = asString(fm?.book_file);
		if (bf) {
			const key = normPath(bf);
			if (key) this.index.delete(key);
		}
		// Also check if this file was previously in the index under any key
		// (e.g. its book_file was removed).
		for (const [key, notes] of this.index.entries()) {
			const filtered = notes.filter((n) => n.path !== file.path);
			if (filtered.length !== notes.length) {
				if (filtered.length === 0) {
					this.index.delete(key);
				} else {
					this.index.set(key, filtered);
				}
			}
		}
	}

	// Build the book_file → notes index in one pass over all Markdown files.
	private buildIndex(): void {
		if (this.indexBuilt) return;
		this.index = new Map();
		const markdownFiles = this.vault.getMarkdownFiles();
		for (const md of markdownFiles) {
			const cache = this.metadataCache.getFileCache(md);
			const fm = cache?.frontmatter;
			if (!fm) continue;
			if (fm.is_series === true) continue;
			const bf = asString(fm.book_file);
			if (!bf) continue;
			const key = normPath(bf);
			if (!key) continue;
			const existing = this.index.get(key);
			if (existing) {
				existing.push(md);
			} else {
				this.index.set(key, [md]);
			}
		}
		this.indexBuilt = true;
	}

	// Find the non-series book note whose `book_file` matches the EPUB path.
	// Synchronous; uses the lazily built index.
	findBookNote(epubPath: string): TFile | null {
		const target = normPath(epubPath);
		if (!target) return null;

		// Check cache first.
		const cached = this.noteCache.get(target);
		if (cached !== undefined) {
			// Validate the cached note still exists and still matches.
			if (cached && this.vault.getAbstractFileByPath(cached.path) === cached) {
				return cached;
			}
			this.noteCache.delete(target);
		}

		// Try the co-located path first (O(1)).
		const notePath = epubPath.replace(/\.epub$/i, ".md");
		const coLocated = this.vault.getAbstractFileByPath(notePath);
		if (coLocated instanceof TFile) {
			const cache = this.metadataCache.getFileCache(coLocated);
			const fm = cache?.frontmatter;
			if (fm && fm.is_series !== true) {
				const type = asString(fm.type).toLowerCase();
				const bf = asString(fm.book_file);
				// Accept if it's a book note (or typeless) and book_file is
				// empty or matches.
				if ((!type || type === "book") && (!bf || normPath(bf) === target)) {
					this.noteCache.set(target, coLocated);
					return coLocated;
				}
			}
		}

		// Fall back to the index.
		this.buildIndex();
		const matches = this.index?.get(target) ?? [];
		if (matches.length === 0) return null;
		if (matches.length === 1) {
			this.noteCache.set(target, matches[0]);
			return matches[0];
		}
		// Multiple matches — prefer a co-located one.
		const coLocatedMatch = matches.find((f) => normPath(f.path) === target.replace(/\.epub$/i, ".md"));
		if (coLocatedMatch) {
			this.noteCache.set(target, coLocatedMatch);
			return coLocatedMatch;
		}
		// Ambiguous — refuse to guess.
		return null;
	}

	// Create a minimal Lorebase-compatible note beside the EPUB, or safely
	// adopt an existing adjacent non-series `type: book` note. Returns null +
	// notice on conflict.
	async createFallbackNote(epubFile: TFile): Promise<TFile | null> {
		const notePath = epubFile.path.replace(/\.epub$/i, ".md");
		const existing = this.vault.getAbstractFileByPath(notePath);

		if (!existing) {
			const frontmatter = this.buildFallbackFrontmatter(epubFile.basename, epubFile.path);
			try {
				const created = await this.vault.create(notePath, frontmatter + "\n");
				if (created instanceof TFile) {
					this.noteCache.set(normPath(epubFile.path), created);
					return created;
				}
			} catch (e) {
				console.warn("Tome storage: failed to create fallback note", e);
				return null;
			}
			return null;
		}

		if (!(existing instanceof TFile)) {
			new Notice(`Tome: "${notePath}" exists but is not a file — progress not synced.`);
			return null;
		}

		// Adopt only a non-series `type: book` note; leave everything else alone.
		const cache = this.metadataCache.getFileCache(existing);
		const fm = cache?.frontmatter;
		const type = asString(fm?.type).toLowerCase();
		const isSeries = fm?.is_series === true;
		if (isSeries || (type && type !== "book")) {
			new Notice(`Tome: "${existing.name}" is not a book note — progress not synced.`);
			return null;
		}

		this.noteCache.set(normPath(epubFile.path), existing);
		return existing;
	}

	private buildFallbackFrontmatter(title: string, epubPath: string): string {
		const lines: string[] = ["---"];
		lines.push('type: "book"');
		lines.push(`title: "${title.replace(/"/g, '\\"')}"`);
		lines.push(`book_file: "${epubPath.replace(/"/g, '\\"')}"`);
		lines.push("page_current: 0");
		lines.push("page_total: null");
		lines.push("chapter_current: 0");
		lines.push("chapter_total: null");
		lines.push('status: "planned"');
		lines.push("---");
		return lines.join("\n");
	}

	// Resolve the note for an EPUB, creating a fallback if needed.
	// Returns null if no note can be found or created safely.
	async resolveNote(epubFile: TFile): Promise<TFile | null> {
		const existing = this.findBookNote(epubFile.path);
		if (existing) return existing;
		return await this.createFallbackNote(epubFile);
	}

	// Load CFI and bookmarks from the note's cached frontmatter into the
	// in-memory cache. Called when a book is opened.
	loadFromNote(epubPath: string): void {
		const target = normPath(epubPath);
		const note = this.findBookNote(epubPath);
		if (!note) {
			this.cfiCache.set(target, "");
			this.bookmarkCache.set(target, []);
			return;
		}
		const cache = this.metadataCache.getFileCache(note);
		const fm = cache?.frontmatter;
		this.cfiCache.set(target, asString(fm?.tome_cfi));
		this.bookmarkCache.set(target, parseBookmarks(fm?.tome_bookmarks));
	}

	// Read the cached CFI for a book. Returns "" if not loaded or no note.
	getCfi(epubPath: string): string {
		return this.cfiCache.get(normPath(epubPath)) ?? "";
	}

	// Update the in-memory CFI synchronously (for tab restoration).
	// Does NOT persist to disk — progressSync handles that in its combined write.
	setCfiInMemory(epubPath: string, cfi: string): void {
		this.cfiCache.set(normPath(epubPath), cfi);
	}

	// Read the cached bookmarks for a book. Returns a mutable array reference.
	// Creates an empty array in cache if missing.
	getBookmarks(epubPath: string): TomeBookmark[] {
		const target = normPath(epubPath);
		let bms = this.bookmarkCache.get(target);
		if (!bms) {
			bms = [];
			this.bookmarkCache.set(target, bms);
		}
		return bms;
	}

	async mutateFrontmatter(noteFile: TFile, mutator: FrontmatterMutator): Promise<void> {
		await this.enqueueWrite(noteFile, async () => {
			await this.app.fileManager.processFrontMatter(noteFile, (frontmatter) => {
				mutator(frontmatter as Record<string, unknown>);
			});
		});
	}

	async mutateContent(noteFile: TFile, mutator: (content: string) => string): Promise<void> {
		await this.enqueueWrite(noteFile, async () => {
			await this.vault.process(noteFile, mutator);
		});
	}

	private async enqueueWrite(noteFile: TFile, operation: () => Promise<void>): Promise<void> {
		const key = noteFile.path;
		const previous = this.writeQueues.get(key) ?? Promise.resolve();
		const current = previous.catch(() => {}).then(operation);
		this.writeQueues.set(key, current);
		try {
			await current;
		} finally {
			if (this.writeQueues.get(key) === current) {
				this.writeQueues.delete(key);
			}
		}
	}

	// Persist bookmarks to the note's frontmatter. Called on explicit
	// add/delete actions (not debounced — user clicks are infrequent).
	async persistBookmarks(epubFile: TFile): Promise<void> {
		const target = normPath(epubFile.path);
		const bms = this.bookmarkCache.get(target);
		if (!bms) return;
		const note = await this.resolveNote(epubFile);
		if (!note) return;
		try {
			await this.mutateFrontmatter(note, (frontmatter) => {
				frontmatter.tome_bookmarks = bms!.map((bm) => ({
					cfi: bm.cfi,
					label: bm.label,
					created: bm.created,
				}));
			});
		} catch (e) {
			console.warn("Tome storage: bookmark persist failed", e);
		}
	}

	// One-time migration of legacy data.json entries to notes.
	// Only runs when there are entries to migrate. Processes sequentially
	// with periodic yielding to avoid freezing the UI.
	async migrateAll(
		locations: Record<string, string>,
		bookmarks: Record<string, TomeBookmark[]>
	): Promise<void> {
		// Union all paths that have either a location or bookmarks.
		const allPaths = new Set<string>();
		for (const p of Object.keys(locations)) allPaths.add(p);
		for (const p of Object.keys(bookmarks)) allPaths.add(p);
		if (allPaths.size === 0) return;

		const notice = new Notice(`Tome: migrating ${allPaths.size} book(s) to notes…`, 0);
		let migrated = 0;
		let skipped = 0;
		let i = 0;

		for (const epubPath of allPaths) {
			i++;
			// Yield to the UI every 10 books to keep Obsidian responsive.
			if (i % 10 === 0) {
				await new Promise((r) => setTimeout(r, 0));
			}

			// Check the EPUB still exists.
			const epubFile = this.vault.getAbstractFileByPath(epubPath);
			if (!(epubFile instanceof TFile)) {
				skipped++;
				continue;
			}

			const cfi = locations[epubPath] ?? "";
			const bms = bookmarks[epubPath] ?? [];
			if (!cfi && bms.length === 0) {
				skipped++;
				continue;
			}

			const note = await this.resolveNote(epubFile);
			if (!note) {
				skipped++;
				continue;
			}

			try {
				await this.mutateFrontmatter(note, (frontmatter) => {
					// Preserve existing note-side values: don't overwrite a
					// non-empty tome_cfi or existing tome_bookmarks with
					// legacy data.
					if (cfi && (!asString(frontmatter.tome_cfi))) {
						frontmatter.tome_cfi = cfi;
					}
					if (bms.length > 0 && !Array.isArray(frontmatter.tome_bookmarks)) {
						frontmatter.tome_bookmarks = bms.map((bm) => ({
							cfi: bm.cfi,
							label: bm.label,
							created: bm.created,
						}));
					}
				});
				migrated++;
			} catch (e) {
				console.warn(`Tome migration: failed for "${epubPath}"`, e);
				skipped++;
			}
		}

		notice.hide();
		if (migrated > 0) {
			new Notice(`Tome: migrated ${migrated} book(s) to notes${skipped > 0 ? ` (${skipped} skipped)` : ""}.`);
		}
	}

	// Clean up event listeners.
	unload(): void {
		for (const ref of this.eventRefs) {
			this.app.metadataCache.offref(ref);
			this.vault.offref(ref);
		}
		this.eventRefs = [];
		this.cfiCache.clear();
		this.bookmarkCache.clear();
		this.noteCache.clear();
		this.writeQueues.clear();
		this.index = null;
		this.indexBuilt = false;
	}
}
