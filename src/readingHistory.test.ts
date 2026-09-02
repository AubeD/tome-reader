// Lightweight self-contained test harness for the pure reading-history logic.
// Run with: npx tsx src/readingHistory.test.ts
// No external test framework required — keeps the project dependency-free.

import { ReadingHistoryTracker } from "./readingHistory";
import { BookNoteStorage } from "./bookNoteStorage";

interface Assertion {
	name: string;
	pass: boolean;
	details?: string;
}

const results: Assertion[] = [];

function assert(name: string, condition: boolean, details?: string): void {
	results.push({ name, pass: condition, details });
	if (condition) {
		console.log(`  ✓ ${name}`);
	} else {
		console.error(`  ✗ ${name}${details ? " — " + details : ""}`);
	}
}

// ─── Mock infrastructure ────────────────────────────────────────────────────

interface CapturedFrontmatter {
	reading_history?: Array<{
		date: string;
		start_percent: number;
		end_percent: number;
		duration_seconds: number;
	}>;
	reading_time_seconds?: number;
	last_read?: string;
}

function createMockStorage(initialFrontmatter: CapturedFrontmatter = {}) {
	let frontmatter: Record<string, unknown> = { ...initialFrontmatter };
	let content = "";
	const note = { path: "test/book.md" } as never;
	const mutations: Array<{ type: string; snapshot: CapturedFrontmatter }> = [];
	const storage = {
		resolveNote: async () => note,
		mutateFrontmatter: async (_note: unknown, mutator: (fm: Record<string, unknown>) => void) => {
			mutator(frontmatter);
			mutations.push({ type: "frontmatter", snapshot: snapshot(frontmatter) });
		},
		mutateContent: async (_note: unknown, mutator: (c: string) => string) => {
			content = mutator(content);
			mutations.push({ type: "content", snapshot: snapshot(frontmatter) });
		},
		_getFrontmatter: () => frontmatter,
		_getContent: () => content,
		_getMutations: () => mutations,
	} as unknown as BookNoteStorage;

	function snapshot(fm: Record<string, unknown>): CapturedFrontmatter {
		return {
			reading_history: fm.reading_history as CapturedFrontmatter["reading_history"],
			reading_time_seconds: fm.reading_time_seconds as number | undefined,
			last_read: fm.last_read as string | undefined,
		};
	}

	return storage;
}

function createTracker(storage: BookNoteStorage): ReadingHistoryTracker {
	const mockStorage = storage as unknown as { _getContent: () => string };
	const app = {
		vault: {
			cachedRead: async () => mockStorage._getContent(),
		},
	} as unknown as never;
	const tracker = new ReadingHistoryTracker(app, storage);
	// Set epubFile so prepareMutation doesn't bail out early
	const internal = tracker as unknown as { epubFile: unknown };
	internal.epubFile = { path: "test/book.md" };
	return tracker;
}

function extractMutation(tracker: ReadingHistoryTracker, reason: string, force = false) {
	return (tracker as unknown as {
		prepareMutation: (reason: string, force?: boolean) => {
			apply: (fm: Record<string, unknown>) => void;
			commit: (note: unknown) => Promise<void>;
			rollback: () => void;
		} | null;
	}).prepareMutation(reason, force);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

function setInternalState(tracker: ReadingHistoryTracker, state: {
	day: string;
	dayStartPercent: number;
	currentPercent: number;
	pendingMs: number;
	qualified: boolean;
	openActiveMs: number;
}): void {
	const internal = tracker as unknown as Record<string, unknown>;
	internal["day"] = state.day;
	internal["dayStartPercent"] = state.dayStartPercent;
	internal["currentPercent"] = state.currentPercent;
	internal["pendingMs"] = state.pendingMs;
	internal["qualified"] = state.qualified;
	internal["openActiveMs"] = state.openActiveMs;
	internal["mutationInFlight"] = false;
	internal["lastActiveAt"] = Date.now();
}

function testParseHistoryValid(): void {
	console.log("\n[Test] parseHistory accepts valid entries");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-08-29",
		dayStartPercent: 12.3,
		currentPercent: 38.5,
		pendingMs: 120_000,
		qualified: true,
		openActiveMs: 120_000,
	});
	const mutation = extractMutation(tracker, "test", true);
	assert("mutation created", mutation !== null);
	if (mutation) {
		const fm: Record<string, unknown> = {
			reading_history: [
				{ date: "2026-08-28", start_percent: 0, end_percent: 12.3, duration_seconds: 3120 },
			],
		};
		// Should not throw
		mutation.apply(fm);
		const history = fm.reading_history as Array<{ date: string }>;
		assert("history has entries", Array.isArray(history) && history.length >= 1);
	}
}

