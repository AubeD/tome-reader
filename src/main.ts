import {
	App,
	ButtonComponent,
	FileView,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
	debounce,
	normalizePath,
	requestUrl,
} from "obsidian";
import ePub, { Book, EpubCFI, Rendition } from "epubjs";
import JSZip from "jszip";
import { LorebaseProgressSync } from "./progressSync";
import { BookNoteStorage, TomeBookmark } from "./bookNoteStorage";

const VIEW_TYPE_EPUB = "tome-epub-view";

type TomeTheme = "classic-light" | "classic-dark" | "parchment" | "gray-fog";

type Lang = "en" | "ru";

type ReadingMode = "paginated" | "scroll";

interface TocEntry {
	label: string;
	href: string;
	depth: number;
	cfi?: string; // построенные по заголовкам записи целятся точным CFI
	idx?: number; // индекс файла в спайне — для подсветки текущей главы
}

// Minimal shapes for the epub.js internals the reader relies on: the library
// leaves them untyped, and Tome needs precise page positions, spine access and
// rendered documents to place notes, bookmarks and chapter jumps.
interface EpubLocationEdge {
	cfi?: string;
	href?: string;
}

interface EpubLocation {
	start?: EpubLocationEdge;
	end?: EpubLocationEdge;
}

interface EpubSection {
	href?: string;
	index?: number;
	document?: Document;
	load?: (request?: unknown) => Promise<unknown>;
	unload?: () => void;
	cfiFromElement?: (el: Element) => string;
}

interface EpubContents {
	document?: Document;
	window?: Window;
	range?: (cfi: string) => Range | null;
	cfiFromNode?: (node: Node) => string;
}

interface EpubManager {
	container?: HTMLElement;
	layout?: { delta?: number };
	settings?: { direction?: string; gap?: number };
	scrollBy?: (x: number, y: number, silent?: boolean) => void;
	updateLayout?: () => void;
}

interface EpubRenditionInternals {
	manager?: EpubManager;
	hooks?: { content?: { register: (fn: (contents: EpubContents) => void) => void } };
	currentLocation?: () => EpubLocation | undefined;
	reportLocation?: () => void;
	resize?: (width: number, height: number) => void;
	getContents?: () => EpubContents[];
}

interface EpubBookInternals {
	spine?: { spineItems?: EpubSection[]; items?: EpubSection[] };
	load?: (path: string) => Promise<unknown>;
}

interface EpubNavItem {
	label?: string;
	href?: string;
	subitems?: EpubNavItem[];
}

interface EpubNavigation {
	toc?: EpubNavItem[];
}

// Both provider dialects the AI assistant speaks: OpenAI-compatible chat
// completions and the Anthropic messages API.
interface AiChatResponse {
	stop_reason?: string;
	content?: { type?: string; text?: string }[];
	choices?: { message?: { content?: string } }[];
}

interface TomeStrings {
	themes: Record<TomeTheme, string>;
	toc: string;
	tocFilter: string;
	aaTitle: string;
	aaSize: string;
	aaSpacing: string;
	aaTextColor: string;
	aaReset: string;
	aaReadingMode: string;
	aaJustify: string;
	toNote: string;
	toDict: string;
	save: string;
	back: string;
	phNote: string;
	phDict: string;
	extTaken: string;
	readFail: string;
	openFail: string;
	dictMissing: (path: string) => string;
	nAddedNote: (book: string, hasComment: boolean) => string;
	nAddedDict: (word: string, translation: string) => string;
	noteIntro: (book: string) => string;
	noteHeading: string;
	stLanguage: string;
	stLanguageDesc: string;
	stTheme: string;
	stThemeDesc: string;
	stFontSize: string;
	stLineHeight: string;
	stFont: string;
	stFontDesc: string;
	stFontPh: string;
	stTurnAnim: string;
	stTurnAnimDesc: string;
	stReadingMode: string;
	stReadingModeDesc: string;
	stReadingModePaginated: string;
	stReadingModeScroll: string;
	stJustifyText: string;
	stJustifyTextDesc: string;
	stPadding: string;
	stPaddingDesc: string;
	stPaddingTop: string;
	stPaddingBottom: string;
	stPaddingX: string;
	stNoteFolder: string;
	stNoteFolderDesc: string;
	stDicts: string;
	stDictsDesc: string;
	addDict: string;
	dictTo: string;
	dictNone: string;
	tocFail: string;
	tocBuilt: (count: number) => string;
	aiBtn: string;
	aiTranslate: string;
	aiExplain: string;
	aiRecap: string;
	phAsk: string;
	aiThinking: string;
	aiReading: string;
	aiNoText: string;
	aiNoKey: string;
	aiRefusal: string;
	aiEmpty: string;
	aiRecapLabel: string;
	nSavedAi: (book: string) => string;
	bmSection: string;
	bmAdded: string;
	phEdit: string;
	editSaved: string;
	editNotFound: string;
	editAmbiguous: string;
	editFail: string;
	stAiTest: string;
	stAiTestOk: string;
	stAi: string;
	stAiDesc: string;
	stAiOff: string;
	stAiCustom: string;
	stAiPreset: string;
	stAiUrl: string;
	stAiModel: string;
	stAiModelDesc: string;
	stAiKey: string;
	stAiKeyDesc: string;
}

interface TomeSettings {
	language: Lang;
	theme: TomeTheme;
	fontSize: number;
	fontFamily: string;
	lineHeight: number;
	customTextColor: string; // "" = theme color
	turnAnimation: boolean;
	readingMode: ReadingMode;
	justifyText: boolean;
	paddingTop: number;
	paddingBottom: number;
	paddingX: number;
	noteFolder: string;
	dictFiles: string[];
	lastDict: string;
	locations: Record<string, string>;
	genTocs: Record<string, TocEntry[]>; // кэш оглавлений, собранных по заголовкам
	bookmarks: Record<string, TomeBookmark[]>; // закладки по книгам
	aiPreset: string; // "" = выключен
	aiBaseUrl: string;
	aiModel: string;
	aiKey: string;
}

const DEFAULT_SETTINGS: TomeSettings = {
	language: "en",
	theme: "classic-light",
	fontSize: 18,
	fontFamily: "",
	lineHeight: 1.6,
	customTextColor: "",
	turnAnimation: false,
	readingMode: "paginated",
	justifyText: false,
	paddingTop: 20,
	paddingBottom: 20,
	paddingX: 40,
	noteFolder: "Books/Notes",
	dictFiles: [],
	lastDict: "",
	locations: {},
	genTocs: {},
	bookmarks: {},
	aiPreset: "",
	aiBaseUrl: "",
	aiModel: "",
	aiKey: "",
};

