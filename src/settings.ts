import joplin from 'api';
import { SettingItemType } from 'api/types';
import { getNotebookPaths, NotebookPath } from './stream';

const SETTINGS_SECTION = 'streamTimeline';

const DEFAULT_MAX_ENTRIES = 30;

/** Above this, a refresh renders enough notes to be felt. */
export const MAX_ENTRIES_LIMIT = 100;

/** Special source id meaning every notebook is merged into one stream. */
export const ALL_FOLDERS = '__all__';

/** Special source id backed by a normal Joplin tag rather than a notebook. */
export const BOOKMARKED_SOURCE = '__bookmarked__';

/** Dedicated Joplin tag used by the Bookmarked Stream source. */
export const BOOKMARK_TAG_TITLE = 'Bookmarked';

export enum SettingKey {
	// Keep the stored key for compatibility with profiles created by Journal Timeline.
	SourceId = 'folderId',
	MaxEntries = 'maxEntries',
	ShowImages = 'showImages',
	// Private: lets us show the panel on the very first run without overriding
	// the user's choice to hide it on every subsequent start.
	PanelIntroduced = 'panelIntroduced',
}

export interface StreamSettings {
	sourceId: string;
	maxEntries: number;
	showImages: boolean;
}

export const buildSourceOptions = (notebooks: NotebookPath[], selectedId: string): Record<string, string> => {
	const options: Record<string, string> = {
		[ALL_FOLDERS]: 'All notebooks',
		[BOOKMARKED_SOURCE]: 'Bookmarked',
	};

	for (const notebook of notebooks) options[notebook.id] = notebook.path;

	// A <select> whose value matches no option renders blank, which looks like
	// the setting was lost. Keep a placeholder for a notebook that has gone.
	if (selectedId && !options[selectedId]) {
		options[selectedId] = '(the selected notebook no longer exists)';
	}

	return options;
};

const sourceSetting = (sourceOptions: Record<string, string>) => ({
	value: ALL_FOLDERS,
	type: SettingItemType.String,
	section: SETTINGS_SECTION,
	public: true,
	isEnum: true,
	options: sourceOptions,
	label: 'Stream source',
	description: `Choose one notebook, merge every notebook, or show notes carrying the "${BOOKMARK_TAG_TITLE}" tag.`,
});

export const registerSettings = async () => {
	await joplin.settings.registerSection(SETTINGS_SECTION, {
		label: 'Stream Timeline',
		iconName: 'fas fa-book-open',
		description: 'Continuous timeline for notes ordered by their user-created time.',
	});

	await joplin.settings.registerSettings({
		[SettingKey.SourceId]: sourceSetting(buildSourceOptions(await getNotebookPaths(), '')),

		// Deliberately a String rather than an Int. Joplin renders Int settings
		// as a controlled <input type="number"> whose value is pushed back from
		// state on every keystroke, so clearing the field writes 0 and the "0"
		// reappears immediately - you cannot simply type a new number over it.
		// A plain text field behaves, and the value is validated below anyway.
		[SettingKey.MaxEntries]: {
			value: '30',
			type: SettingItemType.String,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Entries per page',
			description: `How many entries are loaded at a time, up to ${MAX_ENTRIES_LIMIT}. Each one is rendered in full, so large pages make loading slower. Set to 0 to use the maximum page size (${MAX_ENTRIES_LIMIT}).`,
		},

		[SettingKey.ShowImages]: {
			value: true,
			type: SettingItemType.Bool,
			section: SETTINGS_SECTION,
			public: true,
			label: 'Show images in entries',
			description: 'Turn this off to hide attached images in the panel. The notes themselves are not changed - images still appear in the editor and the note viewer.',
		},

		[SettingKey.PanelIntroduced]: {
			value: false,
			type: SettingItemType.Bool,
			public: false,
			label: 'Panel has been shown once',
		},
	});
};

export const getSettings = async (): Promise<StreamSettings> => {
	const values = await joplin.settings.values([
		SettingKey.SourceId,
		SettingKey.MaxEntries,
		SettingKey.ShowImages,
	]);

	return {
		sourceId: `${values[SettingKey.SourceId] ?? ''}`.trim() || ALL_FOLDERS,
		maxEntries: parseMaxEntries(values[SettingKey.MaxEntries]),
		showImages: values[SettingKey.ShowImages] !== false,
	};
};

/**
 * The setting is free text, so anything can arrive: 0 means the maximum API
 * page size, a sensible number is capped, and nonsense falls back to default.
 */
export const parseMaxEntries = (raw: unknown): number => {
	const text = `${raw ?? ''}`.trim();
	if (text === '0') return 0;

	const value = Number(text);
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_ENTRIES;

	return Math.min(Math.floor(value), MAX_ENTRIES_LIMIT);
};

export const setSourceId = (sourceId: string) => joplin.settings.setValue(SettingKey.SourceId, sourceId);

// Joplin's own editor font size. This is an internal setting key rather than a
// documented plugin-API constant, so every read of it is defensive.
const EDITOR_FONT_SIZE_KEY = 'style.editor.fontSize';

/**
 * The size notes are read at, in px, or 0 to leave the panel inheriting
 * `--joplin-font-size`.
 *
 * The panel renders note bodies, so it belongs at the editor's size rather than
 * the UI's: `--joplin-font-size` measures menus, the sidebar and the note list,
 * and is usually the smaller of the two. Read separately from `getSettings` so
 * only the render pays for it.
 */
export const getEditorFontSize = async (): Promise<number> => {
	try {
		const [value] = await joplin.settings.globalValues([EDITOR_FONT_SIZE_KEY]);
		const size = Number(value);

		return Number.isFinite(size) && size > 0 ? size : 0;
	} catch (error) {
		// An unknown key throws rather than returning nothing, and a Joplin that
		// renames it must leave the panel readable, not unstyled.
		return 0;
	}
};

let lastOptionsSignature = '';

/**
 * Rebuilds the source dropdown. Joplin calls `options()` when the config screen
 * renders and re-registering a setting replaces its metadata, so this keeps the
 * list in step with notebooks added or removed since startup. The signature
 * check avoids pointless re-registration on every event.
 */
export const refreshSourceOptions = async (): Promise<void> => {
	const notebooks = await getNotebookPaths();
	const { sourceId } = await getSettings();
	const options = buildSourceOptions(notebooks, sourceId);

	const signature = JSON.stringify(options);
	if (signature === lastOptionsSignature) return;
	lastOptionsSignature = signature;

	await joplin.settings.registerSettings({ [SettingKey.SourceId]: sourceSetting(options) });
};
