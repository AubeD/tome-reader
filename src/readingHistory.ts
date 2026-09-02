import { App, TFile } from "obsidian";
import { BookNoteStorage } from "./bookNoteStorage";

const MINIMUM_SESSION_MS = 60_000;
const CHECKPOINT_MS = 60_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;
const TICK_MS = 1_000;
// Session auto-start/finish thresholds.
// FINISH_THRESHOLD_SECONDS is the only time-threshold knob: startThreshold is
// derived as finishThreshold / 2 at runtime, so the /2 relationship holds for
// every wordCount (short books scale both thresholds together).
const FINISH_PERCENT = 99.5;
const FINISH_THRESHOLD_SECONDS = 300;
const CONTIGUOUS_GAP_DAYS = 7;
const PAUSED_STALE_DAYS = 14;
const WORDS_PER_MINUTE = 350;
const CHARS_PER_PAGE_FALLBACK = 2000;
const WORDS_PER_PAGE_FALLBACK = 400;
const VIEW_SIGNATURE = "/* tome-reading-history-v9 */";
const VIEW_BLOCK = `\`\`\`dataviewjs
${VIEW_SIGNATURE}
const history = dv.current().reading_history ?? [];
const sessions = dv.current().reading_sessions ?? [];
const totalSeconds = dv.current().reading_time_seconds ?? 0;
const today = new Date().toISOString().slice(0, 10);

// Normalize Dataview date values (JS Date or string) to YYYY-MM-DD string.
function dateStr(v) {
    if (!v) return "";
    if (v instanceof Date) {
        return v.toISOString().slice(0, 10);
    }
    const s = String(v);
    if (/^\\d{4}-\\d{2}-\\d{2}/.test(s)) return s.slice(0, 10);
    return s;
}

// Format YYYY-MM-DD as DD-MM-YYYY for display.
function fmtDate(v) {
    const s = dateStr(v);
    if (!s) return "";
    const parts = s.split("-");
    if (parts.length !== 3) return s;
    return parts[2] + "-" + parts[1] + "-" + parts[0];
}

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

function dayCount(started, finished) {
    const a = new Date(dateStr(started) + "T00:00:00Z");
    const b = new Date((dateStr(finished) || today) + "T00:00:00Z");
    return Math.round((b - a) / 86400000) + 1;
}

function pct(v) {
    return Number(v).toFixed(1) + "%";
}

// Normalize all dates in history and sessions to strings.
const normHistory = history.map(d => ({ ...d, date: dateStr(d.date) }));
const normSessions = sessions.map(s => ({ started: dateStr(s.started), finished: dateStr(s.finished) }));

// Group days into sessions and "Other reading".
const sortedSessions = [...normSessions].sort((a, b) => b.started.localeCompare(a.started));
const sortedHistory = [...normHistory].sort((a, b) => a.date.localeCompare(b.date));

// Assign each day to a session (first match: session.started <= day <= session.finished||today).
function findSession(day) {
    for (const s of normSessions) {
        const end = s.finished || today;
        if (day.date >= s.started && day.date <= end) return s;
    }
    return null;
}

const sessionDays = new Map();
const otherDays = [];
for (const day of sortedHistory) {
    const s = findSession(day);
    if (s) {
        const key = s.started + "|" + s.finished;
        if (!sessionDays.has(key)) sessionDays.set(key, []);
        sessionDays.get(key).push(day);
    } else {
        otherDays.push(day);
    }
}

// Container styled like the scan plugin's banner.
const wrap = dv.container.createEl("div", { cls: "tome-reading-history" });

// Total reading time bar.
wrap.createEl("div", { cls: "tome-rh-total", text: \`Total reading time: ${"${duration(totalSeconds)}"}\` });

// Helper: build a styled table inside a parent element.
function buildTable(parent, days) {
    const table = parent.createEl("table", { cls: "tome-rh-table" });
    const thead = table.createEl("thead");
    const headRow = thead.createEl("tr");
    ["Date", "Start", "End", "Duration"].forEach(h => headRow.createEl("th", { text: h }));
    const tbody = table.createEl("tbody");
    for (const d of days) {
        const tr = tbody.createEl("tr");
        tr.createEl("td", { text: fmtDate(d.date) });
        tr.createEl("td", { text: pct(d.start_percent) });
        tr.createEl("td", { text: pct(d.end_percent) });
        tr.createEl("td", { text: duration(d.duration_seconds) });
    }
}

// Render each session as a styled collapsible <details>.
let sessionNum = sortedSessions.length;
for (const s of sortedSessions) {
    const key = s.started + "|" + s.finished;
    const days = sessionDays.get(key) || [];
    const totalSecs = days.reduce((sum, d) => sum + d.duration_seconds, 0);
    const dayCountVal = dayCount(s.started, s.finished);
    const startPct = days.length > 0 ? days[0].start_percent : 0;
    const endPct = days.length > 0 ? days[days.length - 1].end_percent : 0;
    const isInProgress = !s.finished;
    const badgeCls = isInProgress ? "tome-rh-badge-progress" : "tome-rh-badge-completed";
    const badgeText = isInProgress ? "In progress" : "Completed";
    const details = wrap.createEl("details", { cls: "tome-rh-session" });
    if (isInProgress) { details.open = true; }
    const summary = details.createEl("summary");
    const badge = summary.createEl("span", { cls: \`tome-rh-badge ${"${badgeCls}"}\`, text: badgeText });
    summary.appendText(\` Session ${"${sessionNum}"} \u2014 ${"${fmtDate(s.started)}"}\`);
    if (!isInProgress) {
        summary.appendText(\` \u2192 ${"${fmtDate(s.finished)}"}\`);
    }
    summary.appendText(\` (${"${dayCountVal}"}d, ${"${duration(totalSecs)}"}, ${"${pct(startPct)}"} \u2192 ${"${pct(endPct)}"})\`);
    buildTable(details, days.slice().reverse());
    sessionNum--;
}

// Render "Other reading" if there are ungrouped days.
if (otherDays.length > 0) {
    const otherSecs = otherDays.reduce((sum, d) => sum + d.duration_seconds, 0);
    const details = wrap.createEl("details", { cls: "tome-rh-session" });
    const summary = details.createEl("summary");
    summary.createEl("span", { cls: "tome-rh-badge tome-rh-badge-other", text: "Other" });
    summary.appendText(\` Other reading (${"${otherDays.length}"}d, ${"${duration(otherSecs)}"})\`);
    buildTable(details, otherDays.slice().reverse());
}
\`\`\``;