const AI_PRESETS: Record<string, { url: string; model: string }> = {
	groq: { url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
	openai: { url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
	openrouter: { url: "https://openrouter.ai/api/v1", model: "" },
	anthropic: { url: "https://api.anthropic.com", model: "claude-opus-4-8" },
	custom: { url: "", model: "" },
};

interface ThemeSpec {
	background: string;
	color: string;
	accent: string;
}

const THEMES: Record<TomeTheme, ThemeSpec> = {
	"classic-light": { background: "#faf6ee", color: "#2e2a24", accent: "#8a6d3b" },
	"classic-dark": { background: "#1e1f22", color: "#cfd2d6", accent: "#b08d57" },
	parchment: { background: "#f0e0bd", color: "#4a3423", accent: "#8b5a2b" },
	"gray-fog": { background: "#14151a", color: "#b9bcc7", accent: "#c0392b" },
};

const STRINGS: Record<Lang, TomeStrings> = {
	en: {
		themes: {
			"classic-light": "Classic Light",
			"classic-dark": "Classic Dark",
			parchment: "Parchment",
			"gray-fog": "Gray Fog",
		},
		toc: "Table of contents",
		tocFilter: "Filter chapters…",
		aaTitle: "Appearance",
		aaSize: "Size",
		aaSpacing: "Spacing",
		aaTextColor: "Text color",
		aaReset: "Reset",
		aaReadingMode: "Mode",
		aaJustify: "Justify",
		toNote: "📝 To book note",
		toDict: "🈶 To dictionary",
		save: "💾 Save",
		back: "↩ Back",
		phNote: "Your thought about this quote (optional) · Enter to save",
		phDict: "Translation or comment (empty = ❓) · Enter to save",
		extTaken: "Tome: the .epub extension is already handled by another plugin. Disable it and restart Obsidian.",
		readFail: "Failed to read the file: ",
		openFail: "Tome could not open this book: ",
		dictMissing: (p: string) => "Tome: dictionary file not found: " + p + " (set it in Tome settings)",
		nAddedNote: (b: string, c: boolean) => "📝 Added to book note" + (c ? " (with your thought)" : "") + ": " + b,
		nAddedDict: (w: string, tr: string) => "🈶 To dictionary: " + w + (tr ? " → " + tr : " — fill in the translation (❓) later"),
		noteIntro: (b: string) => `*Book note: ${b} (created by Tome).*`,
		noteHeading: "## 🔖 Highlights",
		stLanguage: "Language",
		stLanguageDesc: "Plugin interface language (reopen the book to apply)",
		stTheme: "Theme",
		stThemeDesc: "Book page appearance (also available in the Aa panel while reading)",
		stFontSize: "Font size",
		stLineHeight: "Line spacing",
		stFont: "Font",
		stFontDesc: "Font family (empty = book default). E.g.: Georgia, Noto Serif",
		stFontPh: "default",
		stTurnAnim: "Page turn animation",
		stTurnAnimDesc: "A light slide on page turns. When off, pages change instantly",
		stReadingMode: "Reading mode",
		stReadingModeDesc: "Scroll (continuous) or Paginated (page-by-page). Tap zones work in both modes",
		stReadingModePaginated: "Paginated",
		stReadingModeScroll: "Scroll",
		stJustifyText: "Force justified text",
		stJustifyTextDesc: "Align paragraph text to both left and right edges",
		stPadding: "Text padding",
		stPaddingDesc: "Padding around text in pixels (applies to all open books)",
		stPaddingTop: "Top",
		stPaddingBottom: "Bottom",
		stPaddingX: "Left & right",
		stNoteFolder: "Book notes folder",
		stNoteFolderDesc: "Where quote notes are created (selection → “To book note”)",
		stDicts: "Dictionaries",
		stDictsDesc: "Files where selected words are saved. Add several — you'll pick the target when saving",
		addDict: "+ Add dictionary",
		dictTo: "To:",
		dictNone: "Tome: no dictionaries configured — add one in Tome settings",
		tocFail: "Tome: could not open this chapter",
		tocBuilt: (n: number) => `Tome: table of contents built from headings (${n} chapters)`,
		aiBtn: "✨ AI",
		aiTranslate: "🌐 Translate",
		aiExplain: "💡 Explain",
		aiRecap: "📍 What happened so far?",
		phAsk: "Or ask your own question · Enter",
		aiThinking: "Thinking…",
		aiReading: "Collecting the text read so far…",
		aiNoText: "Tome: could not collect the text before your position",
		aiNoKey: "Tome: AI is not set up — pick a provider and add an API key in Tome settings",
		aiRefusal: "the model declined to answer",
		aiEmpty: "empty response from the model",
		aiRecapLabel: "Recap",
		nSavedAi: (b: string) => "📝 Saved to book note: " + b,
		bmSection: "Bookmarks",
		bmAdded: "🔖 Bookmark added",
		phEdit: "Corrected text · Enter to save",
		editSaved: "✏️ Fixed in the book file",
		editNotFound: "Tome: couldn't find this exact fragment in the chapter file — select a longer piece",
		editAmbiguous: "Tome: this fragment occurs several times in the chapter — select a longer piece",
		editFail: "Tome: could not edit the book: ",
		stAiTest: "Test connection",
		stAiTestOk: "✅ AI responds: ",
		stAi: "AI assistant",
		stAiDesc:
			"Bring your own API key. Selected fragments (and, for book questions, text you've already read) are sent to the provider you choose",
		stAiOff: "Off",
		stAiCustom: "Custom (OpenAI-compatible)",
		stAiPreset: "Provider",
		stAiUrl: "Base URL",
		stAiModel: "Model",
		stAiModelDesc: "E.g. llama-3.3-70b-versatile · gpt-4o-mini · claude-opus-4-8 (claude-haiku-4-5 is the budget pick)",
		stAiKey: "API key",
		stAiKeyDesc: "Stored locally in the plugin data on this device",
	},
	ru: {
		themes: {
			"classic-light": "Светлая",
			"classic-dark": "Тёмная",
			parchment: "Пергамент",
			"gray-fog": "Серый Туман",
		},
		toc: "Оглавление",
		tocFilter: "Поиск по главам…",
		aaTitle: "Оформление",
		aaSize: "Размер",
		aaSpacing: "Интервал",
		aaTextColor: "Цвет текста",
		aaReset: "Сброс",
		aaReadingMode: "Режим",
		aaJustify: "По ширине",
		toNote: "📝 В заметку книги",
		toDict: "🈶 В словарь",
		save: "💾 Сохранить",
		back: "↩ Назад",
		phNote: "Мысль к цитате (необязательно) · Enter — сохранить",
		phDict: "Перевод или комментарий (пусто = ❓) · Enter — сохранить",
		extTaken: "Tome: расширение .epub уже занято другим плагином. Отключите его и перезапустите Obsidian.",
		readFail: "Не удалось прочитать файл: ",
		openFail: "Tome не смог открыть эту книгу: ",
		dictMissing: (p: string) => "Tome: файл словаря не найден: " + p + " (проверьте путь в настройках Tome)",
		nAddedNote: (b: string, c: boolean) => "📝 В заметку книги" + (c ? " (с комментарием)" : "") + ": " + b,
		nAddedDict: (w: string, tr: string) => "🈶 В словарь: " + w + (tr ? " → " + tr : " — перевод можно вписать вместо ❓ позже"),
		noteIntro: (b: string) => `*Заметка книги: ${b} (создана в Tome).*`,
		noteHeading: "## 🔖 Выделения",
		stLanguage: "Язык",
		stLanguageDesc: "Язык интерфейса плагина. Чтобы применить, переоткройте книгу",
		stTheme: "Тема",
		stThemeDesc: "Оформление страницы книги (доступно и в панели Aa при чтении)",
		stFontSize: "Размер шрифта",
		stLineHeight: "Межстрочный интервал",
		stFont: "Шрифт",
		stFontDesc: "Название шрифта (пусто = шрифт книги). Например: Georgia, Noto Serif",
		stFontPh: "по умолчанию",
		stTurnAnim: "Анимация перелистывания",
		stTurnAnimDesc: "Лёгкий сдвиг страницы при перелистывании. Выключено — смена страниц мгновенная",
		stReadingMode: "Режим чтения",
		stReadingModeDesc: "Прокрутка (непрерывная) или Постранично. Тап-зоны работают в обоих режимах",
		stReadingModePaginated: "Постранично",
		stReadingModeScroll: "Прокрутка",
		stJustifyText: "Выравнивание по ширине",
		stJustifyTextDesc: "Выравнивать текст абзацев по обоим краям",
		stPadding: "Отступы текста",
		stPaddingDesc: "Отступы вокруг текста в пикселях (применяется ко всем открытым книгам)",
		stPaddingTop: "Сверху",
		stPaddingBottom: "Снизу",
		stPaddingX: "Слева и справа",
		stNoteFolder: "Папка заметок книг",
		stNoteFolderDesc: "Папка, в которой создаются заметки с цитатами (кнопка «В заметку книги»)",
		stDicts: "Словари",
		stDictsDesc: "Файлы, в которые сохраняются выделенные слова. Если словарей несколько, нужный выбирается при сохранении",
		addDict: "+ Добавить словарь",
		dictTo: "Куда:",
		dictNone: "Tome: словари не настроены — добавьте словарь в настройках Tome",
		tocFail: "Tome: не удалось открыть главу",
		tocBuilt: (n: number) => `Tome: оглавление собрано по заголовкам (${n} глав)`,
		aiBtn: "✨ AI",
		aiTranslate: "🌐 Перевод",
		aiExplain: "💡 Пояснить",
		aiRecap: "📍 Что было раньше?",
		phAsk: "Или свой вопрос · Enter — спросить",
		aiThinking: "Думаю…",
		aiReading: "Собираю прочитанный текст…",
		aiNoText: "Tome: не удалось собрать текст до текущего места",
		aiNoKey: "Tome: AI не настроен — укажите провайдера и API-ключ в настройках Tome",
		aiRefusal: "модель отказалась отвечать",
		aiEmpty: "пустой ответ модели",
		aiRecapLabel: "Пересказ",
		nSavedAi: (b: string) => "📝 В конспект: " + b,
		bmSection: "Закладки",
		bmAdded: "🔖 Закладка добавлена",
		phEdit: "Исправленный текст · Enter — сохранить",
		editSaved: "✏️ Исправлено в файле книги",
		editNotFound: "Tome: точное совпадение в файле главы не найдено — выделите фрагмент подлиннее",
		editAmbiguous: "Tome: фрагмент встречается в главе несколько раз — выделите подлиннее",
		editFail: "Tome: не удалось изменить книгу: ",
		stAiTest: "Проверить подключение",
		stAiTestOk: "✅ AI отвечает: ",
		stAi: "AI-ассистент",
		stAiDesc:
			"Свой API-ключ. Выделенные фрагменты (а для вопросов по книге — уже прочитанный текст) отправляются выбранному провайдеру",
		stAiOff: "Выключен",
		stAiCustom: "Свой (OpenAI-совместимый)",
		stAiPreset: "Провайдер",
		stAiUrl: "Base URL",
		stAiModel: "Модель",
		stAiModelDesc: "Например: llama-3.3-70b-versatile · gpt-4o-mini · claude-opus-4-8 (эконом-вариант — claude-haiku-4-5)",
		stAiKey: "API-ключ",
		stAiKeyDesc: "Хранится локально в данных плагина на этом устройстве",
	},
};

export default class TomePlugin extends Plugin {
	settings: TomeSettings = DEFAULT_SETTINGS;
	bookNoteStorage: BookNoteStorage;

	async onload() {
		await this.loadSettings();

		this.bookNoteStorage = new BookNoteStorage(this.app);
		this.register(() => this.bookNoteStorage.unload());

		// One-time migration of legacy data.json locations/bookmarks to notes.
		// Only runs when there are entries to migrate; subsequent startups
		// see empty maps and skip entirely.
		if (
			Object.keys(this.settings.locations).length > 0 ||
			Object.keys(this.settings.bookmarks).length > 0
		) {
			await this.bookNoteStorage.migrateAll(this.settings.locations, this.settings.bookmarks);
			this.settings.locations = {};
			this.settings.bookmarks = {};
			await this.saveSettings();
		}

		this.registerView(VIEW_TYPE_EPUB, (leaf) => new TomeView(leaf, this));

		try {
			this.registerExtensions(["epub"], VIEW_TYPE_EPUB);
		} catch {
			new Notice(this.t().extTaken);
		}

		this.addSettingTab(new TomeSettingTab(this.app, this));
	}

	async loadSettings() {
		const data = ((await this.loadData()) ?? {}) as Partial<TomeSettings> & { dictFile?: string };
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		if (!this.settings.locations) this.settings.locations = {};
		if (!Array.isArray(this.settings.dictFiles)) this.settings.dictFiles = [];
		if (!this.settings.genTocs) this.settings.genTocs = {};
		if (!this.settings.bookmarks) this.settings.bookmarks = {};
		// миграция со старого одиночного поля dictFile
		if (data.dictFile && this.settings.dictFiles.length === 0) {
			this.settings.dictFiles = [data.dictFile];
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	t(): TomeStrings {
		return STRINGS[this.settings.language] ?? STRINGS.en;
	}

	// Providers report failures either as {error: {message}} or {error: "text"}
	describeApiError(payload: unknown): string {
		if (!payload || typeof payload !== "object") return "";
		const error = (payload as { error?: unknown }).error;
		if (typeof error === "string") return error.slice(0, 300);
		if (error && typeof error === "object") {
			const message = (error as { message?: unknown }).message;
			if (typeof message === "string") return message.slice(0, 300);
			return JSON.stringify(error).slice(0, 300);
		}
		return "";
	}

	aiReady(): boolean {
		const s = this.settings;
		return Boolean(s.aiPreset && s.aiKey.trim() && s.aiModel.trim() && s.aiBaseUrl.trim());
	}

	// один вызов «system + user → текст ответа»; Anthropic говорит на своём
	// диалекте Messages API, остальные провайдеры — на OpenAI-совместимом
	async aiChat(system: string, user: string): Promise<string> {
		const s = this.settings;
		const L = this.t();
		if (!this.aiReady()) throw new Error(L.aiNoKey);
		const base = s.aiBaseUrl.trim().replace(/\/+$/, "");
		const isAnthropic = s.aiPreset === "anthropic";
		const url = isAnthropic ? base + "/v1/messages" : base + "/chat/completions";
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		let body: Record<string, unknown>;
		if (isAnthropic) {
			headers["x-api-key"] = s.aiKey.trim();
			headers["anthropic-version"] = "2023-06-01";
			body = {
				model: s.aiModel.trim(),
				max_tokens: 1500,
				system,
				messages: [{ role: "user", content: user }],
			};
		} else {
			headers["Authorization"] = "Bearer " + s.aiKey.trim();
			body = {
				model: s.aiModel.trim(),
				max_tokens: 1500,
				temperature: 0.3,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
			};
		}
		const res = await requestUrl({
			url,
			method: "POST",
			headers,
			body: JSON.stringify(body),
			throw: false,
		});
		if (res.status < 200 || res.status >= 300) {
			let msg = "HTTP " + res.status;
			const detail = this.describeApiError(res.json as unknown);
			if (detail) msg += ": " + detail;
			else if (res.text) msg += ": " + res.text.slice(0, 200);
			throw new Error(msg);
		}
		let data: AiChatResponse;
		try {
			data = res.json as AiChatResponse;
		} catch {
			throw new Error(L.aiEmpty);
		}
		let text = "";
		if (isAnthropic) {
			if (data?.stop_reason === "refusal") throw new Error(L.aiRefusal);
			const blocks = data?.content ?? [];
			text = blocks
				.filter((b) => b?.type === "text")
				.map((b) => String(b.text ?? ""))
				.join("\n");
		} else {
			text = String(data?.choices?.[0]?.message?.content ?? "");
		}
		// рассуждающие модели заворачивают мысли в <think> (в т.ч. без закрытия)
		text = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
		if (!text) throw new Error(L.aiEmpty);
		return text;
	}

	applySettingsToOpenViews() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_EPUB).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof TomeView) void view.applyAppearance(true);
		});
	}
	
	// When switching between paginated and scroll mode, a full reload is needed
	reloadAllOpenViews() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_EPUB).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof TomeView && view.file) void view.onLoadFile(view.file);
		});
	}
}

class TomeView extends FileView {
	plugin: TomePlugin;
	book: Book | null = null;
	rendition: Rendition | null = null;
	progressEl: HTMLElement | null = null;
	chapterEl: HTMLElement | null = null;
	aaPanel: HTMLElement | null = null;
	selectionBar: HTMLElement | null = null;
	selectionTextEl: HTMLElement | null = null;
	selActionsEl: HTMLElement | null = null;
	selInputWrapEl: HTMLElement | null = null;
	selInputEl: HTMLTextAreaElement | null = null;
	selMode: "note" | "dict" | "edit" | null = null;
	selDictRowEl: HTMLElement | null = null;
	selDictPath = "";
	pendingSelection = "";
	pendingContext = "";
	pendingCfiRange = "";
	pendingChapter = "";
	currentChapter = "";
	locationsReady = false;
	resizeObs: ResizeObserver | null = null;
	tocPanel: HTMLElement | null = null;
	tocListEl: HTMLElement | null = null;
	tocBmWrapEl: HTMLElement | null = null;
	tocFilterEl: HTMLInputElement | null = null;
	flatToc: TocEntry[] = [];
	flatTocGenerated = false;
	selAiBtn: HTMLElement | null = null;
	selAiWrapEl: HTMLElement | null = null;
	selAiChipsEl: HTMLElement | null = null;
	selAiInputEl: HTMLTextAreaElement | null = null;
	selAiAnswerEl: HTMLElement | null = null;
	selAiActionsEl: HTMLElement | null = null;
	aiMode: "sel" | "book" = "sel";
	aiAnswer = "";
	aiLastLabel = "";
	aiBusy = false;
	progressSync: LorebaseProgressSync;
	lastCfi = ""; // saved synchronously on every relocation, used to restore after tab switch