function testParseHistoryRejectsInvalid(): void {
	console.log("\n[Test] parseHistory rejects invalid entries");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-08-29",
		dayStartPercent: 0,
		currentPercent: 10,
		pendingMs: 120_000,
		qualified: true,
		openActiveMs: 120_000,
	});
	const mutation = extractMutation(tracker, "test", true);
	assert("mutation created", mutation !== null);
	if (mutation) {
		const fm: Record<string, unknown> = {
			reading_history: [{ date: "invalid", start_percent: 0, end_percent: 10, duration_seconds: 60 }],
		};
		let threw = false;
		try {
			mutation.apply(fm);
		} catch {
			threw = true;
		}
		assert("invalid date throws", threw);
	}
}

function testSameDayAggregation(): void {
	console.log("\n[Test] same-day aggregation extends existing entry");
	const storage = createMockStorage({
		reading_history: [
			{ date: "2026-08-29", start_percent: 12.3, end_percent: 25.0, duration_seconds: 1800 },
		],
	});
	const tracker = createTracker(storage);
	// Simulate: tracker has 30min pending, current percent 38.5, day is 2026-08-29
	// We'll directly test the mutation logic by setting internal state
	const internal = tracker as unknown as {
		day: string;
		dayStartPercent: number | null;
		currentPercent: number | null;
		pendingMs: number;
		qualified: boolean;
		openActiveMs: number;
		mutationInFlight: boolean;
		lastActiveAt: number;
	};
	internal.day = "2026-08-29";
	internal.dayStartPercent = 12.3;
	internal.currentPercent = 38.5;
	internal.pendingMs = 1800_000; // 30 min
	internal.qualified = true;
	internal.openActiveMs = 1800_000;
	internal.mutationInFlight = false;
	internal.lastActiveAt = Date.now();

	const mutation = extractMutation(tracker, "test", true);
	assert("mutation created for same day", mutation !== null);
	if (mutation) {
		const fm: Record<string, unknown> = {
			reading_history: [
				{ date: "2026-08-29", start_percent: 12.3, end_percent: 25.0, duration_seconds: 1800 },
			],
		};
		mutation.apply(fm);
		const history = fm.reading_history as Array<{
			date: string;
			start_percent: number;
			end_percent: number;
			duration_seconds: number;
		}>;
		assert("still one entry for the day", history.length === 1);
		assert("start preserved", history[0].start_percent === 12.3);
		assert("end updated", history[0].end_percent === 38.5);
		assert("duration accumulated", history[0].duration_seconds === 3600);
		assert("total time updated", fm.reading_time_seconds === 3600);
		assert("last_read set", typeof fm.last_read === "string" && (fm.last_read as string).length > 0);
	}
}

function testNewDayCreatesEntry(): void {
	console.log("\n[Test] new day creates a new entry");
	const storage = createMockStorage({
		reading_history: [
			{ date: "2026-08-28", start_percent: 0, end_percent: 12.3, duration_seconds: 3120 },
		],
		reading_time_seconds: 3120,
	});
	const tracker = createTracker(storage);
	const internal = tracker as unknown as {
		day: string;
		dayStartPercent: number | null;
		currentPercent: number | null;
		pendingMs: number;
		qualified: boolean;
		openActiveMs: number;
		mutationInFlight: boolean;
		lastActiveAt: number;
	};
	internal.day = "2026-08-29";
	internal.dayStartPercent = 12.3;
	internal.currentPercent = 38.5;
	internal.pendingMs = 4020_000;
	internal.qualified = true;
	internal.openActiveMs = 4020_000;
	internal.mutationInFlight = false;
	internal.lastActiveAt = Date.now();

	const mutation = extractMutation(tracker, "test", true);
	assert("mutation created for new day", mutation !== null);
	if (mutation) {
		const fm: Record<string, unknown> = {
			reading_history: [
				{ date: "2026-08-28", start_percent: 0, end_percent: 12.3, duration_seconds: 3120 },
			],
		};
		mutation.apply(fm);
		const history = fm.reading_history as Array<{ date: string }>;
		assert("two entries after new day", history.length === 2);
		assert("entries sorted chronologically", history[0].date === "2026-08-28" && history[1].date === "2026-08-29");
		assert("total time is sum", fm.reading_time_seconds === 3120 + 4020);
	}
}