interface ReadingDay {
	date: string;
	start_percent: number;
	end_percent: number;
	duration_seconds: number;
}

interface ReadingSession {
	started: string;
	finished: string; // "" = in progress
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

function parseSessions(value: unknown): ReadingSession[] {
	if (value === undefined || value === null) {
		return [];
	} else if (!Array.isArray(value)) {
		throw new Error("reading_sessions is not an array");
	}
	const sessions: ReadingSession[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error("reading_sessions contains a non-object entry");
		}
		const entry = raw as Record<string, unknown>;
		const started = typeof entry.started === "string" ? entry.started.trim() : "";
		const finishedRaw = entry.finished;
		const finished = finishedRaw === null || finishedRaw === undefined
			? ""
			: typeof finishedRaw === "string" ? finishedRaw.trim() : "";
		if (!/^\d{4}-\d{2}-\d{2}$/.test(started)) {
			throw new Error(`reading_sessions contains an invalid started date "${started || "unknown"}"`);
		}
		if (finished !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(finished)) {
			throw new Error(`reading_sessions contains an invalid finished date "${finished}"`);
		}
		sessions.push({ started, finished });
	}
	return sessions;
}

// Sum duration_seconds over reading_history entries within [started, finishedOrToday].
function sumSessionSeconds(history: ReadingDay[], started: string, finishedOrToday: string): number {
	let total = 0;
	for (const entry of history) {
		if (entry.date >= started && entry.date <= finishedOrToday) {
			total += entry.duration_seconds;
		}
	}
	return total;
}

