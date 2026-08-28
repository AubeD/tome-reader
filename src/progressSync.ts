// Lorebase progress synchronization: keeps a Markdown book note's
// page_current / chapter_current in sync with the reader's EPUB position.
//
// The note is found by matching its `book_file` frontmatter against the open
// EPUB's vault path. When no note exists, a minimal Lorebase-compatible note is
// created next to the EPUB (or an existing adjacent `type: book` note is safely
// adopted) so progress can still flow. Existing page totals, status, ratings
// and the note body are never overwritten — only the two current-position
// fields and chapter_total (which Tome derives from the actual TOC, correcting
// the scanner's spine-based count that includes cover/title pages) are updated,
// and only when they actually change.

import { App, Notice, TFile, debounce } from "obsidian";
import { Book, EpubCFI } from "epubjs";

// Shared with TomeView: the untyped epub.js location shape both consume.
export interface ProgressLocationEdge {
	cfi?: string;
	href?: string;
}

export interface ProgressLocation {
	start?: ProgressLocationEdge;
	end?: ProgressLocationEdge;
}

interface ProgressLocations {
	length(): number;
	percentageFromCfi(cfi: string | EpubCFI): number | null;
}

interface ProgressBookInternals {
	locations?: ProgressLocations;
}

// Same chars-per-page convention as Lorebase Book Scan, so estimated totals
// stay consistent with notes the scanner already produced.
const CHARS_PER_PAGE = 2000;
// epub.js locations.generate(1024) breaks the book every 1024 chars, so each
// generated location represents ~1024 chars.
const CHARS_PER_LOCATION = 1024;
const SYNC_DEBOUNCE_MS = 1000;

function bookInternals(book: Book | null): ProgressBookInternals | null {
	return book as unknown as ProgressBookInternals | null;
}

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

// One notice per open book for a given conflict reason, so a bad note doesn't
// spam the user on every page turn.
export class LorebaseProgressSync {
	private app: App;
	private book: Book | null = null;
	private epubFile: TFile | null = null;
	private noteFile: TFile | null = null;
	private disabled = false; // set when a conflict can't be resolved safely
	private lastLocation: ProgressLocation | null = null;
	private locationsReady = false;
	private locationCount = 0;
	// Chapter info is computed by TomeView from the actual TOC (not the spine,
	// which includes cover/title pages that aren't real chapters).
	private pendingChapterCurrent = 0;
	private pendingChapterTotal = 0;
	private lastWrittenPage = -1;
	private lastWrittenChapter = -1;
	private lastWrittenChapterTotal = -1;
	private resolvePromise: Promise<void> = Promise.resolve();

	private debouncedWrite = debounce(() => {
		void this.writeProgress();
	}, SYNC_DEBOUNCE_MS, true);

	constructor(app: App) {
		this.app = app;
	}

	// Called when an EPUB is opened. Resets prior state and begins note
	// resolution asynchronously so reading is never blocked.
	start(epubFile: TFile, book: Book): void {
		this.reset();
		this.epubFile = epubFile;
		this.book = book;
		this.disabled = false;
		this.resolvePromise = this.resolveNote();
	}

	// Called on every rendition "relocated". Stores the latest location and
	// TOC-based chapter info, then queues a debounced write once locations are
	// available.
	handleRelocated(location: ProgressLocation, chapterCurrent: number, chapterTotal: number): void {
		this.lastLocation = location;
		this.pendingChapterCurrent = chapterCurrent;
		this.pendingChapterTotal = chapterTotal;
		if (this.locationsReady && !this.disabled) {
			this.debouncedWrite();
		}
	}

	// Called after epub.js finishes locations.generate(). Fills any missing
	// page totals and processes the current position, covering the initial
	// relocation that fires before percentages are available.
	locationsGenerated(
		locationCount: number,
		currentLocation: ProgressLocation,
		chapterCurrent: number,
		chapterTotal: number
	): void {
		this.locationsReady = true;
		this.locationCount = locationCount;
		this.lastLocation = currentLocation;
		this.pendingChapterCurrent = chapterCurrent;
		this.pendingChapterTotal = chapterTotal;
		if (this.disabled) return;
		void this.resolvePromise.then(() => {
			if (this.disabled) return;
			void this.writeProgress();
		});
	}