function testMinimumSessionNotQualified(): void {
	console.log("\n[Test] sub-60s session does not produce a mutation");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	const internal = tracker as unknown as {
		day: string;
		dayStartPercent: number | null;
		currentPercent: number | null;
		pendingMs: number;
		qualified: boolean;
		openActiveMs: number;
		mutationInFlight: boolean;
	};
	internal.day = "2026-08-29";
	internal.dayStartPercent = 0;
	internal.currentPercent = 5.0;
	internal.pendingMs = 30_000; // 30 seconds
	internal.qualified = false; // hasn't reached 60s
	internal.openActiveMs = 30_000;
	internal.mutationInFlight = false;

	const mutation = extractMutation(tracker, "test", true);
	assert("no mutation for sub-60s session", mutation === null);
}

function testPercentClamping(): void {
	console.log("\n[Test] percent values are clamped to [0, 100]");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-08-29",
		dayStartPercent: -5,
		currentPercent: 150,
		pendingMs: 120_000,
		qualified: true,
		openActiveMs: 120_000,
	});

	const mutation = extractMutation(tracker, "test", true);
	assert("mutation created", mutation !== null);
	if (mutation) {
		const fm: Record<string, unknown> = {};
		mutation.apply(fm);
		const history = fm.reading_history as Array<{
			start_percent: number;
			end_percent: number;
		}>;
		assert("start clamped to 0", history[0].start_percent === 0);
		assert("end clamped to 100", history[0].end_percent === 100);
	}
}

function testDataviewBlockInstallation(): void {
	console.log("\n[Test] DataviewJS block is installed when missing");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	const internal = tracker as unknown as {
		viewEnsured: boolean;
	};
	internal.viewEnsured = false;
	// Trigger ensureView via commit
	const internalFull = tracker as unknown as {
		day: string;
		dayStartPercent: number | null;
		currentPercent: number | null;
		pendingMs: number;
		qualified: boolean;
		openActiveMs: number;
		mutationInFlight: boolean;
		lastActiveAt: number;
		ensureView: (note: unknown) => Promise<void>;
	};
	internalFull.day = "2026-08-29";
	internalFull.dayStartPercent = 0;
	internalFull.currentPercent = 10;
	internalFull.pendingMs = 120_000;
	internalFull.qualified = true;
	internalFull.openActiveMs = 120_000;
	internalFull.mutationInFlight = false;
	internalFull.lastActiveAt = Date.now();

	// ensureView is private; call it directly
	void internalFull.ensureView({ path: "test/book.md" }).then(() => {
		const mockStorage = storage as unknown as { _getContent: () => string };
		const content = mockStorage._getContent();
		assert("content has Reading History heading", content.includes("## Reading History"));
		assert("content has dataviewjs block", content.includes("```dataviewjs"));
		assert("content has total time line", content.includes("Total reading time"));
		assert("viewEnsured flag set", internal.viewEnsured === true);
	});
}

function testDurationFormatting(): void {
	console.log("\n[Test] duration formatting (42min and 5h 07min)");
	// The formatting lives inside the DataviewJS block string, not in TS.
	// We verify the block contains the correct template logic.
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	const internal = tracker as unknown as {
		viewEnsured: boolean;
		ensureView: (note: unknown) => Promise<void>;
	};
	internal.viewEnsured = false;
	void internal.ensureView({ path: "test/book.md" }).then(() => {
		const mockStorage = storage as unknown as { _getContent: () => string };
		const content = mockStorage._getContent();
		assert("uses hours format for >= 1h", content.includes("h "));
		assert("uses min format for < 1h", content.includes("min"));
		assert("pads minutes to 2 digits", content.includes('padStart(2, "0")'));
	});
}

