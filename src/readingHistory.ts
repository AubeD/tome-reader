import { App, TFile } from "obsidian";
import { BookNoteStorage } from "./bookNoteStorage";

const MINIMUM_SESSION_MS = 60_000;
const CHECKPOINT_MS = 60_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;
const TICK_MS = 1_000;
const VIEW_SIGNATURE = "/* tome-reading-history-v2 */";
const VIEW_BLOCK = `\`\`\`dataviewjs
${VIEW_SIGNATURE}
const history = dv.current().reading_history ?? [];
const totalSeconds = dv.current().reading_time_seconds ?? 0;

function duration(seconds) {
    const s = Math.floor(seconds);
    const minutes = Math.floor(s / 60);
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    const remainingSeconds = s % 60;

    if (hours > 0) {
        return \`${"${hours}"}h ${"${String(remainingMinutes).padStart(2, \"0\")}"}min\`;
    } else if (minutes > 0) {
        return \`${"${minutes}"}min\`;
    } else {
        return \`${"${remainingSeconds}"}s\`;
    }
}

dv.paragraph(\`**Total reading time:** ${"${duration(totalSeconds)}"}\`);
dv.table(
    ["Date", "Start", "End", "Duration"],
    history.slice().reverse().map((entry) => [
        entry.date,
        \`${"${Number(entry.start_percent).toFixed(1)}"}%\`,
        \`${"${Number(entry.end_percent).toFixed(1)}"}%\`,
        duration(entry.duration_seconds),
    ])
);
\`\`\``;

interface ReadingDay {
	date: string;
	start_percent: number;
	end_percent: number;
	duration_seconds: number;
}

interface PreservedState {
	openActiveMs: number;
	qualified: boolean;
	pendingMs: number;
}

export interface ReadingHistoryMutation {
	apply(frontmatter: Record<string, unknown>): void;
	commit(noteFile: TFile): Promise<void>;
	rollback(): void;
}

function asFiniteNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	} else {
		return null;
	}
}

function clampPercent(value: number): number {
	return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

function parseHistory(value: unknown): ReadingDay[] {
	if (value === undefined || value === null) {
		return [];
	} else if (!Array.isArray(value)) {
		throw new Error("reading_history is not an array");
	}
	const history: ReadingDay[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error("reading_history contains a non-object entry");
		}
		const entry = raw as Record<string, unknown>;
		const date = typeof entry.date === "string" ? entry.date.trim() : "";
		const start = asFiniteNumber(entry.start_percent);
		const end = asFiniteNumber(entry.end_percent);
		const seconds = asFiniteNumber(entry.duration_seconds);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || start === null || end === null || seconds === null || seconds < 0) {
			throw new Error(`reading_history contains an invalid entry for "${date || "unknown date"}"`);
		}
		history.push({
			date,
			start_percent: clampPercent(start),
			end_percent: clampPercent(end),
			duration_seconds: Math.round(seconds),
		});
	}
	return history;
}

function localDateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function localIso(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	const second = String(date.getSeconds()).padStart(2, "0");
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const offsetHour = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
	const offsetMinute = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
	return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`;
}

export class ReadingHistoryTracker {
	private app: App;
	private storage: BookNoteStorage;
	private epubFile: TFile | null = null;
	private notePromise: Promise<TFile | null> = Promise.resolve(null);
	private currentPercent: number | null = null;
	private day = "";
	private dayStartPercent: number | null = null;
	private environmentActive = false;
	private counting = false;
	private activeSince = 0;
	private lastInteractionAt = 0;
	private lastActiveAt = 0;
	private openActiveMs = 0;
	private pendingMs = 0;
	private lastPersistedAt = 0;
	private qualified = false;
	private mutationInFlight = false;
	private viewEnsured = false;
	private tickTimer: number | null = null;
	private tickRunning = false;

	constructor(app: App, storage: BookNoteStorage) {
		this.app = app;
		this.storage = storage;
	}

	start(epubFile: TFile, preserved?: PreservedState): void {
		this.reset();
		const now = Date.now();
		this.epubFile = epubFile;
		this.notePromise = this.storage.resolveNote(epubFile);
		this.day = localDateKey(new Date(now));
		this.lastInteractionAt = now;
		this.lastPersistedAt = now;
		// Preserve qualification accumulators across same-book reloads (e.g.
		// paginated ↔ scroll mode switch) so a sub-60s session before the
		// reload still counts toward the minimum-session threshold.
		if (preserved) {
			this.openActiveMs = preserved.openActiveMs;
			this.qualified = preserved.qualified;
			this.pendingMs = preserved.pendingMs;
		}
		this.tickTimer = window.setInterval(() => void this.tick(), TICK_MS);
		this.log("started", { book: epubFile.path, preserved: preserved ? { openActiveMs: preserved.openActiveMs, pendingMs: preserved.pendingMs, qualified: preserved.qualified } : undefined });
	}

	// Capture qualification state before a same-book reload so it can be
	// passed to start(). Called before closeBook() wipes the tracker.
	suspendForReload(): PreservedState | null {
		if (!this.epubFile) {
			return null;
		}
		if (this.counting) {
			this.accrue(Date.now());
			this.counting = false;
		}
		return {
			openActiveMs: this.openActiveMs,
			qualified: this.qualified,
			pendingMs: this.pendingMs,
		};
	}

	updatePosition(percent: number | null): void {
		if (percent !== null && Number.isFinite(percent)) {
			this.currentPercent = clampPercent(percent);
			if (this.counting && this.dayStartPercent === null) {
				this.dayStartPercent = this.currentPercent;
			}
		}
	}

	recordInteraction(source: string): void {
		if (!this.epubFile) {
			return;
		}
		const now = Date.now();
		this.lastInteractionAt = now;
		if (this.environmentActive && !this.counting) {
			this.resume(now, `interaction:${source}`);
		}
	}

	setEnvironmentActive(active: boolean, reason: string, flushOnPause = true): void {
		this.environmentActive = active;
		const now = Date.now();
		if (active) {
			if (!this.counting && now - this.lastInteractionAt < IDLE_TIMEOUT_MS) {
				this.resume(now, reason);
			}
		} else if (this.counting) {
			this.accrue(now);
			this.counting = false;
			this.log("paused", { reason, pendingSeconds: Math.floor(this.pendingMs / 1000) });
			if (flushOnPause) {
				void this.flushStandalone(`pause:${reason}`, true);
			}
		}
	}

	prepareMutation(reason: string, force = false): ReadingHistoryMutation | null {
		if (this.mutationInFlight || !this.epubFile) {
			return null;
		}
		const now = Date.now();
		if (this.counting) {
			this.accrue(now);
		}
		if (!this.qualified && this.openActiveMs >= MINIMUM_SESSION_MS) {
			this.qualified = true;
			this.log("qualified", { activeSeconds: Math.floor(this.openActiveMs / 1000) });
		}
		const seconds = Math.floor(this.pendingMs / 1000);
		if (!this.qualified || seconds <= 0 || this.currentPercent === null || this.dayStartPercent === null) {
			return null;
		}
		if (!force && seconds < CHECKPOINT_MS / 1000) {
			return null;
		}
		const snapshot = {
			day: this.day,
			startPercent: clampPercent(this.dayStartPercent),
			endPercent: clampPercent(this.currentPercent),
			seconds,
			lastRead: localIso(new Date(this.lastActiveAt || now)),
		};
		this.mutationInFlight = true;
		let applied = false;
		return {
			apply: (frontmatter) => {
				const history = parseHistory(frontmatter.reading_history);
				const existing = history.find((entry) => entry.date === snapshot.day);
				if (existing) {
					existing.end_percent = snapshot.endPercent;
					existing.duration_seconds += snapshot.seconds;
				} else {
					history.push({
						date: snapshot.day,
						start_percent: snapshot.startPercent,
						end_percent: snapshot.endPercent,
						duration_seconds: snapshot.seconds,
					});
				}
				history.sort((left, right) => left.date.localeCompare(right.date));
				frontmatter.reading_history = history;
				frontmatter.reading_time_seconds = history.reduce((total, entry) => total + entry.duration_seconds, 0);
				frontmatter.last_read = snapshot.lastRead;
				applied = true;
			},
			commit: async (noteFile) => {
				this.pendingMs = Math.max(0, this.pendingMs - snapshot.seconds * 1000);
				this.lastPersistedAt = Date.now();
				this.mutationInFlight = false;
				this.log("persisted", { reason, mode: reason === "progress" ? "coalesced" : "standalone", seconds: snapshot.seconds, day: snapshot.day });
				await this.ensureView(noteFile);
			},
			rollback: () => {
				this.mutationInFlight = false;
				this.log("persistence failed", { reason, applied });
			},
		};
	}

	async flushStandalone(reason: string, force = false): Promise<boolean> {
		const mutation = this.prepareMutation(reason, force);
		if (!mutation) {
			return false;
		}
		const noteFile = await this.notePromise;
		if (!noteFile) {
			mutation.rollback();
			return false;
		}
		try {
			await this.storage.mutateFrontmatter(noteFile, mutation.apply);
			await mutation.commit(noteFile);
			return true;
		} catch (error) {
			mutation.rollback();
			console.warn("Tome reading history: write failed", error);
			return false;
		}
	}

	async flushAndReset(): Promise<void> {
		if (this.counting) {
			this.accrue(Date.now());
			this.counting = false;
		}
		await this.flushStandalone("close-fallback", true);
		if (!this.qualified && this.openActiveMs > 0) {
			this.log("discarded short session", { activeSeconds: Math.floor(this.openActiveMs / 1000) });
		}
		this.reset();
	}

	private async tick(): Promise<void> {
		if (this.tickRunning || !this.epubFile) {
			return;
		}
		this.tickRunning = true;
		try {
			const now = Date.now();
			const today = localDateKey(new Date(now));
			if (today !== this.day) {
				if (this.counting) {
					this.accrue(now);
					this.counting = false;
				}
				this.log("midnight rollover", { from: this.day, to: today });
				await this.flushStandalone("midnight", true);
				this.day = today;
				this.dayStartPercent = this.currentPercent;
				if (this.environmentActive) {
					this.resume(Date.now(), "midnight");
				}
			}
			if (this.counting && now - this.lastInteractionAt >= IDLE_TIMEOUT_MS) {
				const cutoff = this.lastInteractionAt + IDLE_TIMEOUT_MS;
				this.accrue(cutoff);
				this.counting = false;
				this.log("idle timeout", { idleMinutes: IDLE_TIMEOUT_MS / 60_000 });
				await this.flushStandalone("idle", true);
			} else if (this.counting) {
				this.accrue(now);
				if (this.qualified && now - this.lastPersistedAt >= CHECKPOINT_MS) {
					await this.flushStandalone("checkpoint", false);
				}
			}
		} finally {
			this.tickRunning = false;
		}
	}

	private resume(now: number, reason: string): void {
		this.counting = true;
		this.activeSince = now;
		if (this.dayStartPercent === null) {
			this.dayStartPercent = this.currentPercent;
		}
		this.log("resumed", { reason });
	}

	private accrue(until: number): void {
		if (!this.counting || this.activeSince <= 0 || until <= this.activeSince) {
			return;
		}
		const elapsed = until - this.activeSince;
		this.pendingMs += elapsed;
		this.openActiveMs += elapsed;
		this.lastActiveAt = until;
		this.activeSince = until;
	}

	private async ensureView(noteFile: TFile): Promise<void> {
		if (this.viewEnsured) {
			return;
		}
		const content = await this.app.vault.cachedRead(noteFile);
		if (content.includes(VIEW_SIGNATURE)) {
			this.viewEnsured = true;
			return;
		}
		await this.storage.mutateContent(noteFile, (current) => {
			if (current.includes(VIEW_SIGNATURE)) {
				return current;
			}
			// Replace an old-version Reading History section entirely, or
			// insert a new one if no section exists yet.
			const heading = /^## Reading History\s*$/m.exec(current);
			if (heading && heading.index !== undefined) {
				const afterHeading = current.slice(heading.index);
				// Match from the heading to the next ## heading or end of note.
				const nextSection = /^## (?!Reading History)/m.exec(afterHeading);
				const sectionEnd = nextSection && nextSection.index !== undefined
					? heading.index + nextSection.index
					: current.length;
				const before = current.slice(0, heading.index);
				const after = current.slice(sectionEnd);
				return `${before}## Reading History\n\n${VIEW_BLOCK}\n${after}`;
			} else {
				return `${current.trimEnd()}\n\n## Reading History\n\n${VIEW_BLOCK}\n`;
			}
		});
		this.viewEnsured = true;
		this.log("Dataview installed", { note: noteFile.path });
	}

	// Reset for a same-book reload: clears the timer and ephemeral state but
	// leaves openActiveMs/qualified/pendingMs untouched (they were captured
	// by suspendForReload and will be restored by start()).
	resetForReload(): void {
		if (this.tickTimer !== null) {
			window.clearInterval(this.tickTimer);
		}
		this.tickTimer = null;
		this.tickRunning = false;
		this.epubFile = null;
		this.notePromise = Promise.resolve(null);
		this.currentPercent = null;
		this.day = "";
		this.dayStartPercent = null;
		this.environmentActive = false;
		this.counting = false;
		this.activeSince = 0;
		this.lastInteractionAt = 0;
		this.lastActiveAt = 0;
		this.openActiveMs = 0;
		this.pendingMs = 0;
		this.lastPersistedAt = 0;
		this.qualified = false;
		this.mutationInFlight = false;
		this.viewEnsured = false;
	}

	private reset(): void {
		if (this.tickTimer !== null) {
			window.clearInterval(this.tickTimer);
		}
		this.epubFile = null;
		this.notePromise = Promise.resolve(null);
		this.currentPercent = null;
		this.day = "";
		this.dayStartPercent = null;
		this.environmentActive = false;
		this.counting = false;
		this.activeSince = 0;
		this.lastInteractionAt = 0;
		this.lastActiveAt = 0;
		this.openActiveMs = 0;
		this.pendingMs = 0;
		this.lastPersistedAt = 0;
		this.qualified = false;
		this.mutationInFlight = false;
		this.viewEnsured = false;
		this.tickTimer = null;
		this.tickRunning = false;
	}

	private log(event: string, details: Record<string, unknown>): void {
		console.info(`[Tome reading history] ${event}`, details);
	}
}