// Return today's duration_seconds from reading_history (0 if no entry yet).
function todaySeconds(history: ReadingDay[], today: string): number {
	const entry = history.find((e) => e.date === today);
	return entry ? entry.duration_seconds : 0;
}

// Walk back from today through reading_history entries with gaps <= maxGapDays.
// Returns the earliest date in the contiguous run ending at today.
// If today has no entry yet, returns today (the run will include it once written).
function earliestContiguousStart(history: ReadingDay[], today: string, maxGapDays: number): string {
	const dates = history.map((e) => e.date).sort((a, b) => a.localeCompare(b));
	if (dates.length === 0) {
		return today;
	}
	// Build the contiguous run ending at today.
	const run: string[] = [];
	let prev: string | null = null;
	for (const date of dates) {
		if (prev === null) {
			run.push(date);
		} else {
			const gap = daysBetween(prev, date);
			if (gap <= maxGapDays) {
				run.push(date);
			} else {
				// Gap too large — start a new run.
				run.length = 0;
				run.push(date);
			}
		}
		prev = date;
	}
	// Check if the last run includes today (or is contiguous with today).
	if (run.length === 0) {
		return today;
	}
	const lastInRun = run[run.length - 1];
	if (lastInRun === today) {
		return run[0];
	}
	// If the last entry is within maxGapDays of today, extend the run.
	const gapToToday = daysBetween(lastInRun, today);
	if (gapToToday <= maxGapDays) {
		return run[0];
	}
	// No contiguous run reaching today — start fresh.
	return today;
}

// Calendar days between two YYYY-MM-DD strings (b - a, positive if b > a).
function daysBetween(a: string, b: string): number {
	const dateA = new Date(a + "T00:00:00Z");
	const dateB = new Date(b + "T00:00:00Z");
	return Math.round((dateB.getTime() - dateA.getTime()) / (24 * 60 * 60 * 1000));
}

// Resolve word count from frontmatter, falling back to page_total estimate.
function resolveWordCount(frontmatter: Record<string, unknown>): number {
	const explicit = asFiniteNumber(frontmatter.word_count);
	if (explicit !== null && explicit > 0) {
		return explicit;
	}
	const pageTotal = asFiniteNumber(frontmatter.page_total);
	if (pageTotal !== null && pageTotal > 0) {
		return pageTotal * WORDS_PER_PAGE_FALLBACK;
	}
	return 0;
}

// Compute finish and start thresholds from word count.
// finishThreshold = min(FINISH_THRESHOLD_SECONDS, wordCount / 350 * 60)
// startThreshold = finishThreshold / 2
// When wordCount is 0/unknown, wordCount/350*60 = 0, so min picks 0 — but we
// want the flat floor in that case. Treat 0 wordCount as +∞ so min picks the
// constant.
function computeThresholds(wordCount: number): { finishThreshold: number; startThreshold: number } {
	const wordBasedSeconds = wordCount > 0 ? (wordCount / WORDS_PER_MINUTE) * 60 : Infinity;
	const finishThreshold = Math.min(FINISH_THRESHOLD_SECONDS, wordBasedSeconds);
	const startThreshold = finishThreshold / 2;
	return { finishThreshold, startThreshold };
}

// Derive the mirrored status from reading_sessions.
// - planned: no sessions
// - watching: >=1 in-progress session (started, no finished)
// - completed: >=1 finished session AND no in-progress session
// (paused is set by obsidian-book-scan, not Tome — Tome only sets watching/completed/planned)
function deriveStatus(sessions: ReadingSession[]): string {
	if (sessions.length === 0) {
		return "planned";
	}
	const hasInProgress = sessions.some((s) => s.finished === "");
	const hasFinished = sessions.some((s) => s.finished !== "");
	if (hasInProgress) {
		return "watching";
	} else if (hasFinished) {
		return "completed";
	} else {
		return "planned";
	}
}