// ─── Session tests ──────────────────────────────────────────────────────────

function testSessionAutoStart(): void {
	console.log("\n[Test] auto-start creates a session when threshold met");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-09-02",
		dayStartPercent: 0,
		currentPercent: 15.0,
		pendingMs: 200_000, // 200s > 150s startThreshold
		qualified: true,
		openActiveMs: 200_000,
	});
	const mutation = extractMutation(tracker, "test", true);
	assert("mutation created", mutation !== null);
	if (mutation) {
		const fm: Record<string, unknown> = {
			word_count: 80000, // normal book → finishThreshold=300, startThreshold=150
		};
		mutation.apply(fm);
		const sessions = fm.reading_sessions as Array<{ started: string; finished: string }>;
		assert("session created", Array.isArray(sessions) && sessions.length === 1);
		assert("session started today", sessions && sessions[0]?.started === "2026-09-02");
		assert("session in progress", sessions && sessions[0]?.finished === "");
		assert("status watching", fm.status === "watching");
		assert("started mirrored", fm.started === "2026-09-02");
		assert("finished mirrored", fm.finished === "");
	}
}

function testSessionAutoStartBackdating(): void {
	console.log("\n[Test] auto-start backdates to contiguous prior day");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-09-02",
		dayStartPercent: 0,
		currentPercent: 15.0,
		pendingMs: 200_000,
		qualified: true,
		openActiveMs: 200_000,
	});
	const mutation = extractMutation(tracker, "test", true);
	if (mutation) {
		const fm: Record<string, unknown> = {
			word_count: 80000,
			reading_history: [
				{ date: "2026-09-01", start_percent: 0, end_percent: 5.0, duration_seconds: 240 }, // 4min yesterday
			],
		};
		mutation.apply(fm);
		const sessions = fm.reading_sessions as Array<{ started: string; finished: string }>;
		assert("session created", Array.isArray(sessions) && sessions.length === 1);
		assert("started backdated to yesterday", sessions && sessions[0]?.started === "2026-09-01");
	}
}

function testSessionAutoStartNoBackdate(): void {
	console.log("\n[Test] auto-start does not backdate across large gap");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-09-02",
		dayStartPercent: 0,
		currentPercent: 15.0,
		pendingMs: 200_000,
		qualified: true,
		openActiveMs: 200_000,
	});
	const mutation = extractMutation(tracker, "test", true);
	if (mutation) {
		const fm: Record<string, unknown> = {
			word_count: 80000,
			reading_history: [
				{ date: "2026-08-01", start_percent: 0, end_percent: 5.0, duration_seconds: 240 }, // 30 days ago
			],
		};
		mutation.apply(fm);
		const sessions = fm.reading_sessions as Array<{ started: string; finished: string }>;
		assert("session created", Array.isArray(sessions) && sessions.length === 1);
		assert("started is today (no backdate)", sessions && sessions[0]?.started === "2026-09-02");
	}
}

function testSessionAutoStartBlockedByTime(): void {
	console.log("\n[Test] auto-start blocked when today's time below threshold");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-09-02",
		dayStartPercent: 0,
		currentPercent: 15.0,
		pendingMs: 60_000, // 60s < 150s startThreshold
		qualified: true,
		openActiveMs: 60_000,
	});
	const mutation = extractMutation(tracker, "test", true);
	if (mutation) {
		const fm: Record<string, unknown> = { word_count: 80000 };
		mutation.apply(fm);
		const sessions = fm.reading_sessions as Array<{ started: string; finished: string }> | undefined;
		assert("no session created", !sessions || sessions.length === 0);
	}
}

function testSessionAutoStartBlockedByInProgress(): void {
	console.log("\n[Test] auto-start blocked when in-progress session exists");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-09-02",
		dayStartPercent: 0,
		currentPercent: 15.0,
		pendingMs: 200_000,
		qualified: true,
		openActiveMs: 200_000,
	});
	const mutation = extractMutation(tracker, "test", true);
	if (mutation) {
		const fm: Record<string, unknown> = {
			word_count: 80000,
			reading_sessions: [{ started: "2026-08-22", finished: "" }],
		};
		mutation.apply(fm);
		const sessions = fm.reading_sessions as Array<{ started: string; finished: string }>;
		assert("still one session", sessions && sessions.length === 1);
		assert("existing session preserved", sessions && sessions[0]?.started === "2026-08-22");
	}
}