	constructor(leaf: WorkspaceLeaf, plugin: TomePlugin) {
		super(leaf);
		this.plugin = plugin;
		this.allowNoFile = false;
		this.navigation = true;
		this.progressSync = new LorebaseProgressSync(this.app, this.plugin.bookNoteStorage);
		// When this tab becomes active again after being hidden, epub.js's
		// internal state is corrupted (position drops to chapter start) even
		// though the container dimensions are unchanged. Force a resize +
		// position restore from the last known CFI.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf !== this.leaf) return;
				this.onTabActivated();
			})
		);
	}

	// epub.js exposes the reading position, spine and rendered documents only
	// through untyped internals; these accessors keep the casts in one place.
	rd(): EpubRenditionInternals | null {
		return this.rendition as unknown as EpubRenditionInternals | null;
	}

	bk(): EpubBookInternals | null {
		return this.book as unknown as EpubBookInternals | null;
	}

	getViewType(): string {
		return VIEW_TYPE_EPUB;
	}

	getIcon(): string {
		return "book-open";
	}

	getDisplayText(): string {
		return this.file ? this.file.basename : "Tome";
	}

	// Called when this leaf becomes the active tab again. epub.js corrupts its
	// rendering position when the container is hidden (display: none), dropping
	// to the start of the current chapter. Force a resize + redisplay at the
	// last known CFI to restore the exact position.
	onTabActivated() {
		if (!this.rendition || !this.file) return;
		const readerEl = this.contentEl.querySelector<HTMLElement>(".tome-reader");
		if (!readerEl) return;
		const w = Math.floor(readerEl.clientWidth / 2) * 2;
		const h = Math.floor(readerEl.clientHeight);
		if (w <= 0 || h <= 0) return; // still hidden — will retry on next event
		// Force resize to rebuild epub.js's internal layout after the 0-size
		// corruption, then restore the position from the last known CFI.
		try {
			this.rd()?.resize?.(w, h);
		} catch {
			/* noop */
		}
		const cfi = this.lastCfi || this.plugin.bookNoteStorage.getCfi(this.file.path) || "";
		if (cfi) {
			window.setTimeout(() => void this.tryDisplay(cfi), 100);
		}
	}

	async onLoadFile(file: TFile): Promise<void> {
		await this.closeBook();
		const container = this.contentEl;
		container.empty();
		container.addClass("tome-view");

		// ── шапка ──
		const L = this.plugin.t();
		const header = container.createDiv({ cls: "tome-header" });
		const tocBtn = header.createEl("button", { cls: "tome-btn", text: "☰" });
		tocBtn.setAttr("aria-label", L.toc);
		header.createDiv({ cls: "tome-title", text: file.basename });
		this.chapterEl = header.createDiv({ cls: "tome-chapter", text: "" });
		this.progressEl = header.createDiv({ cls: "tome-progress", text: "…" });
		const bmHeaderBtn = header.createEl("button", { cls: "tome-btn", text: "🔖" });
		bmHeaderBtn.setAttr("aria-label", L.bmSection);
		const aiHeaderBtn = header.createEl("button", { cls: "tome-btn", text: "✨" });
		aiHeaderBtn.setAttr("aria-label", L.aiBtn);
		const aaBtn = header.createEl("button", { cls: "tome-btn tome-aa-btn", text: "Aa" });
		aaBtn.setAttr("aria-label", L.aaTitle);

		// ── область чтения ──
		const readerWrap = container.createDiv({ cls: "tome-reader-wrap" });
		const readerEl = readerWrap.createDiv({ cls: "tome-reader" });

		// ── панель Aa (создаётся скрытой) ──
		this.buildAaPanel(readerWrap);

		// ── панель выделения (создаётся скрытой) ──
		this.buildSelectionBar(readerWrap);

		// ── панель оглавления (создаётся скрытой) ──
		this.buildTocPanel(readerWrap);

		// ── книга ──
		let data: ArrayBuffer;
		try {
			data = await this.app.vault.readBinary(file);
		} catch (e) {
			readerEl.setText(L.readFail + String(e));
			return;
		}

		try {
			this.book = ePub(data);
			// Load note-backed CFI/bookmarks into the shared cache before the
			// first display so the saved position is available.
			this.plugin.bookNoteStorage.loadFromNote(file.path);
			// Begin Lorebase progress sync for this book (async, non-blocking).
			this.progressSync.start(file, this.book);
			// целые чётные размеры с самого старта: дробная ширина ломает
			// колоночную раскладку — «проглатывается» последняя страница главы
			const w0 = Math.floor(readerEl.clientWidth / 2) * 2;
			const h0 = Math.floor(readerEl.clientHeight);
			const isScroll = this.plugin.settings.readingMode === "scroll";
			// epub.js sets body padding-left/right = gap/2 with !important,
			// so we pass gap = paddingX * 2 to control horizontal padding
			const s = this.plugin.settings;
			const gapPx = s.paddingX * 2;
			this.rendition = this.book.renderTo(readerEl, {
				width: w0 > 0 ? w0 : "100%",
				height: h0 > 0 ? h0 : "100%",
				flow: isScroll ? "scrolled" : "paginated",
				spread: "none",
				gap: gapPx,
				allowScriptedContent: false,
			// gap is accepted by epub.js but missing from its TypeScript types
			} as Parameters<typeof this.book.renderTo>[1]);
		} catch (e) {
			readerEl.setText(L.openFail + String(e));
			return;
		}

		// зоны-накладки по краям перекрывали начало строк и мешали выделять
		// первые слова — тапы ловим внутри самой страницы: короткий тап у края
		// листает, длинное нажатие и выделение всегда достаются тексту
		this.rd()?.hooks?.content?.register((contents: EpubContents) => {
			this.attachTapTurning(contents);
			// specific style for scroll mode
			// 1.prevent horizontal overflow (due to scroll bar)
			// 2.append a spacer div so the last line can be scrolled higher up the screen (simple padding gets overridden by epub.js)
			if (this.plugin.settings.readingMode === "scroll") {
				const doc = contents?.document;
				if (doc?.body) {
					const mgr = this.rd()?.manager;
					const mgrContainer = mgr?.container;
					if (mgrContainer) mgrContainer.style.overflowX = "hidden";

					let spacer = doc.getElementById("tome-scroll-spacer");
					if (!spacer) {
						spacer = doc.createElement("div");
						spacer.id = "tome-scroll-spacer";
						spacer.style.width = "100%";
						spacer.style.pointerEvents = "none";
						doc.body.appendChild(spacer);
					}
					const h = mgrContainer?.clientHeight ?? 400;
					spacer.style.height = Math.round(h / 2) + "px";
				}
			}
		});

		await this.applyAppearance(false);

		const savedCfi = this.plugin.bookNoteStorage.getCfi(file.path);
		try {
			await this.rendition.display(savedCfi || undefined);
		} catch {
			await this.rendition.display();
		}

		// переразметка — только при реальном изменении ширины (поворот,
		// перетаскивание панели): на планшете высота дёргается из-за клавиатуры
		// и системных панелей, и реакция на неё превращалась в «мигание»
		let lastW = Math.floor(readerEl.clientWidth / 2) * 2;
		let lastH = Math.floor(readerEl.clientHeight);
		let wasHidden = false; // tab hidden → dimensions hit 0 → epub.js corrupts position
		const applySize = debounce(
			() => {
				if (!this.rendition) return;
				const w = Math.floor(readerEl.clientWidth / 2) * 2;
				const h = Math.floor(readerEl.clientHeight);
				if (w <= 0 || h <= 0) {
					// view hidden (tab switch) — record it so we force a restore on return
					wasHidden = true;
					return;
				}
				const heightMatters = !Platform.isMobile && this.plugin.settings.readingMode !== "scroll";
				// skip only when dimensions are unchanged AND the view wasn't hidden;
				// after a hide/show cycle epub.js state is corrupted even at the same size
				if (!wasHidden && Math.abs(w - lastW) < 2 && (!heightMatters || Math.abs(h - lastH) < 2)) return;
				wasHidden = false;
				lastW = w;
				lastH = h;
				const loc = this.rd()?.currentLocation?.();
				const cfi = String(loc?.start?.cfi ?? "");
				try {
					this.rd()?.resize?.(w, h);
				} catch {
					/* noop */
				}
				// resize у epub.js может уронить позицию на начало главы — возвращаем
				if (cfi) window.setTimeout(() => void this.tryDisplay(cfi), 80);
			},
			300,
			true
		);
		this.resizeObs?.disconnect();
		this.resizeObs = new ResizeObserver(() => applySize());
		this.resizeObs.observe(readerEl);

		// ── события ──
		this.rendition.on("relocated", (location: EpubLocation) => {
			const cfi: string | undefined = location?.start?.cfi;
			if (cfi) {
				this.lastCfi = cfi;
				// In-memory CFI is updated here for synchronous tab restoration.
				// Disk persistence is handled by progressSync's combined write.
				if (this.file) {
					this.plugin.bookNoteStorage.setCfiInMemory(this.file.path, cfi);
				}
			}
			this.updateProgress(location);
			const tocIdx = this.getCurrentTocIndex(
				String(location?.start?.href ?? ""),
				String(cfi ?? "")
			);
			this.progressSync.handleRelocated(
				location,
				tocIdx >= 0 ? tocIdx + 1 : 0,
				this.flatToc.length
			);
		});

		this.rendition.on("selected", (cfiRange: string, contents: EpubContents) => {
			try {
				const sel = contents?.window?.getSelection?.();
				const text = sel ? String(sel.toString()).trim() : "";
				let para = "";
				try {
					// абзац вокруг выделения — контекст для AI-перевода/пояснения
					const node: Node | null = sel?.anchorNode ?? null;
					const el =
						node instanceof Element ? node : (node?.parentElement ?? null);
					para = String(el?.closest("p, li, blockquote, div")?.textContent ?? "")
						.replace(/\s+/g, " ")
						.trim()
						.slice(0, 600);
				} catch {
					/* noop */
				}
				if (text) this.showSelection(text, para, String(cfiRange ?? ""));
			} catch {
				/* noop */
			}
		});

		const keyHandler = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "TEXTAREA" ||
					target.tagName === "INPUT" ||
					target.isContentEditable)
			)
				return; // печатаем в поле — страницы не трогаем
			if (e.key === "ArrowLeft") this.turnPageDir("prev");
			if (e.key === "ArrowRight" || e.key === " ") this.turnPageDir("next");
		};
		this.rendition.on("keydown", keyHandler);
		this.registerDomEvent(container, "keydown", keyHandler);

		tocBtn.onclick = () => this.toggleToc();
		aaBtn.onclick = () => this.toggleAaPanel();
		aiHeaderBtn.onclick = () => this.openBookAi();
		bmHeaderBtn.onclick = () => void this.addBookmarkHere();

		this.flatToc = [];
		this.flatTocGenerated = false;
		void this.book.loaded.navigation
			.then(async (nav: EpubNavigation) => {
				const walk = (items: EpubNavItem[], depth: number) => {
					for (const it of items ?? []) {
						this.flatToc.push({
							label: String(it?.label ?? "").trim(),
							href: String(it?.href ?? ""),
							depth,
						});
						if (it?.subitems?.length && depth < 2) walk(it.subitems, depth + 1);
					}
				};
				walk(nav?.toc ?? [], 0);
				// у конвертированных книг ncx часто пуст («Start») — собираем
				// оглавление по заголовкам внутри текста
				if (this.flatToc.length <= 2 && this.file) {
					const cached = this.plugin.settings.genTocs[this.file.path];
					if (cached?.length) {
						this.flatToc = cached.slice();
						this.flatTocGenerated = true;
						return;
					}
					const entries = await this.generateTocFromHeadings();
					if (entries.length > this.flatToc.length && this.file) {
						this.flatToc = entries;
						this.flatTocGenerated = true;
						this.plugin.settings.genTocs[this.file.path] = entries;
						await this.plugin.saveSettings();
						new Notice(this.plugin.t().tocBuilt(entries.length));
					}
				}
			})
			.catch(() => {});

		void this.book.ready
			.then(() => this.book!.locations.generate(1024))
			.then(() => {
				this.locationsReady = true;
				const loc = this.rd()?.currentLocation?.();
				if (loc) this.updateProgress(loc);
				const locCount = this.book?.locations.length?.() ?? 0;
				const tocIdx = this.getCurrentTocIndex(
					String(loc?.start?.href ?? ""),
					String(loc?.start?.cfi ?? "")
				);
				this.progressSync.locationsGenerated(
					locCount,
					loc ?? {},
					tocIdx >= 0 ? tocIdx + 1 : 0,
					this.flatToc.length
				);
			})
			.catch(() => {});
	}

	// ─────────────────── панель Aa ───────────────────

	buildAaPanel(parent: HTMLElement) {
		const panel = parent.createDiv({ cls: "tome-aa-panel" });
		panel.hide();
		this.aaPanel = panel;

		const L = this.plugin.t();

		// темы
		const themesRow = panel.createDiv({ cls: "tome-aa-row" });
		(Object.keys(THEMES) as TomeTheme[]).forEach((key) => {
			const spec = THEMES[key];
			const chip = themesRow.createEl("button", { cls: "tome-theme-chip", text: L.themes[key] });
			chip.style.setProperty("--chip-bg", spec.background);
			chip.style.setProperty("--chip-fg", spec.color);
			chip.onclick = async () => {
				this.plugin.settings.theme = key;
				this.plugin.settings.customTextColor = "";
				await this.plugin.saveSettings();
				this.plugin.applySettingsToOpenViews();
				this.refreshAaPanel();
			};
		});

		// reading mode: scroll / paginated
		const modeRow = panel.createDiv({ cls: "tome-aa-row" });
		modeRow.createSpan({ cls: "tome-aa-label", text: L.aaReadingMode });
		const modePaginated = modeRow.createEl("button", { cls: "tome-btn", text: L.stReadingModePaginated });
		const modeScroll = modeRow.createEl("button", { cls: "tome-btn", text: L.stReadingModeScroll });
		const updateModeButtons = () => {
			const isScroll = this.plugin.settings.readingMode === "scroll";
			modePaginated.toggleClass("tome-btn-active", !isScroll);
			modeScroll.toggleClass("tome-btn-active", isScroll);
		};
		updateModeButtons();
		modePaginated.onclick = async () => {
			if (this.plugin.settings.readingMode === "paginated") return;
			this.plugin.settings.readingMode = "paginated";
			await this.plugin.saveSettings();
			updateModeButtons();
			this.plugin.reloadAllOpenViews();
		};
		modeScroll.onclick = async () => {
			if (this.plugin.settings.readingMode === "scroll") return;
			this.plugin.settings.readingMode = "scroll";
			await this.plugin.saveSettings();
			updateModeButtons();
			this.plugin.reloadAllOpenViews();
		};

		// размер шрифта
		const sizeRow = panel.createDiv({ cls: "tome-aa-row" });
		sizeRow.createSpan({ cls: "tome-aa-label", text: L.aaSize });
		const sizeMinus = sizeRow.createEl("button", { cls: "tome-btn", text: "−" });
		const sizeVal = sizeRow.createSpan({ cls: "tome-aa-value", text: String(this.plugin.settings.fontSize) });
		const sizePlus = sizeRow.createEl("button", { cls: "tome-btn", text: "+" });
		sizeMinus.onclick = async () => {
			this.plugin.settings.fontSize = Math.max(12, this.plugin.settings.fontSize - 1);
			sizeVal.setText(String(this.plugin.settings.fontSize));
			await this.plugin.saveSettings();
			this.plugin.applySettingsToOpenViews();
		};
		sizePlus.onclick = async () => {
			this.plugin.settings.fontSize = Math.min(36, this.plugin.settings.fontSize + 1);
			sizeVal.setText(String(this.plugin.settings.fontSize));
			await this.plugin.saveSettings();
			this.plugin.applySettingsToOpenViews();
		};

		// межстрочный интервал
		const lhRow = panel.createDiv({ cls: "tome-aa-row" });
		lhRow.createSpan({ cls: "tome-aa-label", text: L.aaSpacing });
		const lhMinus = lhRow.createEl("button", { cls: "tome-btn", text: "−" });
		const lhVal = lhRow.createSpan({ cls: "tome-aa-value", text: this.plugin.settings.lineHeight.toFixed(1) });
		const lhPlus = lhRow.createEl("button", { cls: "tome-btn", text: "+" });
		lhMinus.onclick = async () => {
			this.plugin.settings.lineHeight = Math.max(1.1, Math.round((this.plugin.settings.lineHeight - 0.1) * 10) / 10);
			lhVal.setText(this.plugin.settings.lineHeight.toFixed(1));
			await this.plugin.saveSettings();
			this.plugin.applySettingsToOpenViews();
		};
		lhPlus.onclick = async () => {
			this.plugin.settings.lineHeight = Math.min(2.4, Math.round((this.plugin.settings.lineHeight + 0.1) * 10) / 10);
			lhVal.setText(this.plugin.settings.lineHeight.toFixed(1));
			await this.plugin.saveSettings();
			this.plugin.applySettingsToOpenViews();
		};

		// justify text alignment
		const justifyRow = panel.createDiv({ cls: "tome-aa-row" });
		justifyRow.createSpan({ cls: "tome-aa-label", text: L.aaJustify });
		const justifyToggle = justifyRow.createEl("button", { cls: "tome-btn" });
		const updateJustifyBtn = () => {
			justifyToggle.setText(this.plugin.settings.justifyText ? "✓" : "✕");
			justifyToggle.toggleClass("tome-btn-active", this.plugin.settings.justifyText);
		};
		updateJustifyBtn();
		justifyToggle.onclick = async () => {
			this.plugin.settings.justifyText = !this.plugin.settings.justifyText;
			await this.plugin.saveSettings();
			updateJustifyBtn();
			this.plugin.applySettingsToOpenViews();
		};

		// цвет текста
		const colorRow = panel.createDiv({ cls: "tome-aa-row" });
		colorRow.createSpan({ cls: "tome-aa-label", text: L.aaTextColor });
		const colorInput = colorRow.createEl("input", { cls: "tome-color-input" });
		colorInput.type = "color";
		colorInput.value = this.plugin.settings.customTextColor || THEMES[this.plugin.settings.theme].color;
		colorInput.oninput = async () => {
			this.plugin.settings.customTextColor = colorInput.value;
			await this.plugin.saveSettings();
			this.plugin.applySettingsToOpenViews();
		};
		const colorReset = colorRow.createEl("button", { cls: "tome-btn", text: L.aaReset });
		colorReset.onclick = async () => {
			this.plugin.settings.customTextColor = "";
			colorInput.value = THEMES[this.plugin.settings.theme].color;
			await this.plugin.saveSettings();
			this.plugin.applySettingsToOpenViews();
		};
	}

	refreshAaPanel() {
		if (!this.aaPanel) return;
		const input = this.aaPanel.querySelector<HTMLInputElement>(".tome-color-input");
		if (input)
			input.value = this.plugin.settings.customTextColor || THEMES[this.plugin.settings.theme].color;
	}

	toggleAaPanel() {
		if (!this.aaPanel) return;
		if (this.aaPanel.isShown()) this.aaPanel.hide();
		else {
			this.hideToc();
			this.refreshAaPanel();
			this.aaPanel.show();
		}
	}

	// ─────────────────── выделение → заметки/словарь ───────────────────

	buildSelectionBar(parent: HTMLElement) {
		const bar = parent.createDiv({ cls: "tome-selection-bar" });
		bar.hide();
		this.selectionBar = bar;
		this.selectionTextEl = bar.createDiv({ cls: "tome-selection-text" });

		// этап 1 — выбор действия
		const L = this.plugin.t();
		const actions = bar.createDiv({ cls: "tome-selection-actions" });
		this.selActionsEl = actions;
		const noteBtn = actions.createEl("button", { cls: "tome-btn", text: L.toNote });
		const dictBtn = actions.createEl("button", { cls: "tome-btn", text: L.toDict });
		const aiBtn = actions.createEl("button", { cls: "tome-btn", text: L.aiBtn });
		this.selAiBtn = aiBtn;
		const bmBtn = actions.createEl("button", { cls: "tome-btn", text: "🔖" });
		bmBtn.setAttr("aria-label", L.bmSection);
		const editBtn = actions.createEl("button", { cls: "tome-btn", text: "✏️" });
		editBtn.setAttr("aria-label", L.phEdit);
		const closeBtn = actions.createEl("button", { cls: "tome-btn", text: "✕" });
		noteBtn.onclick = () => this.openInputStage("note");
		dictBtn.onclick = () => this.openInputStage("dict");
		aiBtn.onclick = () => this.openAiStage("sel");
		bmBtn.onclick = () => void this.addSelectionBookmark();
		editBtn.onclick = () => this.openInputStage("edit");
		closeBtn.onclick = () => this.hideSelection();

		// этап 2 — поле для мысли/перевода
		const inputWrap = bar.createDiv({ cls: "tome-selection-input" });
		inputWrap.hide();
		this.selInputWrapEl = inputWrap;
		this.selDictRowEl = inputWrap.createDiv({ cls: "tome-dict-row" });
		this.selDictRowEl.hide();
		const input = inputWrap.createEl("textarea", { cls: "tome-input" });
		input.rows = 2;
		this.selInputEl = input;
		const inputActions = inputWrap.createDiv({ cls: "tome-selection-actions" });
		const saveBtn = inputActions.createEl("button", { cls: "tome-btn tome-btn-accent", text: L.save });
		const backBtn = inputActions.createEl("button", { cls: "tome-btn", text: L.back });
		saveBtn.onclick = () => void this.saveFromInput();
		backBtn.onclick = () => this.showActionsStage();
		input.onkeydown = (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.saveFromInput();
			}
			if (e.key === "Escape") this.showActionsStage();
		};

		// этап 3 — AI: быстрые действия, свой вопрос, ответ
		const aiWrap = bar.createDiv({ cls: "tome-selection-input" });
		aiWrap.hide();
		this.selAiWrapEl = aiWrap;
		this.selAiChipsEl = aiWrap.createDiv({ cls: "tome-dict-row" });
		const aiInput = aiWrap.createEl("textarea", { cls: "tome-input" });
		aiInput.rows = 1;
		aiInput.placeholder = L.phAsk;
		this.selAiInputEl = aiInput;
		aiInput.onkeydown = (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				if (this.aiMode === "book") void this.runBookAi("ask");
				else void this.runAi("ask");
			}
			if (e.key === "Escape") this.closeAiStage();
		};
		const answer = aiWrap.createDiv({ cls: "tome-ai-answer" });
		answer.hide();
		this.selAiAnswerEl = answer;
		const aiActions = aiWrap.createDiv({ cls: "tome-selection-actions" });
		this.selAiActionsEl = aiActions;
		const aiToDict = aiActions.createEl("button", { cls: "tome-btn tome-ai-todict", text: L.toDict });
		const aiToNote = aiActions.createEl("button", { cls: "tome-btn tome-ai-tonote", text: L.toNote });
		const aiBack = aiActions.createEl("button", { cls: "tome-btn", text: L.back });
		// ответ AI подставляется в обычный этап словаря/конспекта — там можно
		// поправить текст и выбрать словарь-цель
		aiToDict.onclick = () => {
			const ans = this.aiAnswer;
			this.openInputStage("dict");
			if (this.selInputEl) this.selInputEl.value = ans;
		};
		aiToNote.onclick = () => {
			if (this.aiMode === "book") {
				void this.saveBookAiToNote();
				return;
			}
			const ans = this.aiAnswer;
			this.openInputStage("note");
			if (this.selInputEl) this.selInputEl.value = ans;
		};
		aiBack.onclick = () => this.closeAiStage();
	}

	// ─────────────────── AI-ассистент ───────────────────

	openAiStage(mode: "sel" | "book") {
		const L = this.plugin.t();
		if (!this.plugin.aiReady()) {
			new Notice(L.aiNoKey);
			return;
		}
		this.aiMode = mode;
		this.aiAnswer = "";
		this.setAiAnswer("");
		if (!this.selAiWrapEl || !this.selAiChipsEl || !this.selAiInputEl) return;
		this.selAiChipsEl.empty();
		if (mode === "sel") {
			const tr = this.selAiChipsEl.createEl("button", { cls: "tome-dict-chip", text: L.aiTranslate });
			tr.onclick = () => void this.runAi("translate");
			const ex = this.selAiChipsEl.createEl("button", { cls: "tome-dict-chip", text: L.aiExplain });
			ex.onclick = () => void this.runAi("explain");
		} else {
			const rc = this.selAiChipsEl.createEl("button", { cls: "tome-dict-chip", text: L.aiRecap });
			rc.onclick = () => void this.runBookAi("recap");
		}
		this.selAiInputEl.value = "";
		this.selMode = null;
		this.selActionsEl?.hide();
		this.selInputWrapEl?.hide();
		this.selAiWrapEl.show();
	}

	closeAiStage() {
		if (this.aiMode === "book") {
			this.hideSelection();
			return;
		}
		this.selAiWrapEl?.hide();
		this.selActionsEl?.show();
	}

	// вопросы по книге без выделения — из кнопки ✨ в шапке
	openBookAi() {
		const L = this.plugin.t();
		if (!this.plugin.aiReady()) {
			new Notice(L.aiNoKey);
			return;
		}
		this.pendingSelection = "";
		this.pendingContext = "";
		if (this.selectionTextEl) {
			const where = this.currentChapter ? " · " + this.currentChapter : "";
			this.selectionTextEl.setText("✨ " + (this.file?.basename ?? "") + where);
		}
		this.hideToc();
		this.aaPanel?.hide();
		this.openAiStage("book");
		this.selectionBar?.show();
	}

	setAiAnswer(text: string) {
		const el = this.selAiAnswerEl;
		if (!el) return;
		el.setText(text);
		el.toggle(Boolean(text));
		const hasAnswer = Boolean(this.aiAnswer);
		// перевод → словарь только для выделения; в конспект — в обоих режимах
		this.selAiActionsEl
			?.querySelector(".tome-ai-todict")
			?.toggleClass("tome-hidden", !(hasAnswer && this.aiMode === "sel"));
		this.selAiActionsEl?.querySelector(".tome-ai-tonote")?.toggleClass("tome-hidden", !hasAnswer);
	}

	async runAi(kind: "translate" | "explain" | "ask") {
		if (this.aiBusy) return;
		const L = this.plugin.t();
		const sel = this.pendingSelection;
		const para = this.pendingContext;
		const book = this.file?.basename ?? "";
		const lang = this.plugin.settings.language === "ru" ? "Russian" : "English";
		let userMsg = "";
		if (kind === "translate") {
			userMsg =
				`Translate into ${lang}: "${sel}"` +
				(para && para !== sel ? `\nSentence context: "${para}"` : "") +
				`\nReply with ONLY the translation; for a single word you may add the reading or a brief nuance in parentheses.`;
		} else if (kind === "explain") {
			userMsg =
				`Explain the meaning of this fragment in its context (terms, idioms, cultural references, allusions): "${sel}"` +
				(para && para !== sel ? `\nContext: "${para}"` : "") +
				`\nAnswer in 2–5 sentences.`;
		} else {
			const q = (this.selAiInputEl?.value ?? "").trim();
			if (!q) return;
			userMsg = q + `\n\nAbout this fragment from the book: "${sel}"` + (para && para !== sel ? `\nContext: "${para}"` : "");
		}
		const system = `You are a reading assistant inside an e-book reader. The reader is reading "${book}". Answer in ${lang}. Be concise and helpful. Do not reveal plot events beyond the provided text.`;
		await this.execAi(system, userMsg, L.aiThinking);
	}

	async runBookAi(kind: "recap" | "ask") {
		if (this.aiBusy) return;
		const L = this.plugin.t();
		const q = kind === "ask" ? (this.selAiInputEl?.value ?? "").trim() : "";
		if (kind === "ask" && !q) return;
		this.aiLastLabel = kind === "recap" ? L.aiRecapLabel : q.length > 60 ? q.slice(0, 60) + "…" : q;
		this.aiBusy = true;
		this.aiAnswer = "";
		this.setAiAnswer("⏳ " + L.aiReading);
		let excerpt = "";
		try {
			excerpt = await this.getTextBeforePosition(12000);
		} catch {
			/* noop */
		}
		this.aiBusy = false;
		if (!excerpt) {
			this.setAiAnswer("");
			new Notice(L.aiNoText);
			return;
		}
		const book = this.file?.basename ?? "";
		const chapter = this.currentChapter;
		const lang = this.plugin.settings.language === "ru" ? "Russian" : "English";
		const system =
			`You are a reading assistant inside an e-book reader. The reader is reading "${book}"` +
			(chapter ? `, currently at "${chapter}"` : "") +
			`. Answer in ${lang}. Important: rely ONLY on the provided excerpt (text before the reader's current position); never reveal or guess anything beyond it.`;
		const user =
			kind === "recap"
				? `Excerpt (the tail of what has been read so far):\n"""${excerpt}"""\n\nBriefly remind me what has been happening: key events and characters, 3–6 bullet points.`
				: `Excerpt (the tail of what has been read so far):\n"""${excerpt}"""\n\nMy question: ${q}\nIf the excerpt is not enough to answer, say you can't tell yet without spoilers.`;
		await this.execAi(system, user, L.aiThinking);
	}

	// пересказ или ответ по книге — в конспект отдельным блоком
	async saveBookAiToNote() {
		if (!this.aiAnswer || !this.file) return;
		const L = this.plugin.t();
		const note = await this.getOrCreateBookNote();
		if (!note) return;
		const pct = String(this.progressEl?.textContent ?? "").trim();
		const where = [this.currentChapter, pct].filter(Boolean).join(" · ");
		const title = "✨ " + (this.aiLastLabel || L.aiRecapLabel) + (where ? " — " + where : "");
		const body = this.aiAnswer
			.split("\n")
			.map((l) => "> " + l)
			.join("\n");
		await this.appendToFile(note, `> [!tip] ${title}\n${body}`, L.noteHeading);
		new Notice(L.nSavedAi(this.file.basename));
	}

	async execAi(system: string, user: string, waitText: string) {
		if (this.aiBusy) return;
		this.aiBusy = true;
		this.aiAnswer = "";
		this.setAiAnswer("⏳ " + waitText);
		try {
			const res = await this.plugin.aiChat(system, user);
			this.aiAnswer = res;
			this.setAiAnswer(res);
		} catch (e) {
			this.setAiAnswer("");
			new Notice("Tome AI: " + String((e as Error)?.message ?? e));
		} finally {
			this.aiBusy = false;
		}
	}

	// текст до текущей позиции читателя (без спойлеров) — контекст для AI
	async getTextBeforePosition(maxChars: number): Promise<string> {
		const loc = this.rd()?.currentLocation?.();
		const startHref = String(loc?.start?.href ?? "");
		const cfi = String(loc?.start?.cfi ?? "");
		const spine = this.bk()?.spine;
		const items: EpubSection[] = spine?.spineItems ?? [];
		if (!items.length) return "";
		let curIdx = items.findIndex((it) => this.samePath(String(it?.href ?? ""), startHref));
		if (curIdx < 0) curIdx = 0;
		let text = "";
		// текущий файл — только до позиции чтения
		try {
			const contents: EpubContents[] = this.rd()?.getContents?.() ?? [];
			for (const c of contents) {
				const doc: Document | undefined = c?.document;
				if (!doc?.body) continue;
				let upTo = "";
				try {
					const range = c.range?.(cfi);
					if (range) {
						const r = doc.createRange();
						r.setStart(doc.body, 0);
						r.setEnd(range.startContainer, range.startOffset);
						upTo = r.toString();
					}
				} catch {
					/* noop */
				}
				if (!upTo) upTo = String(doc.body.textContent ?? "");
				text = upTo;
				break;
			}
		} catch {
			/* noop */
		}
		// предыдущие файлы, пока не наберём maxChars
		for (let i = curIdx - 1; i >= 0 && text.length < maxChars; i--) {
			const sec = items[i];
			try {
				await sec.load?.(this.bk()?.load?.bind(this.book));
				const t = String(sec.document?.body?.textContent ?? "");
				sec.unload?.();
				text = t + "\n" + text;
			} catch {
				/* noop */
			}
		}
		return text.replace(/\s+/g, " ").trim().slice(-maxChars);
	}

	openInputStage(mode: "note" | "dict" | "edit") {
		this.selMode = mode;
		if (!this.selInputEl || !this.selInputWrapEl || !this.selActionsEl) return;
		const L = this.plugin.t();
		// для правки опечатки стартуем с исходного текста выделения
		this.selInputEl.value = mode === "edit" ? this.pendingSelection : "";
		this.selInputEl.placeholder = mode === "note" ? L.phNote : mode === "dict" ? L.phDict : L.phEdit;
		if (mode === "dict") this.renderDictChips();
		else this.selDictRowEl?.hide();
		this.selActionsEl.hide();
		this.selAiWrapEl?.hide();
		this.selInputWrapEl.show();
		this.selInputEl.focus();
	}

	renderDictChips() {
		const row = this.selDictRowEl;
		if (!row) return;
		const s = this.plugin.settings;
		const L = this.plugin.t();
		row.empty();
		if (s.dictFiles.length <= 1) {
			this.selDictPath = s.dictFiles[0] ?? "";
			row.hide();
			return;
		}
		if (!s.dictFiles.includes(this.selDictPath)) {
			this.selDictPath =
				s.lastDict && s.dictFiles.includes(s.lastDict) ? s.lastDict : s.dictFiles[0];
		}
		row.createSpan({ cls: "tome-aa-label", text: L.dictTo });
		for (const p of s.dictFiles) {
			const name = p.split("/").pop()?.replace(/\.md$/, "") ?? p;
			const chip = row.createEl("button", {
				cls: "tome-dict-chip" + (p === this.selDictPath ? " is-active" : ""),
				text: name,
			});
			chip.onclick = () => {
				this.selDictPath = p;
				this.renderDictChips();
			};
		}
		row.show();
	}

	showActionsStage() {
		this.selMode = null;
		this.selInputWrapEl?.hide();
		this.selAiWrapEl?.hide();
		this.selActionsEl?.show();
	}

	async saveFromInput() {
		const extra = (this.selInputEl?.value ?? "").trim();
		if (this.selMode === "note") await this.addSelectionToNote(extra);
		else if (this.selMode === "dict") await this.addSelectionToDict(extra);
		else if (this.selMode === "edit") await this.addEditToBook(extra);
	}

	showSelection(text: string, context = "", cfiRange = "") {
		this.pendingSelection = text;
		this.pendingContext = context;
		this.pendingCfiRange = cfiRange;
		this.pendingChapter = this.currentChapter; // глава на момент выделения
		if (this.selectionTextEl) {
			const short = text.length > 120 ? text.slice(0, 120) + "…" : text;
			this.selectionTextEl.setText("«" + short + "»");
		}
		this.selAiBtn?.toggle(this.plugin.aiReady());
		this.showActionsStage();
		this.selectionBar?.show();
	}

	hideSelection() {
		this.pendingSelection = "";
		this.pendingContext = "";
		this.pendingCfiRange = "";
		this.aiAnswer = "";
		this.selMode = null;
		this.selectionBar?.hide();
		// планшетное выделение может «увезти» колонку — возвращаем страницу на место
		void this.realignPage();
	}

	// ─────────────────── закладки ───────────────────

	getBookmarks(): TomeBookmark[] {
		const key = this.file?.path ?? "";
		if (!key) return [];
		return this.plugin.bookNoteStorage.getBookmarks(key);
	}

	async addBookmark(cfi: string, label: string) {
		if (!cfi || !this.file) return;
		this.getBookmarks().push({ cfi, label: label.slice(0, 80), created: Date.now() });
		await this.plugin.bookNoteStorage.persistBookmarks(this.file);
		new Notice(this.plugin.t().bmAdded);
	}

	// закладка «я сейчас здесь» — из кнопки в шапке
	async addBookmarkHere() {
		const loc = this.rd()?.currentLocation?.();
		const cfi = String(loc?.start?.cfi ?? "");
		const pct = String(this.progressEl?.textContent ?? "").trim();
		const label = [this.currentChapter || this.file?.basename || "", pct]
			.filter(Boolean)
			.join(" · ");
		await this.addBookmark(cfi, label || "—");
	}

	// закладка на выделенном фрагменте — подписью служит сам текст
	async addSelectionBookmark() {
		const loc = this.rd()?.currentLocation?.();
		const cfi = this.pendingCfiRange || String(loc?.start?.cfi ?? "");
		const label = this.pendingSelection.replace(/\s+/g, " ").trim().slice(0, 60);
		await this.addBookmark(cfi, label || "—");
		this.hideSelection();
	}

	turnPageDir(dir: "prev" | "next") {
		if (!this.rendition) return;
		if (this.plugin.settings.readingMode === "scroll") {
			this.scrollByViewport(dir);
		} else {
			this.animateTurn(dir);
			if (dir === "prev") void this.rendition.prev();
			else void this.turnNext();
		}
	}

	scrollByViewport(dir: "prev" | "next") {
		const mgr = this.rd()?.manager;
		const container: HTMLElement | undefined = mgr?.container;
		if (!container) return;
		const h = container.clientHeight;
		// distance from the edge we're moving toward:
		// next → distance to bottom; prev → distance to top
		const fromEdge = dir === "next"
			? container.scrollHeight - (container.scrollTop + h)
			: container.scrollTop;
		if (fromEdge < 10) {
			// at the edge — advance to next/previous chapter
			if (dir === "next") {
				void this.rendition?.next();
			} else {
				void this.rendition?.prev();
			}
		} else {
			container.scrollTop += dir === "next" ? h : -h;
		}
		try { this.rd()?.reportLocation?.(); } catch { /* noop */ }
	}

	// короткий тап у левого/правого края страницы = перелистывание;
	// движение, длинное нажатие и активное выделение страницу не листают
	attachTapTurning(contents: EpubContents) {
		const doc: Document | undefined = contents?.document;
		const win: Window | undefined = contents?.window;
		if (!doc || !win) return;
		let startX = 0;
		let startY = 0;
		let startT = 0;
		let moved = true;
		let lastTurnT = 0;
		const down = (x: number, y: number) => {
			startX = x;
			startY = y;
			startT = Date.now();
			moved = false;
		};
		const move = (x: number, y: number) => {
			if (Math.abs(x - startX) > 10 || Math.abs(y - startY) > 10) moved = true;
		};
		const up = (x: number) => {
			if (moved || Date.now() - startT > 350) return;
			// страховка от задвоенных событий: один тап — одно перелистывание
			if (Date.now() - lastTurnT < 250) return;
			try {
				const sel = win.getSelection?.();
				if (sel && !sel.isCollapsed) return; // идёт выделение
				if (this.selectionBar?.isShown()) return; // открыта панель выделения
				const mgr = this.rd()?.manager;
				const containerEl: HTMLElement | undefined = mgr?.container;
				// scroll mode: iframe width matches viewport
				// paginated mode: iframe is wider than container (all pages
				// side by side), adjust by scrollLeft to get visible position
				const w = this.plugin.settings.readingMode === "scroll"
				? (win.innerWidth || 0)
				: (containerEl?.offsetWidth ?? 0);
				if (!w) return;
				const visX = this.plugin.settings.readingMode === "scroll"
				? x
				: x - (containerEl?.scrollLeft ?? 0);
				const band = Platform.isMobile ? 0.26 : 0.2;
				if (visX < w * band) {
					lastTurnT = Date.now();
					this.turnPageDir("prev");
				} else if (visX > w * (1 - band)) {
					lastTurnT = Date.now();
					this.turnPageDir("next");
				}
			} catch {
				/* noop */
			}
		};
		// pointer-события едины для пальца/пера/мыши — в отличие от связки
		// touch+mouse, где браузер досылает «синтетические» события мыши
		// после тапа и одно касание листало страницу дважды
		doc.addEventListener(
			"pointerdown",
			(e: PointerEvent) => {
				if (!e.isPrimary) {
					moved = true; // второй палец = жест, не тап
					return;
				}
				down(e.clientX, e.clientY);
			},
			{ passive: true }
		);
		doc.addEventListener(
			"pointermove",
			(e: PointerEvent) => {
				if (e.buttons > 0) move(e.clientX, e.clientY);
			},
			{ passive: true }
		);
		doc.addEventListener(
			"pointerup",
			(e: PointerEvent) => {
				if (e.isPrimary) up(e.clientX);
			},
			{ passive: true }
		);
	}

	// штатный next() у epub.js при неровной ширине контента пропускает
	// неполную последнюю страницу главы: его проверка «есть ли ещё страница»
	// требует ровно целую. Если впереди остался кусок меньше страницы —
	// докручиваем к нему сами вместо прыжка в следующую главу
	async turnNext() {
		if (!this.rendition) return;
		try {
			const mgr = this.rd()?.manager;
			const container: HTMLElement | undefined = mgr?.container;
			const delta = Number(mgr?.layout?.delta ?? 0);
			const rtl = mgr?.settings?.direction === "rtl";
			if (container && delta > 0 && !rtl) {
				const remaining =
					container.scrollWidth - (container.scrollLeft + container.offsetWidth);
				if (remaining > 2 && remaining < delta) {
					mgr?.scrollBy?.(delta, 0, true); // прокрутка сама обрежется по краю контента
					window.setTimeout(() => {
						try {
							this.rd()?.reportLocation?.();
						} catch {
							/* noop */
						}
					}, 60);
					return;
				}
			}
		} catch {
			/* noop — падаем на штатное перелистывание */
		}
		await this.rendition.next();
	}

	// лёгкая анимация перелистывания — опция, по умолчанию выключена
	animateTurn(dir: "prev" | "next") {
		if (!this.plugin.settings.turnAnimation) return;
		const el = this.contentEl.querySelector<HTMLElement>(".tome-reader");
		if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		el.removeClass("tome-turn-next");
		el.removeClass("tome-turn-prev");
		void el.offsetWidth; // перезапуск CSS-анимации
		const cls = dir === "next" ? "tome-turn-next" : "tome-turn-prev";
		el.addClass(cls);
		window.setTimeout(() => el.removeClass(cls), 240);
	}

	// правка опечаток: заменяем фрагмент прямо в html-файле внутри epub-архива
	async addEditToBook(newText: string) {
		const L = this.plugin.t();
		if (!this.pendingSelection || !this.file || !this.book) return;
		if (!newText || newText === this.pendingSelection) {
			this.hideSelection();
			return;
		}
		try {
			const loc = this.rd()?.currentLocation?.();
			const sec = this.findSpineItem(String(loc?.start?.href ?? ""));
			if (!sec?.href) throw new Error(L.editNotFound);
			const data = await this.app.vault.readBinary(this.file);
			const zip = await JSZip.loadAsync(data);
			// файл главы внутри архива ищем по хвосту пути
			const target = Object.keys(zip.files).find((n) => this.samePath(n, String(sec.href)));
			if (!target) throw new Error(L.editNotFound);
			const html = await zip.files[target].async("string");
			// точное совпадение (с гибкими пробелами); правим только уникальный фрагмент
			const esc = this.pendingSelection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const re = new RegExp(esc.replace(/\s+/g, "\\s+"), "g");
			const matches = html.match(re);
			if (!matches || matches.length === 0) {
				new Notice(L.editNotFound);
				return;
			}
			if (matches.length > 1) {
				new Notice(L.editAmbiguous);
				return;
			}
			zip.file(target, html.replace(re, () => newText));
			const out = await zip.generateAsync({
				type: "arraybuffer",
				compression: "DEFLATE",
				compressionOptions: { level: 6 },
			});
			await this.app.vault.modifyBinary(this.file, out);
			new Notice(L.editSaved);
			// перечитываем книгу; позиция вернётся из сохранённого CFI
			await this.onLoadFile(this.file);
		} catch (e) {
			new Notice(L.editFail + String((e as Error)?.message ?? e));
		}
	}

	async realignPage() {
		const loc = this.rd()?.currentLocation?.();
		const cfi = loc?.start?.cfi;
		if (cfi) {
			try {
				await this.rendition?.display(cfi);
			} catch {
				/* noop */
			}
		}
	}

	async ensureFolder(path: string) {
		const parts = normalizePath(path).split("/");
		let cur = "";
		for (const p of parts) {
			cur = cur ? cur + "/" + p : p;
			if (!this.app.vault.getAbstractFileByPath(cur)) {
				try {
					await this.app.vault.createFolder(cur);
				} catch {
					/* уже есть */
				}
			}
		}
	}

	async appendToFile(file: TFile, block: string, marker?: string) {
		await this.app.vault.process(file, (content) => {
			if (marker && content.includes(marker)) {
				const at = content.indexOf(marker) + marker.length;
				return content.slice(0, at) + "\n\n" + block + content.slice(at);
			}
			return content.trimEnd() + "\n\n" + block + "\n";
		});
	}

	async getOrCreateBookNote(): Promise<TFile | null> {
		if (!this.file) return null;
		const s = this.plugin.settings;
		const L = this.plugin.t();
		await this.ensureFolder(s.noteFolder);
		const notePath = normalizePath(`${s.noteFolder}/${this.file.basename}.md`);
		let note = this.app.vault.getAbstractFileByPath(notePath) as TFile | null;
		if (!note) {
			const initial = [
				"---",
				`created: ${window.moment().format("YYYY-MM-DD")}`,
				"type: book",
				"tags:",
				"  - book",
				"---",
				"",
				L.noteIntro(this.file.basename),
				"",
				L.noteHeading,
				"",
			].join("\n");
			note = await this.app.vault.create(notePath, initial);
		}
		return note;
	}

	async addSelectionToNote(comment: string) {
		if (!this.pendingSelection || !this.file) return;
		const L = this.plugin.t();
		const note = await this.getOrCreateBookNote();
		if (!note) return;
		const src = this.pendingChapter || this.currentChapter || "—";
		const quote = this.pendingSelection
			.split("\n")
			.map((l) => "> " + l)
			.join("\n");
		let block = `${quote}\n> — *${src}*`;
		if (comment) block += `\n\n💭 *${comment}*`;
		await this.appendToFile(note, block, L.noteHeading);
		new Notice(L.nAddedNote(this.file.basename, Boolean(comment)));
		this.hideSelection();
	}

	async addSelectionToDict(translation: string) {
		if (!this.pendingSelection || !this.file) return;
		const s = this.plugin.settings;
		const L = this.plugin.t();
		if (s.dictFiles.length === 0) {
			new Notice(L.dictNone);
			return;
		}
		const path =
			this.selDictPath && s.dictFiles.includes(this.selDictPath)
				? this.selDictPath
				: s.dictFiles[0];
		const dict = this.app.vault.getAbstractFileByPath(normalizePath(path)) as TFile | null;
		if (!dict) {
			new Notice(L.dictMissing(path));
			return;
		}
		const word = this.pendingSelection.replace(/\s+/g, " ").trim();
		const line = `- **${word}**:::${translation || "❓"}`;
		await this.appendToFile(dict, line, "## 📥 Словарь");
		s.lastDict = path;
		await this.plugin.saveSettings();
		new Notice(L.nAddedDict(word.length > 30 ? word.slice(0, 30) + "…" : word, translation));
		this.hideSelection();
	}

	// ─────────────────── прогресс / TOC / оформление ───────────────────

	updateProgress(location: EpubLocation | undefined) {
		const href: string | undefined = location?.start?.href;
		let label = "";
		if (href && this.book) {
			try {
				label = this.book.navigation?.get(href)?.label?.trim() ?? "";
			} catch {
				label = "";
			}
			if (!label && this.flatTocGenerated) {
				const gi = this.genTocCurrentIndex(href, String(location?.start?.cfi ?? ""));
				if (gi >= 0) label = this.flatToc[gi].label;
			}
			if (!label) {
				const hit = this.flatToc.find((en) => this.samePath(en.href.split("#")[0], href));
				if (hit) label = hit.label;
			}
		}
		// TOC не знает этот файл — оставляем последнюю известную главу
		if (label) this.currentChapter = label;
		if (this.chapterEl) this.chapterEl.setText(this.currentChapter);

		if (!this.progressEl) return;
		if (this.locationsReady && this.book) {
			const cfi = location?.start?.cfi;
			if (cfi) {
				const pct = this.book.locations.percentageFromCfi(cfi);
				if (typeof pct === "number" && !isNaN(pct)) {
					this.progressEl.setText(Math.round(pct * 100) + "%");
					return;
				}
			}
		}
		this.progressEl.setText("");
	}

	// ── собственная панель оглавления: системное меню Obsidian на мобильном
	// с сотнями пунктов срабатывает не по тому пункту, поэтому список свой ──

	buildTocPanel(parent: HTMLElement) {
		const L = this.plugin.t();
		const panel = parent.createDiv({ cls: "tome-toc-panel" });
		panel.hide();
		this.tocPanel = panel;

		const head = panel.createDiv({ cls: "tome-toc-head" });
		head.createDiv({ cls: "tome-toc-head-title", text: L.toc });
		const closeBtn = head.createEl("button", { cls: "tome-btn", text: "✕" });
		closeBtn.onclick = () => this.hideToc();

		const filter = panel.createEl("input", { cls: "tome-input tome-toc-filter" });
		filter.type = "text";
		filter.placeholder = L.tocFilter;
		this.tocFilterEl = filter;
		filter.oninput = () => {
			const q = filter.value.trim().toLowerCase();
			this.tocListEl?.querySelectorAll<HTMLElement>(".tome-toc-item").forEach((el) => {
				el.toggle(!q || (el.textContent ?? "").toLowerCase().includes(q));
			});
		};

		// закладки закреплены между поиском и списком глав — всегда на виду
		this.tocBmWrapEl = panel.createDiv({ cls: "tome-toc-bmwrap" });
		this.tocBmWrapEl.hide();

		this.tocListEl = panel.createDiv({ cls: "tome-toc-list" });
	}

	toggleToc() {
		if (!this.tocPanel) return;
		if (this.tocPanel.isShown()) {
			this.hideToc();
			return;
		}
		this.aaPanel?.hide();
		if (this.tocFilterEl) this.tocFilterEl.value = "";
		this.renderTocList();
		this.tocPanel.show();
		const cur = this.tocListEl?.querySelector<HTMLElement>(".is-current");
		cur?.scrollIntoView({ block: "center" });
	}

	hideToc() {
		this.tocPanel?.hide();
	}

	renderTocList() {
		const list = this.tocListEl;
		if (!list) return;
		list.empty();
		const L = this.plugin.t();
		// закладки — в закреплённом блоке, не прокручиваются вместе с главами
		const bmWrap = this.tocBmWrapEl;
		if (bmWrap) {
			bmWrap.empty();
			const bms = this.getBookmarks();
			bmWrap.toggle(bms.length > 0);
			bmWrap.createDiv({ cls: "tome-toc-item tome-toc-section", text: L.bmSection });
			bms.forEach((bm, i) => {
				const row = bmWrap.createDiv({ cls: "tome-toc-item tome-bm-item" });
				row.createSpan({ cls: "tome-bm-label", text: "🔖 " + (bm.label || "—") });
				const del = row.createEl("button", { cls: "tome-btn tome-bm-del", text: "✕" });
				del.onclick = (ev) => {
					ev.stopPropagation();
					bms.splice(i, 1);
					if (this.file) {
						void this.plugin.bookNoteStorage.persistBookmarks(this.file);
					}
					this.renderTocList();
				};
				row.onclick = () => {
					this.hideToc();
					void this.tryDisplay(bm.cfi);
				};
			});
		}
		const loc = this.rd()?.currentLocation?.();
		const curHref = String(loc?.start?.href ?? "");
		const curCfi = String(loc?.start?.cfi ?? "");
		const currentIdx = this.getCurrentTocIndex(curHref, curCfi);
		this.flatToc.forEach((entry, i) => {
			const row = list.createDiv({ cls: "tome-toc-item", text: entry.label || "—" });
			row.setAttr("data-depth", String(entry.depth));
			if (i === currentIdx) {
				row.addClass("is-current");
			}
			row.onclick = () => {
				this.hideToc();
				void this.displayEntry(entry);
			};
		});
	}

	// запись из собранного оглавления открываем по её CFI, обычную — по href
	async displayEntry(entry: TocEntry) {
		if (entry.cfi) {
			if (await this.tryDisplay(entry.cfi)) {
				this.currentChapter = entry.label;
				this.chapterEl?.setText(entry.label);
				return;
			}
		}
		await this.displayHref(entry.href, entry.label);
	}

	// сканируем файлы книги и строим оглавление по заголовкам:
	// h1–h4 + полностью жирные абзацы вида «Глава 228. Наниматель»
	async generateTocFromHeadings(): Promise<TocEntry[]> {
		if (!this.book) return [];
		const spine = this.bk()?.spine;
		const items: EpubSection[] = spine?.spineItems ?? [];
		const entries: TocEntry[] = [];
		const seen = new Set<string>();
		const chapterRe =
			/^(глава|часть|том|книга|пролог|эпилог|интерлюдия|послесловие|предисловие|chapter|part|book|volume|prologue|epilogue|interlude|act)\b/i;
		const numRe = /^\d{1,4}\s*[.):—-]/;
		for (const sec of items) {
			if (entries.length >= 2000) break;
			try {
				await sec.load?.(this.bk()?.load?.bind(this.book));
				const doc: Document | undefined = sec.document;
				if (!doc?.body) continue;
				const nodes = Array.from(doc.body.querySelectorAll("h1, h2, h3, h4, p"));
				let pendingNum: { el: Element; text: string } | null = null;
				for (const el of nodes) {
					const tag = el.tagName.toLowerCase();
					let text = String(el.textContent ?? "").replace(/\s+/g, " ").trim();
					if (!text || text.length > 120) {
						pendingNum = null;
						continue;
					}
					let isHeading = tag !== "p";
					if (!isHeading) {
						const b = el.querySelector("b, strong");
						const wholeBold =
							b && String(b.textContent ?? "").replace(/\s+/g, " ").trim() === text;
						isHeading = Boolean(wholeBold && (chapterRe.test(text) || numRe.test(text)));
					}
					if (!isHeading) {
						pendingNum = null;
						continue;
					}
					// пара «<h2>227.</h2> + <h3>Изобретатель</h3>» — одна глава
					if (tag !== "p" && /^\d{1,4}\s*[.)]?$/.test(text)) {
						pendingNum = { el, text: text.replace(/\s*[.)]\s*$/, "") };
						continue;
					}
					let anchorEl: Element = el;
					if (pendingNum) {
						text = pendingNum.text + ". " + text;
						anchorEl = pendingNum.el;
						pendingNum = null;
					}
					const key = String(sec.href ?? "") + "#" + text;
					if (seen.has(key)) continue;
					seen.add(key);
					let cfi = "";
					try {
						cfi = String(sec.cfiFromElement?.(anchorEl) ?? "");
					} catch {
						/* noop */
					}
					entries.push({
						label: text,
						href: String(sec.href ?? ""),
						depth: 0,
						cfi: cfi || undefined,
						idx: typeof sec.index === "number" ? sec.index : undefined,
					});
				}
				sec.unload?.();
			} catch {
				/* noop */
			}
		}
		return entries;
	}

	// последняя запись собранного оглавления, которая не позже текущей позиции
	genTocCurrentIndex(curHref: string, curCfi: string): number {
		const item = this.findSpineItem(curHref);
		const curIdx: number = typeof item?.index === "number" ? item.index : -1;
		if (curIdx < 0) return -1;
		let cmp: EpubCFI | null = null;
		try {
			cmp = new EpubCFI();
		} catch {
			/* noop */
		}
		let best = -1;
		for (let i = 0; i < this.flatToc.length; i++) {
			const en = this.flatToc[i];
			if (typeof en.idx !== "number") continue;
			if (en.idx < curIdx) {
				best = i;
				continue;
			}
			if (en.idx === curIdx) {
				if (!en.cfi || !curCfi || !cmp) {
					if (best < 0) best = i;
					continue;
				}
				try {
					if (cmp.compare(en.cfi, curCfi) <= 0) best = i;
				} catch {
					/* noop */
				}
			}
		}
		return best;
	}

	// 0-based index of the current TOC entry, or -1 if the TOC isn't ready or
	// the current position doesn't match any entry (e.g. cover page). Uses the
	// same logic as the TOC panel's current-chapter highlight so chapter counts
	// stay consistent with what the reader sees.
	getCurrentTocIndex(curHref: string, curCfi: string): number {
		if (this.flatToc.length === 0) return -1;
		if (this.flatTocGenerated) {
			return this.genTocCurrentIndex(curHref, curCfi);
		}
		for (let i = 0; i < this.flatToc.length; i++) {
			if (this.samePath(this.flatToc[i].href.split("#")[0], curHref)) {
				return i;
			}
		}
		return -1;
	}

	// главы в EPUB бывают прописаны «кривыми» относительными путями или якорями —
	// цель разрешаем по спайну сами, ничего не угадывая
	async displayHref(href: string, label?: string) {
		if (!this.rendition || !this.book || !href) return;
		const hashAt = href.indexOf("#");
		const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
		const frag = hashAt >= 0 ? href.slice(hashAt + 1) : "";
		const section = this.findSpineItem(path);

		const candidates: string[] = [];
		if (section?.href) {
			candidates.push(frag ? section.href + "#" + frag : section.href);
			if (frag) candidates.push(section.href);
		} else if (!/^\d+$/.test(href)) {
			// сырой href — последняя надежда; чисто числовую строку epub.js
			// трактует как индекс спайна, поэтому её не пропускаем
			candidates.push(href);
			if (path && path !== href) candidates.push(path);
		}

		for (const c of candidates) {
			if (await this.tryDisplay(c)) {
				if (label) {
					this.currentChapter = label;
					this.chapterEl?.setText(label);
				}
				// якорь внутри большого файла: уточняем позицию после раскладки
				if (frag && c.indexOf("#") >= 0) await this.settleAnchor(frag, c);
				return;
			}
		}
		new Notice(this.plugin.t().tocFail);
	}

	async tryDisplay(target: string): Promise<boolean> {
		try {
			await this.rendition!.display(target);
			return true;
		} catch {
			return false;
		}
	}

	normPath(p: unknown): string {
		let s = String(p ?? "");
		try {
			s = decodeURIComponent(s);
		} catch {
			/* оставляем как есть */
		}
		return s
			.replace(/\\/g, "/")
			.toLowerCase()
			.split("/")
			.filter((seg) => seg && seg !== "." && seg !== "..")
			.join("/");
	}

	samePath(a: string, b: string): boolean {
		const na = this.normPath(a);
		const nb = this.normPath(b);
		return Boolean(na) && Boolean(nb) && (na === nb || na.endsWith("/" + nb) || nb.endsWith("/" + na));
	}

	// строгий поиск файла спайна: точное совпадение → совпадение по границе
	// сегмента → равенство имени файла (никаких «похожих хвостов»)
	findSpineItem(path: string): EpubSection | null {
		const spine = this.bk()?.spine;
		const items: EpubSection[] = spine?.spineItems ?? spine?.items ?? [];
		const target = this.normPath(path);
		if (!target) return null;
		let match = items.find((it) => this.normPath(it?.href) === target);
		if (!match)
			match = items.find((it) => {
				const h = this.normPath(it?.href);
				return h.length > 0 && (h.endsWith("/" + target) || target.endsWith("/" + h));
			});
		if (!match) {
			const base = target.split("/").pop() ?? "";
			if (base) match = items.find((it) => this.normPath(it?.href).split("/").pop() === base);
		}
		return match ?? null;
	}

	// после перехода по якорю страница могла разложиться уже после расчёта
	// позиции (медленные устройства) — повторно наводимся на сам элемент главы
	async settleAnchor(frag: string, target: string) {
		await new Promise((r) => window.setTimeout(r, 180));
		try {
			const contents: EpubContents[] = this.rd()?.getContents?.() ?? [];
			for (const c of contents) {
				const doc: Document | undefined = c?.document;
				if (!doc) continue;
				const el =
					doc.getElementById(frag) ??
					doc.querySelector(`a[name="${frag.replace(/"/g, '\\"')}"]`);
				if (el && typeof c.cfiFromNode === "function") {
					const cfi = c.cfiFromNode(el);
					if (cfi && (await this.tryDisplay(String(cfi)))) return;
				}
			}
			await this.tryDisplay(target);
		} catch {
			/* noop */
		}
	}

	async applyAppearance(redisplay: boolean) {
		if (!this.rendition) return;
		const s = this.plugin.settings;
		const t = THEMES[s.theme];
		const textColor = s.customTextColor || t.color;
		const isScroll = s.readingMode === "scroll";
		const body: Record<string, string> = {
			background: t.background,
			color: textColor,
			"line-height": String(s.lineHeight),
			// left/right: epub.js sets padding inline without !important in scroll
			// mode (size() shorthand) and with !important in paginated (columns()),
			// so CSS !important covers scroll, and gap update covers paginated
			"padding-left": s.paddingX + "px !important",
			"padding-right": s.paddingX + "px !important",
		};
		if (!isScroll) {
			// paginated: epub.js sets top/bottom to "20px" without !important,
			// so CSS !important in themes.default overrides them
			body["padding-top"] = s.paddingTop + "px !important";
			body["padding-bottom"] = s.paddingBottom + "px !important";
		}
		if (s.fontFamily.trim()) body["font-family"] = s.fontFamily.trim();
		const pStyles: Record<string, string> = {
			color: textColor,
			"line-height": String(s.lineHeight),
			"text-align": s.justifyText ? "justify" : "unset",
		};
		this.rendition.themes.default({
			body,
			"p, div, span, li": pStyles,
			a: { color: t.accent },
			"a:visited": { color: t.accent },
			"::selection": { background: t.accent, color: t.background },
		});
		this.rendition.themes.fontSize(s.fontSize + "px");

		// scroll mode: top/bottom padding must stay fixed on screen regardless of
		// scroll position. Apply it to readerEl (the non-scrolling parent of the
		// epub.js container). CSS .tome-reader has box-sizing: border-box and
		// .epub-container has height:100% !important, so the container shrinks to
		// the content box. updateLayout() → stage.size() reads container.clientHeight
		// from the DOM, picking up the reduced height automatically.
		const readerEl = this.contentEl.querySelector<HTMLElement>(".tome-reader");
		if (readerEl) {
			if (isScroll) {
				readerEl.style.paddingTop = s.paddingTop + "px";
				readerEl.style.paddingBottom = s.paddingBottom + "px";
			} else {
				readerEl.style.paddingTop = "";
				readerEl.style.paddingBottom = "";
			}
		}

		// left/right: epub.js sets gap/2 with !important inline via columns().
		// Update the gap on the manager and trigger re-layout so all views
		// get the new padding from columns() itself. In scroll mode, updateLayout
		// also picks up the reduced container height from readerEl padding.
		const mgr = this.rd()?.manager;
		if (mgr?.settings) {
			mgr.settings.gap = s.paddingX * 2;
			mgr.updateLayout?.();
		}

		this.contentEl.setAttr("data-tome-theme", s.theme);
		this.contentEl.style.setProperty("--tome-bg", t.background);
		this.contentEl.style.setProperty("--tome-fg", textColor);
		this.contentEl.style.setProperty("--tome-accent", t.accent);

		if (redisplay) {
			const loc = this.rd()?.currentLocation?.();
			const cfi = loc?.start?.cfi;
			if (cfi) await this.rendition.display(cfi);
		}
	}

	async closeBook() {
		await this.progressSync.flushAndReset();
		this.resizeObs?.disconnect();
		this.resizeObs = null;
		try {
			this.rendition?.destroy();
		} catch {
			/* noop */
		}
		try {
			this.book?.destroy();
		} catch {
			/* noop */
		}
		this.rendition = null;
		this.book = null;
		this.locationsReady = false;
		this.pendingSelection = "";
		this.pendingContext = "";
		this.currentChapter = "";
		this.flatToc = [];
		this.flatTocGenerated = false;
		this.aiAnswer = "";
		this.aiBusy = false;
		this.lastCfi = "";
	}

	async onUnloadFile(file: TFile): Promise<void> {
		await this.closeBook();
		this.contentEl.empty();
	}

	async onClose(): Promise<void> {
		await this.closeBook();
	}
}