	// Flush any pending write immediately, then clear state. Called before the
	// book is destroyed so the final position is never lost.
	async flushAndReset(): Promise<void> {
		this.debouncedWrite.cancel();
		if (!this.disabled && this.noteFile && this.lastLocation) {
			try {
				await this.writeProgress();
			} catch (e) {
				console.warn("Tome progress sync: final flush failed", e);
			}
		}
		this.reset();
	}

	private reset(): void {
		this.debouncedWrite.cancel();
		this.book = null;
		this.epubFile = null;
		this.noteFile = null;
		this.disabled = false;
		this.lastLocation = null;
		this.locationsReady = false;
		this.locationCount = 0;
		this.pendingChapterCurrent = 0;
		this.pendingChapterTotal = 0;
		this.lastWrittenPage = -1;
		this.lastWrittenChapter = -1;
		this.lastWrittenChapterTotal = -1;
	}

	// Find the non-series book note whose `book_file` matches the open EPUB,
	// or safely create/adopt a co-located fallback note.
	private async resolveNote(): Promise<void> {
		const epubFile = this.epubFile;
		if (!epubFile) return;
		const target = normPath(epubFile.path);
		if (!target) return;

		const markdownFiles = this.app.vault.getMarkdownFiles();
		const matches: TFile[] = [];
		for (const md of markdownFiles) {
			const cache = this.app.metadataCache.getFileCache(md);
			const fm = cache?.frontmatter;
			if (!fm) continue;
			if (fm.is_series === true) continue;
			const bf = asString(fm.book_file);
			if (!bf) continue;
			if (normPath(bf) === target) matches.push(md);
		}

		if (matches.length === 1) {
			this.noteFile = matches[0];
			return;
		}
		if (matches.length > 1) {
			// Prefer a co-located match if one is present, otherwise treat as
			// ambiguous and refuse to guess.
			const coLocated = matches.find((f) => normPath(f.path) === target.replace(/\.epub$/i, ".md"));
			if (coLocated) {
				this.noteFile = coLocated;
				return;
			}
			this.disabled = true;
			new Notice(`Tome: multiple notes reference "${epubFile.name}" via book_file — progress not synced.`);
			return;
		}

		// No match — try the co-located fallback path.
		await this.createOrAdoptFallbackNote();
	}

	private async createOrAdoptFallbackNote(): Promise<void> {
		const epubFile = this.epubFile;
		if (!epubFile) return;
		const notePath = epubFile.path.replace(/\.epub$/i, ".md");
		const existing = this.app.vault.getAbstractFileByPath(notePath);

		if (!existing) {
			const frontmatter = this.buildFallbackFrontmatter(epubFile.basename);
			try {
				const created = await this.app.vault.create(notePath, frontmatter + "\n");
				if (created instanceof TFile) {
					this.noteFile = created;
					this.lastWrittenPage = 0;
					this.lastWrittenChapter = 0;
				}
			} catch (e) {
				console.warn("Tome progress sync: failed to create fallback note", e);
				this.disabled = true;
			}
			return;
		}

		if (!(existing instanceof TFile)) {
			this.disabled = true;
			new Notice(`Tome: "${notePath}" exists but is not a file — progress not synced.`);
			return;
		}

		// Adopt only a non-series `type: book` note; leave everything else alone.
		const cache = this.app.metadataCache.getFileCache(existing);
		const fm = cache?.frontmatter;
		const type = asString(fm?.type).toLowerCase();
		const isSeries = fm?.is_series === true;
		if (isSeries || (type && type !== "book")) {
			this.disabled = true;
			new Notice(`Tome: "${existing.name}" is not a book note — progress not synced.`);
			return;
		}

		this.noteFile = existing;
		// book_file and missing totals are filled on the first write.
		this.lastWrittenPage = -1;
		this.lastWrittenChapter = -1;
	}

	private buildFallbackFrontmatter(title: string): string {
		const lines: string[] = ["---"];
		lines.push('type: "book"');
		lines.push(`title: "${title.replace(/"/g, '\\"')}"`);
		lines.push(`book_file: "${(this.epubFile?.path ?? "").replace(/"/g, '\\"')}"`);
		lines.push("page_current: 0");
		lines.push("page_total: null");
		lines.push("chapter_current: 0");
		lines.push("chapter_total: null");
		lines.push('status: "planned"');
		lines.push("---");
		return lines.join("\n");
	}