function testSessionAutoStartBlockedByFinishedToday(): void {
	console.log("\n[Test] auto-start blocked when a session finished today (anti-spurious)");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-09-02",
		dayStartPercent: 0,
		currentPercent: 15.0,
		pendingMs: 200_000,
		qualified: true,
		openActiveMs: 200_000,
	});
	const mutation = extractMutation(tracker, "test", true);
	if (mutation) {
		const fm: Record<string, unknown> = {
			word_count: 80000,
			reading_sessions: [{ started: "2026-01-01", finished: "2026-09-02" }],
		};
		mutation.apply(fm);
		const sessions = fm.reading_sessions as Array<{ started: string; finished: string }>;
		assert("still one session", sessions && sessions.length === 1);
		assert("no new session started", sessions && sessions[0]?.started === "2026-01-01");
	}
}

function testSessionAutoFinish(): void {
	console.log("\n[Test] auto-finish closes session when threshold met");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-09-02",
		dayStartPercent: 99.6,
		currentPercent: 99.6,
		pendingMs: 200_000,
		qualified: true,
		openActiveMs: 200_000,
	});
	const mutation = extractMutation(tracker, "test", true);
	if (mutation) {
		const fm: Record<string, unknown> = {
			word_count: 80000,
			reading_sessions: [{ started: "2026-08-22", finished: "" }],
			reading_history: [
				{ date: "2026-08-22", start_percent: 0, end_percent: 50.0, duration_seconds: 200 },
				{ date: "2026-09-02", start_percent: 50.0, end_percent: 99.6, duration_seconds: 200 },
			],
		};
		mutation.apply(fm);
		const sessions = fm.reading_sessions as Array<{ started: string; finished: string }>;
		assert("session closed", sessions && sessions[0]?.finished === "2026-09-02");
		assert("status completed", fm.status === "completed");
		assert("finished mirrored", fm.finished === "2026-09-02");
	}
}

function testSessionAutoFinishWithBackdatedStart(): void {
	console.log("\n[Test] auto-finish includes time from backdated start days");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-09-02",
		dayStartPercent: 99.6,
		currentPercent: 99.6,
		pendingMs: 200_000,
		qualified: true,
		openActiveMs: 200_000,
	});
	const mutation = extractMutation(tracker, "test", true);
	if (mutation) {
		const fm: Record<string, unknown> = {
			word_count: 80000,
			reading_sessions: [{ started: "2026-09-01", finished: "" }], // started yesterday
			reading_history: [
				{ date: "2026-09-01", start_percent: 0, end_percent: 50.0, duration_seconds: 200 }, // yesterday's 200s
				{ date: "2026-09-02", start_percent: 50.0, end_percent: 99.6, duration_seconds: 200 }, // today's 200s (pre-flush)
			],
		};
		mutation.apply(fm);
		// sessionActiveSeconds = 200 (yesterday) + 200 (today pre-flush) + 200 (this flush) = 600 >= 300
		const sessions = fm.reading_sessions as Array<{ started: string; finished: string }>;
		assert("session closed", sessions && sessions[0]?.finished === "2026-09-02");
	}
}

function testSessionAutoFinishBlockedByTime(): void {
	console.log("\n[Test] auto-finish blocked when session time below threshold");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-09-02",
		dayStartPercent: 99.6,
		currentPercent: 99.6,
		pendingMs: 60_000, // 60s
		qualified: true,
		openActiveMs: 60_000,
	});
	const mutation = extractMutation(tracker, "test", true);
	if (mutation) {
		const fm: Record<string, unknown> = {
			word_count: 80000, // finishThreshold = 300
			reading_sessions: [{ started: "2026-09-02", finished: "" }],
		};
		mutation.apply(fm);
		// sessionActiveSeconds = 60 (today's flush only) < 300
		const sessions = fm.reading_sessions as Array<{ started: string; finished: string }>;
		assert("session not closed", sessions && sessions[0]?.finished === "");
		assert("status still watching", fm.status === "watching");
	}
}