class TomeSettingTab extends PluginSettingTab {
	plugin: TomePlugin;

	constructor(app: App, plugin: TomePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const L = this.plugin.t();

		new Setting(containerEl)
			.setName(L.stLanguage)
			.setDesc(L.stLanguageDesc)
			.addDropdown((dd) =>
				dd
					.addOption("en", "English")
					.addOption("ru", "Русский")
					.setValue(this.plugin.settings.language)
					.onChange((v) => {
						this.plugin.settings.language = v as Lang;
						void this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName(L.stTheme)
			.setDesc(L.stThemeDesc)
			.addDropdown((dd) => {
				(Object.keys(THEMES) as TomeTheme[]).forEach((key) =>
					dd.addOption(key, L.themes[key])
				);
				dd.setValue(this.plugin.settings.theme).onChange((v) => {
					this.plugin.settings.theme = v as TomeTheme;
					void this.plugin.saveSettings();
					this.plugin.applySettingsToOpenViews();
				});
			});

		new Setting(containerEl)
			.setName(L.stFontSize)
			.addSlider((sl) =>
				sl
					.setLimits(12, 36, 1)
					.setValue(this.plugin.settings.fontSize)
					.onChange((v) => {
						this.plugin.settings.fontSize = v;
						void this.plugin.saveSettings();
						this.plugin.applySettingsToOpenViews();
					})
			);

		new Setting(containerEl)
			.setName(L.stLineHeight)
			.addSlider((sl) =>
				sl
					.setLimits(1.1, 2.4, 0.1)
					.setValue(this.plugin.settings.lineHeight)
					.onChange((v) => {
						this.plugin.settings.lineHeight = v;
						void this.plugin.saveSettings();
						this.plugin.applySettingsToOpenViews();
					})
			);

		new Setting(containerEl)
			.setName(L.stFont)
			.setDesc(L.stFontDesc)
			.addText((tx) =>
				tx
					.setPlaceholder(L.stFontPh)
					.setValue(this.plugin.settings.fontFamily)
					.onChange((v) => {
						this.plugin.settings.fontFamily = v;
						void this.plugin.saveSettings();
						this.plugin.applySettingsToOpenViews();
					})
			);

		new Setting(containerEl)
			.setName(L.stTurnAnim)
			.setDesc(L.stTurnAnimDesc)
			.addToggle((tg) =>
				tg.setValue(this.plugin.settings.turnAnimation).onChange((v) => {
					this.plugin.settings.turnAnimation = v;
					void this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(L.stReadingMode)
			.setDesc(L.stReadingModeDesc)
			.addDropdown((dd) =>
				dd
					.addOption("paginated", L.stReadingModePaginated)
					.addOption("scroll", L.stReadingModeScroll)
					.setValue(this.plugin.settings.readingMode)
					.onChange((v) => {
						this.plugin.settings.readingMode = v as ReadingMode;
						void this.plugin.saveSettings();
						this.plugin.reloadAllOpenViews();
					})
			);

		new Setting(containerEl)
			.setName(L.stNoteFolder)
			.setDesc(L.stNoteFolderDesc)
			.addText((tx) =>
				tx
					.setValue(this.plugin.settings.noteFolder)
					.onChange((v) => {
						this.plugin.settings.noteFolder = v.trim() || DEFAULT_SETTINGS.noteFolder;
						void this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(L.stJustifyText)
			.setDesc(L.stJustifyTextDesc)
			.addToggle((tg) =>
				tg.setValue(this.plugin.settings.justifyText).onChange((v) => {
					this.plugin.settings.justifyText = v;
					void this.plugin.saveSettings();
					this.plugin.applySettingsToOpenViews();
				})
			);

		new Setting(containerEl)
			.setName(L.stPadding)
			.setDesc(L.stPaddingDesc)
			.setHeading();

		const paddingSides: { key: keyof TomeSettings; label: string }[] = [
			{ key: "paddingTop", label: L.stPaddingTop },
			{ key: "paddingBottom", label: L.stPaddingBottom },
			{ key: "paddingX", label: L.stPaddingX },
		];
		for (const side of paddingSides) {
			new Setting(containerEl)
				.setName(side.label)
				.addText((tx) => {
					tx.inputEl.type = "number";
					tx.setValue(String(this.plugin.settings[side.key]));
					tx.onChange((v) => {
						const n = Math.max(0, Math.min(100, parseFloat(v) || 0));
						(this.plugin.settings[side.key] as number) = n;
						void this.plugin.saveSettings();
						this.plugin.applySettingsToOpenViews();
					});
				});
		}

		new Setting(containerEl).setName(L.stDicts).setDesc(L.stDictsDesc).setHeading();

		this.plugin.settings.dictFiles.forEach((path, idx) => {
			new Setting(containerEl).addText((tx) => {
				tx.inputEl.addClass("tome-input-wide");
				tx.setValue(path).onChange((v) => {
					this.plugin.settings.dictFiles[idx] = v.trim();
					void this.plugin.saveSettings();
				});
			}).addExtraButton((btn) =>
				btn
					.setIcon("x")
					.setTooltip("✕")
					.onClick(() => {
						this.plugin.settings.dictFiles.splice(idx, 1);
						void this.plugin.saveSettings();
						this.display();
					})
			);
		});

		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText(L.addDict).onClick(() => {
				this.plugin.settings.dictFiles.push("");
				void this.plugin.saveSettings();
				this.display();
			})
		);

		new Setting(containerEl).setName(L.stAi).setDesc(L.stAiDesc).setHeading();

		new Setting(containerEl).setName(L.stAiPreset).addDropdown((dd) => {
			dd.addOption("", L.stAiOff)
				.addOption("groq", "Groq")
				.addOption("openai", "OpenAI")
				.addOption("openrouter", "OpenRouter")
				.addOption("anthropic", "Anthropic (Claude)")
				.addOption("custom", L.stAiCustom)
				.setValue(this.plugin.settings.aiPreset)
				.onChange((v) => {
					this.plugin.settings.aiPreset = v;
					const p = AI_PRESETS[v];
					if (p) {
						if (p.url) this.plugin.settings.aiBaseUrl = p.url;
						if (p.model) this.plugin.settings.aiModel = p.model;
					}
					void this.plugin.saveSettings();
					this.display();
				});
		});

		if (this.plugin.settings.aiPreset) {
			new Setting(containerEl).setName(L.stAiUrl).addText((tx) => {
				tx.inputEl.addClass("tome-input-wide");
				tx.setValue(this.plugin.settings.aiBaseUrl).onChange((v) => {
					this.plugin.settings.aiBaseUrl = v.trim();
					void this.plugin.saveSettings();
				});
			});

			new Setting(containerEl)
				.setName(L.stAiModel)
				.setDesc(L.stAiModelDesc)
				.addText((tx) =>
					tx.setValue(this.plugin.settings.aiModel).onChange((v) => {
						this.plugin.settings.aiModel = v.trim();
						void this.plugin.saveSettings();
					})
				);

			new Setting(containerEl)
				.setName(L.stAiKey)
				.setDesc(L.stAiKeyDesc)
				.addText((tx) => {
					tx.inputEl.type = "password";
					tx.inputEl.addClass("tome-input-wide");
					tx.setValue(this.plugin.settings.aiKey).onChange((v) => {
						this.plugin.settings.aiKey = v.trim();
						void this.plugin.saveSettings();
					});
				});

			new Setting(containerEl).addButton((btn) =>
				btn.setButtonText(L.stAiTest).onClick(() => {
					void this.testConnection(btn);
				})
			);
		}
	}

	async testConnection(btn: ButtonComponent) {
		const L = this.plugin.t();
		btn.setDisabled(true);
		try {
			const reply = await this.plugin.aiChat(
				"You are a connectivity test. Reply with exactly: OK",
				"ping"
			);
			new Notice(L.stAiTestOk + reply.slice(0, 40));
		} catch (e) {
			new Notice("Tome AI: " + String((e as Error)?.message ?? e));
		} finally {
			btn.setDisabled(false);
		}
	}
}