	// Compute the current page from the latest location and write it together
	// with the TOC-based chapter info to the note's frontmatter. Skips the
	// physical write when nothing changed.
	private async writeProgress(): Promise<void> {
		const noteFile = this.noteFile;
		const epubFile = this.epubFile;
		const book = this.book;
		const location = this.lastLocation;
		if (!noteFile || !epubFile || !book || !location) return;

		// Validate the resolved note is still the right one.
		if (!this.app.vault.getAbstractFileByPath(noteFile.path)) {
			this.noteFile = null;
			this.disabled = true;
			return;
		}
		const cache = this.app.metadataCache.getFileCache(noteFile);
		const fm = cache?.frontmatter;
		if (fm?.is_series === true) {
			this.disabled = true;
			return;
		}
		const currentBookFile = asString(fm?.book_file);
		if (currentBookFile && normPath(currentBookFile) !== normPath(epubFile.path)) {
			// The note's book_file changed underneath us — re-resolve.
			this.noteFile = null;
			this.resolvePromise = this.resolveNote();
			await this.resolvePromise;
			if (!this.noteFile) return;
			return;
		}

		const internals = bookInternals(book);
		const cfi = asString(location.start?.cfi);

		let pageCurrent = 0;
		if (cfi && this.locationsReady && internals?.locations) {
			const pct = internals.locations.percentageFromCfi(cfi);
			if (typeof pct === "number" && !isNaN(pct)) {
				const pageTotal = this.resolvePageTotal(fm, internals.locations.length());
				if (pageTotal > 0) {
					pageCurrent = clampInt(Math.round(pct * pageTotal), 0, pageTotal);
				}
			}
		}

		// Chapter info comes from TomeView's TOC, not the spine.
		const chapterCurrent = this.pendingChapterTotal > 0 ? this.pendingChapterCurrent : 0;
		const chapterTotal = this.pendingChapterTotal;

		// Skip the write when nothing changed since the last successful write.
		if (
			pageCurrent === this.lastWrittenPage &&
			chapterCurrent === this.lastWrittenChapter &&
			chapterTotal === this.lastWrittenChapterTotal
		) {
			return;
		}

		const writePage = pageCurrent;
		const writeChapter = chapterCurrent;
		const writeChapterTotal = chapterTotal;
		const pageTotalForFill = this.resolvePageTotal(fm, internals?.locations?.length() ?? 0);

		try {
			await this.app.fileManager.processFrontMatter(noteFile, (frontmatter) => {
				// Always ensure book_file points at this EPUB.
				if (isMissing(frontmatter.book_file) || asString(frontmatter.book_file) === "") {
					frontmatter.book_file = epubFile.path;
				}
				// page_total is an estimate — fill missing only, never overwrite.
				if (isMissing(frontmatter.page_total) && pageTotalForFill > 0) {
					frontmatter.page_total = pageTotalForFill;
				}
				// chapter_total is derived from the actual TOC, which excludes
				// cover/title pages the scanner's spine count includes — so
				// always write the authoritative value when the TOC is loaded.
				if (writeChapterTotal > 0) {
					frontmatter.chapter_total = writeChapterTotal;
				}
				// Current position is the one thing we always own.
				frontmatter.page_current = writePage;
				frontmatter.chapter_current = writeChapter;
			});
			this.lastWrittenPage = writePage;
			this.lastWrittenChapter = writeChapter;
			this.lastWrittenChapterTotal = writeChapterTotal;
		} catch (e) {
			console.warn("Tome progress sync: write failed", e);
		}
	}

	// Use an existing positive page_total as the source of truth; otherwise
	// estimate from the generated location count using the scanner's
	// chars-per-page convention.
	private resolvePageTotal(fm: Record<string, unknown> | undefined, locationCount: number): number {
		const existing = fm?.page_total;
		if (typeof existing === "number" && existing > 0) return existing;
		if (locationCount > 0) {
			return Math.max(1, Math.round((locationCount * CHARS_PER_LOCATION) / CHARS_PER_PAGE));
		}
		return 0;
	}
}

function clampInt(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return Math.round(value);
}