function testSessionShortBookThreshold(): void {
	console.log("\n[Test] short book uses scaled-down threshold");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-09-02",
		dayStartPercent: 99.6,
		currentPercent: 99.6,
		pendingMs: 120_000, // 120s
		qualified: true,
		openActiveMs: 120_000,
	});
	const mutation = extractMutation(tracker, "test", true);
	if (mutation) {
		const fm: Record<string, unknown> = {
			word_count: 700, // 700 words → 700/350*60 = 120s → finishThreshold = min(300, 120) = 120
			reading_sessions: [{ started: "2026-09-02", finished: "" }],
		};
		mutation.apply(fm);
		// sessionActiveSeconds = 120 (today's flush) >= 120 (finishThreshold)
		const sessions = fm.reading_sessions as Array<{ started: string; finished: string }>;
		assert("short book finished", sessions && sessions[0]?.finished === "2026-09-02");
	}
}

function testSessionFallbackNoWordCount(): void {
	console.log("\n[Test] fallback to flat threshold when no word_count or page_total");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-09-02",
		dayStartPercent: 0,
		currentPercent: 15.0,
		pendingMs: 160_000, // 160s > 150s flat startThreshold
		qualified: true,
		openActiveMs: 160_000,
	});
	const mutation = extractMutation(tracker, "test", true);
	if (mutation) {
		const fm: Record<string, unknown> = {}; // no word_count, no page_total
		mutation.apply(fm);
		// finishThreshold = min(300, Infinity) = 300, startThreshold = 150
		const sessions = fm.reading_sessions as Array<{ started: string; finished: string }>;
		assert("session created with flat threshold", Array.isArray(sessions) && sessions.length === 1);
	}
}

function testSessionMirrorConsistency(): void {
	console.log("\n[Test] mirror fields recomputed from hand-edited sessions");
	const storage = createMockStorage();
	const tracker = createTracker(storage);
	setInternalState(tracker, {
		day: "2026-09-02",
		dayStartPercent: 50.0,
		currentPercent: 55.0,
		pendingMs: 60_000, // 60s < 150s startThreshold → no auto-start
		qualified: true,
		openActiveMs: 60_000,
	});
	const mutation = extractMutation(tracker, "test", true);
	if (mutation) {
		const fm: Record<string, unknown> = {
			word_count: 80000,
			// Hand-edited: two finished sessions, no in-progress
			reading_sessions: [
				{ started: "2026-01-01", finished: "2026-02-15" },
				{ started: "2026-03-01", finished: "2026-04-01" },
			],
		};
		mutation.apply(fm);
		const sessions = fm.reading_sessions as Array<{ started: string; finished: string }>;
		assert("sessions unchanged", sessions && sessions.length === 2);
		assert("status completed (all finished)", fm.status === "completed");
		assert("started mirrors latest", fm.started === "2026-03-01");
		assert("finished mirrors latest", fm.finished === "2026-04-01");
	}
}

// ─── Run all tests ──────────────────────────────────────────────────────────

async function runAll(): Promise<void> {
	console.log("=== Tome Reading History Tests ===\n");

	testParseHistoryValid();
	testParseHistoryRejectsInvalid();
	testSameDayAggregation();
	testNewDayCreatesEntry();
	testMinimumSessionNotQualified();
	testPercentClamping();
	await testDataviewBlockInstallation();
	await testDurationFormatting();

	// Session tests
	testSessionAutoStart();
	testSessionAutoStartBackdating();
	testSessionAutoStartNoBackdate();
	testSessionAutoStartBlockedByTime();
	testSessionAutoStartBlockedByInProgress();
	testSessionAutoStartBlockedByFinishedToday();
	testSessionAutoFinish();
	testSessionAutoFinishWithBackdatedStart();
	testSessionAutoFinishBlockedByTime();
	testSessionShortBookThreshold();
	testSessionFallbackNoWordCount();
	testSessionMirrorConsistency();

	const passed = results.filter((r) => r.pass).length;
	const failed = results.filter((r) => !r.pass).length;
	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
	if (failed > 0) {
		process.exit(1);
	}
}

void runAll();