// Recompute the mirrored started/finished/status from reading_sessions.
// started/finished mirror the most recent session.
function recomputeMirror(frontmatter: Record<string, unknown>, sessions: ReadingSession[]): void {
	if (sessions.length === 0) {
		// Don't wipe existing started/finished if there are no sessions —
		// the user may have manual values. Only set status.
		frontmatter.status = "planned";
		return;
	}
	const latest = sessions[sessions.length - 1];
	frontmatter.started = latest.started;
	frontmatter.finished = latest.finished;
	frontmatter.status = deriveStatus(sessions);
}

// Build the session mutation: evaluates auto-start/finish and applies changes
// to frontmatter.reading_sessions + the mirrored started/finished/status.
// Must be called AFTER the per-day history mutation has updated
// frontmatter.reading_history, so today's duration_seconds is current.
function applySessionMutation(
	frontmatter: Record<string, unknown>,
	currentPercent: number | null,
	today: string
): void {
	const sessions = parseSessions(frontmatter.reading_sessions);
	const history = parseHistory(frontmatter.reading_history);
	const wordCount = resolveWordCount(frontmatter);
	const { finishThreshold, startThreshold } = computeThresholds(wordCount);

	// Always recompute the mirror from the (possibly hand-edited) sessions.
	recomputeMirror(frontmatter, sessions);

	// Auto-FINISH: check if the in-progress session should be closed.
	const inProgressIdx = sessions.findIndex((s) => s.finished === "");
	if (inProgressIdx >= 0) {
		const session = sessions[inProgressIdx];
		if (currentPercent !== null && currentPercent >= FINISH_PERCENT) {
			const sessionSeconds = sumSessionSeconds(history, session.started, today);
			if (sessionSeconds >= finishThreshold) {
				session.finished = today;
				frontmatter.reading_sessions = sessions;
				recomputeMirror(frontmatter, sessions);
				return;
			}
		}
		// Session in progress but not finished — no start needed.
		frontmatter.reading_sessions = sessions;
		return;
	}

	// Auto-START: no in-progress session. Check if we should start one.
	// Condition 1: sessions empty OR all finished (guaranteed by inProgressIdx < 0).
	// Condition 2: today's duration_seconds >= startThreshold.
	const todaySecs = todaySeconds(history, today);
	if (todaySecs < startThreshold) {
		frontmatter.reading_sessions = sessions;
		return;
	}
	// Condition 3: 0 < currentPercent < FINISH_PERCENT.
	if (currentPercent === null || currentPercent <= 0 || currentPercent >= FINISH_PERCENT) {
		frontmatter.reading_sessions = sessions;
		return;
	}
	// Condition 4: anti-spurious — no session finished today.
	const finishedToday = sessions.some((s) => s.finished === today);
	if (finishedToday) {
		frontmatter.reading_sessions = sessions;
		return;
	}
	// All conditions met — start a new session, backdating to the earliest
	// contiguous reading day.
	const backdatedStart = earliestContiguousStart(history, today, CONTIGUOUS_GAP_DAYS);
	sessions.push({ started: backdatedStart, finished: "" });
	sessions.sort((a, b) => a.started.localeCompare(b.started));
	frontmatter.reading_sessions = sessions;
	recomputeMirror(frontmatter, sessions);
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
		// Ensure the DataviewJS block is present/up-to-date on open, even if
		// no reading time accumulates (e.g. user opens and closes quickly).
		void this.notePromise.then((noteFile) => {
			if (noteFile) {
				void this.ensureView(noteFile);
			}
		});
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
				// Session auto-start/finish: runs AFTER the history mutation so
				// today's duration_seconds is current. Reads reading_sessions +
				// reading_history + word_count/page_total from frontmatter.
				applySessionMutation(frontmatter, this.currentPercent, snapshot.day);
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
				// Insert before the first ## heading (e.g. ## Notes), right after
			// the banner codeblock. If no ## heading exists, append at end.
			const firstHeading = /^## /m.exec(current);
			if (firstHeading && firstHeading.index !== undefined) {
				const before = current.slice(0, firstHeading.index);
				const after = current.slice(firstHeading.index);
				return `${before}## Reading History\n\n${VIEW_BLOCK}\n${after}`;
			} else {
				return `${current.trimEnd()}\n\n## Reading History\n\n${VIEW_BLOCK}\n`;
			}
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
