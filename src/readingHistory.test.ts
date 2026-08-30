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

	const passed = results.filter((r) => r.pass).length;
	const failed = results.filter((r) => !r.pass).length;
	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
	if (failed > 0) {
		process.exit(1);
	}
}

void runAll();
