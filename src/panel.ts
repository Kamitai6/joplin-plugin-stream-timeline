import joplin from 'api';
import { ViewHandle } from 'api/types';
import { findOrCreateFolderByPath, findOrCreateJournalNote, findOrCreateTagByTitle, findTagByTitle, getFolderPaths, getTaggedMembershipSnapshot, getTaggedNoteIdsAtOrAfter, listStreamEntries, listTaggedStreamEntries, setNoteTag, StreamEntry, StreamPage } from './journal';
import { buildErrorHtml, buildPanelHtml, buildStreamEntriesHtml, buildStreamFooterHtml, FolderStatus, StreamSourceOption } from './panelHtml';
import { ALL_FOLDERS, BOOKMARK_TAG_TITLE, BOOKMARKED_SOURCE, CREATE_NEW_FOLDER, getEditorFontSize, getSettings, refreshFolderOptions, setFolderId } from './settings';
import { renderEntryBodies } from './render';
import { parseJournalTitle, todayTitle } from './dates';

const PANEL_ID = 'journalTimelinePanel';

// Note changes arrive in bursts, especially during sync; coalesce them.
const REFRESH_DEBOUNCE_MS = 400;

// Tag membership has no dedicated workspace event. Poll only while the
// Bookmarked source is actually visible, and fetch ids only; normal notebook
// streams remain fully event-driven.
const BOOKMARK_WATCH_INTERVAL_MS = 1000;

// Finding a tag requires listing the tag collection. When Bookmarked does not
// exist yet, do that heavier lookup much less often than the normal id probe.
const MISSING_BOOKMARK_TAG_LOOKUP_INTERVAL_MS = 5000;

interface PanelMessage {
	type: 'refresh' | 'loadMore' | 'selectSource' | 'toggleBookmark' | 'openEntry' | 'openNote' | 'openLink';
	noteId?: string;
	url?: string;
	sourceId?: string;
	bookmarked?: boolean;
	/** Journal title for openEntry, or absent for today. */
	title?: string;
}

interface ResolvedFolder {
	id: string | null;
	label: string;
	status: FolderStatus;
}

interface ResolvedStreamSource {
	id: string;
	kind: 'folder' | 'tag';
	targetId: string;
	label: string;
}

interface ResolvedSources {
	sources: ResolvedStreamSource[];
	folderLabels: Map<string, string>;
	label: string;
	status: FolderStatus;
	selectedSourceId: string;
	sourceOptions: StreamSourceOption[];
	sourceKey: string;
}

const logError = (context: string) => (error: unknown) => {
	console.error(`Journal Timeline: ${context}`, error);
};

/** Works out which notebook the timeline should show, and how to label it. */
const resolveFolder = async (): Promise<ResolvedFolder> => {
	const { folderId, newFolderName } = await getSettings();

	// Stage 4 lets the Stream use every notebook. The journal-era "open today's
	// entry" command still needs one concrete notebook, so All falls back to the
	// configured create-on-demand path rather than pretending All is a folder id.
	if (folderId === CREATE_NEW_FOLDER || folderId === ALL_FOLDERS || folderId === BOOKMARKED_SOURCE) return { id: null, label: newFolderName, status: 'pending' };

	// Looked up through the full list rather than by id so the header can show
	// the same "Parent/Child" path as the settings dropdown.
	const folder = (await getFolderPaths()).find(candidate => candidate.id === folderId);
	if (folder) return { id: folder.id, label: folder.path, status: 'ready' };

	return { id: null, label: newFolderName, status: 'missing' };
};

/** Resolves the Stream source selector into one or more concrete data sources. */
const resolveSources = async (): Promise<ResolvedSources> => {
	const { folderId, newFolderName } = await getSettings();
	const folders = await getFolderPaths();
	const folderLabels = new Map(folders.map(folder => [folder.id, folder.path]));
	const sourceOptions: StreamSourceOption[] = [
		{ id: ALL_FOLDERS, label: 'All notebooks' },
		{ id: BOOKMARKED_SOURCE, label: 'Bookmarked' },
		...folders.map(folder => ({ id: folder.id, label: folder.path })),
	];

	if (folderId === ALL_FOLDERS) {
		return {
			sources: folders.map(folder => ({ id: folder.id, kind: 'folder', targetId: folder.id, label: folder.path })),
			folderLabels,
			label: 'All notebooks',
			status: 'ready',
			selectedSourceId: ALL_FOLDERS,
			sourceOptions,
			sourceKey: `${ALL_FOLDERS}:${folders.map(folder => folder.id).join(',')}`,
		};
	}

	if (folderId === BOOKMARKED_SOURCE) {
		const tag = await findTagByTitle(BOOKMARK_TAG_TITLE);
		return {
			sources: tag ? [{ id: BOOKMARKED_SOURCE, kind: 'tag', targetId: tag.id, label: BOOKMARK_TAG_TITLE }] : [],
			folderLabels,
			label: 'Bookmarked',
			status: 'ready',
			selectedSourceId: BOOKMARKED_SOURCE,
			sourceOptions,
			sourceKey: `${BOOKMARKED_SOURCE}:${tag?.id ?? 'missing'}`,
		};
	}

	if (folderId === CREATE_NEW_FOLDER) {
		return {
			sources: [],
			folderLabels,
			label: newFolderName,
			status: 'pending',
			selectedSourceId: CREATE_NEW_FOLDER,
			sourceOptions,
			sourceKey: CREATE_NEW_FOLDER,
		};
	}

	const folder = folders.find(candidate => candidate.id === folderId);
	if (folder) {
		return {
			sources: [{ id: folder.id, kind: 'folder', targetId: folder.id, label: folder.path }],
			folderLabels,
			label: folder.path,
			status: 'ready',
			selectedSourceId: folder.id,
			sourceOptions,
			sourceKey: folder.id,
		};
	}

	// A <select> cannot display a selected value that has no option. Keep the
	// vanished source visible long enough for the user to choose a replacement.
	sourceOptions.push({ id: folderId, label: '(the selected notebook no longer exists)' });
	return {
		sources: [],
		folderLabels,
		label: newFolderName,
		status: 'missing',
		selectedSourceId: folderId,
		sourceOptions,
		sourceKey: `missing:${folderId}`,
	};
};

const listResolvedSourcePage = async (
	source: ResolvedStreamSource,
	page: number,
	limit: number,
	showFolderLabel: boolean,
	folderLabels: ReadonlyMap<string, string>,
): Promise<StreamPage> => {
	if (source.kind === 'tag') return listTaggedStreamEntries(source.targetId, page, limit, folderLabels);
	return listStreamEntries(source.targetId, page, limit, showFolderLabel ? source.label : '');
};

const streamPageLimit = (maxEntries: number): number => maxEntries > 0 ? Math.min(Math.floor(maxEntries), 100) : 100;

// Array.sort is stable on the JavaScript versions Joplin runs. Returning 0 for
// equal timestamps preserves the already-fetched order at a page boundary, so
// loading an older source page never jumps an existing entry above another one.
const sortStreamEntries = (entries: StreamEntry[]): StreamEntry[] => {
	return entries.sort((a, b) => b.userCreatedTime - a.userCreatedTime);
};

export class JournalPanel {
	private handle: ViewHandle;

	// Renders are serialised: two overlapping setHtml() calls would race and the
	// slower one could overwrite fresher content.
	private rendering = false;
	private renderPending = false;

	private refreshTimer: ReturnType<typeof setTimeout> | null = null;

	// Set when something changed while the panel was hidden, so it can be
	// brought up to date the moment it becomes visible again.
	private stale = false;

	// Joplin always has a note open, so seeding the highlight from the editor
	// meant the panel opened with an entry already picked out - one restored from
	// the last session, that the reader had not chosen and had no reason to be
	// looking at. The highlight is earned by a selection made since startup, not
	// assumed from whatever the app happened to be showing.
	private selectionSeen = false;

	// Stream pages already visible in the panel. A normal refresh rebuilds this
	// many pages so editing or syncing a note does not collapse the reader back
	// to the first page.
	private loadedPages = 1;
	private loadedSourceKey = '';
	private loadedMaxEntries = 0;
	private hasMore = false;
	private loadedNoteIds = new Set<string>();
	private fetchedEntries = new Map<string, StreamEntry>();
	private sourceHasMore = new Map<string, boolean>();
	private loadingMore = false;
	private loadMorePending = false;

	// Bookmark membership is the only data source that needs polling. The id is
	// cached from the last render so the common poll path never lists all tags.
	private activeSourceId = '';
	private bookmarkedTagId: string | null = null;
	private bookmarkTagPromise: Promise<string> | null = null;
	private bookmarkWatchRunning = false;
	private lastMissingBookmarkTagLookup = 0;

	public async create(): Promise<void> {
		this.handle = await joplin.views.panels.create(PANEL_ID);

		// Scripts are loaded once and survive every setHtml(), so this must not
		// be repeated per render.
		await joplin.views.panels.addScript(this.handle, './webview/panel.css');
		await joplin.views.panels.addScript(this.handle, './webview/panel.js');

		await joplin.views.panels.onMessage(this.handle, (message: PanelMessage) => this.onMessage(message));

		// Rendered unconditionally: at startup the panel may not have been added
		// to the app layout yet, and a visibility check would wrongly report it
		// as hidden and leave it blank.
		await this.renderNow();

		setInterval(() => {
			this.checkBookmarkedMembership().catch(logError('the bookmark membership check failed'));
		}, BOOKMARK_WATCH_INTERVAL_MS);
	}

	/**
	 * Redraws whether or not anything is known to have changed, and rebuilds the
	 * notebook list with it. Backs the "Refresh Journal Timeline" command and the
	 * retry link shown when a render fails.
	 */
	public async refresh(): Promise<void> {
		await refreshFolderOptions();
		await this.renderNow();
	}

	/** True when the panel is showing content that is known to be out of date. */
	public get needsRefresh(): boolean {
		return this.stale;
	}

	public async toggle(): Promise<void> {
		if (await joplin.views.panels.visible(this.handle)) {
			await joplin.views.panels.hide(this.handle);
			return;
		}

		await this.show();
	}

	public async show(): Promise<void> {
		await joplin.views.panels.show(this.handle);
		if (this.stale) await this.renderNow();
	}

	/** Redraws the panel, unless it is hidden - then it is redrawn when shown. */
	public async render(): Promise<void> {
		if (!await joplin.views.panels.visible(this.handle)) {
			this.stale = true;
			return;
		}

		await this.renderNow();
	}

	/**
	 * Moves the highlight to whatever is open in the editor. Sent as a message
	 * rather than re-rendered: the selection changes on every click around the
	 * app, and a full refresh for each one would be wasteful and would disturb
	 * the reader's scroll position.
	 */
	public async syncSelection(): Promise<void> {
		this.selectionSeen = true;

		joplin.views.panels.postMessage(this.handle, {
			type: 'selection',
			noteIds: await joplin.workspace.selectedNoteIds(),
		});
	}

	private async ensureBookmarkTagId(): Promise<string> {
		if (this.bookmarkedTagId) return this.bookmarkedTagId;
		if (this.bookmarkTagPromise) return this.bookmarkTagPromise;

		this.bookmarkTagPromise = findOrCreateTagByTitle(BOOKMARK_TAG_TITLE)
			.then(tag => {
				this.bookmarkedTagId = tag.id;
				this.lastMissingBookmarkTagLookup = 0;
				return tag.id;
			})
			.finally(() => {
				this.bookmarkTagPromise = null;
			});

		return this.bookmarkTagPromise;
	}

	private async bookmarkedIdsForEntries(entries: StreamEntry[], sourceId: string): Promise<string[]> {
		if (!entries.length) return [];
		if (sourceId === BOOKMARKED_SOURCE) return entries.map(entry => entry.id);

		if (!this.bookmarkedTagId) {
			const now = Date.now();
			if (now - this.lastMissingBookmarkTagLookup >= MISSING_BOOKMARK_TAG_LOOKUP_INTERVAL_MS) {
				this.lastMissingBookmarkTagLookup = now;
				const tag = await findTagByTitle(BOOKMARK_TAG_TITLE);
				if (tag) {
					this.bookmarkedTagId = tag.id;
					this.lastMissingBookmarkTagLookup = 0;
				}
			}
		}

		if (!this.bookmarkedTagId) return [];

		const oldest = entries.reduce((value, entry) => Math.min(value, entry.userCreatedTime), Number.POSITIVE_INFINITY);
		const tagged = await getTaggedNoteIdsAtOrAfter(this.bookmarkedTagId, Number.isFinite(oldest) ? oldest : 0);
		return entries.filter(entry => tagged.has(entry.id)).map(entry => entry.id);
	}

	private async toggleBookmark(noteId: string, bookmarked: boolean): Promise<{ ok: boolean; bookmarked: boolean }> {
		// The webview boundary is untrusted. Only an entry that is currently loaded
		// in this panel may mutate its Bookmarked membership.
		if (!this.loadedNoteIds.has(noteId)) return { ok: false, bookmarked: !bookmarked };

		let tagId = this.bookmarkedTagId;
		if (bookmarked) {
			tagId = await this.ensureBookmarkTagId();
		} else if (!tagId) {
			const tag = await findTagByTitle(BOOKMARK_TAG_TITLE);
			if (!tag) return { ok: true, bookmarked: false };
			tagId = tag.id;
			this.bookmarkedTagId = tagId;
		}

		await setNoteTag(tagId, noteId, bookmarked);

		// Removing an item from the Bookmarked source changes source membership, so
		// rebuild that Stream. Other sources only need the button state changed.
		if (this.activeSourceId === BOOKMARKED_SOURCE && !bookmarked) this.scheduleRender();

		return { ok: true, bookmarked };
	}

	private async checkBookmarkedMembership(): Promise<void> {
		if (this.activeSourceId !== BOOKMARKED_SOURCE || this.bookmarkWatchRunning || this.rendering || this.loadingMore || this.refreshTimer) return;
		if (!await joplin.views.panels.visible(this.handle)) return;

		this.bookmarkWatchRunning = true;
		try {
			if (!this.bookmarkedTagId) {
				const now = Date.now();
				if (now - this.lastMissingBookmarkTagLookup < MISSING_BOOKMARK_TAG_LOOKUP_INTERVAL_MS) return;
				this.lastMissingBookmarkTagLookup = now;

				const tag = await findTagByTitle(BOOKMARK_TAG_TITLE);
				if (tag) {
					this.bookmarkedTagId = tag.id;
					this.scheduleRender();
				}
				return;
			}

			const snapshot = await getTaggedMembershipSnapshot(this.bookmarkedTagId, this.loadedNoteIds.size);
			const membershipChanged = snapshot.noteIds.length !== this.loadedNoteIds.size
				|| snapshot.noteIds.some(noteId => !this.loadedNoteIds.has(noteId));

			if (membershipChanged || snapshot.hasMore !== this.hasMore) this.scheduleRender();
		} finally {
			this.bookmarkWatchRunning = false;
		}
	}

	/**
	 * Coalesces bursts of events into a single refresh. The notebook dropdown is
	 * rebuilt even when the panel is hidden, so the config screen is current
	 * whenever the user opens it.
	 */
	public scheduleRender(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);

		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;

			refreshFolderOptions()
				.catch(logError('could not refresh the notebook list'))
				.then(() => this.render())
				.catch(logError('a scheduled refresh failed'));
		}, REFRESH_DEBOUNCE_MS);
	}

	/**
	 * Opens the entry for `title`, writing a new note when that day has none.
	 * Defaults to today, which is what the toolbar button and the command ask
	 * for; the date picker names any other day, so an entry missed last week can
	 * be filled in without hand-titling a note.
	 */
	public async openEntry(title: string = todayTitle()): Promise<void> {
		// The title crosses the webview boundary, so it is checked rather than
		// trusted - it ends up as a note title, and "2026-02-31" is not a day.
		if (!parseJournalTitle(title)) return;

		// The panel already renders from resolveFolder, and it answers exactly what
		// is needed here: an id when the notebook exists, otherwise the name to
		// create it under. Asking it again keeps the two from disagreeing about
		// which notebook the journal lives in.
		const settings = await getSettings();
		const resolved = await resolveFolder();
		let folderId = resolved.id;

		if (!folderId) {
			// Creating the notebook is what turns the "create a new notebook" choice
			// into a real selection, so the dropdown is pointed at it straight away.
			folderId = (await findOrCreateFolderByPath(resolved.label)).id;
			// When the Stream is explicitly showing All notebooks, the legacy journal
			// command may create its Journals notebook without changing the Stream
			// source out from under the reader.
			if (settings.folderId !== ALL_FOLDERS && settings.folderId !== BOOKMARKED_SOURCE) await setFolderId(folderId);
			await refreshFolderOptions();
		}

		const noteId = await findOrCreateJournalNote(folderId, title.trim());
		await joplin.commands.execute('openNote', noteId);
		await this.render();
	}

	/** Loads only the next stream page and appends it to the existing webview DOM. */
	public async loadMore(): Promise<void> {
		if (this.loadingMore || !this.hasMore) return;

		if (this.rendering) {
			this.loadMorePending = true;
			return;
		}

		this.loadingMore = true;
		try {
			const { maxEntries } = await getSettings();
			const resolved = await resolveSources();

			// A settings or notebook change can race a click from the old panel. A
			// normal render is the only safe response because page numbers belong to
			// the old source.
			if (resolved.sourceKey !== this.loadedSourceKey || maxEntries !== this.loadedMaxEntries) {
				await this.renderNow();
				return;
			}

			const nextPage = this.loadedPages + 1;
			const activeSources = resolved.sources.filter(source => this.sourceHasMore.get(source.id) === true);
			const showFolderLabels = resolved.selectedSourceId === ALL_FOLDERS;
			const results = await Promise.all(activeSources.map(async source => ({
				source,
				stream: await listResolvedSourcePage(source, nextPage, maxEntries, showFolderLabels, resolved.folderLabels),
			})));

			for (const { source, stream } of results) {
				for (const entry of stream.entries) this.fetchedEntries.set(entry.id, entry);
				this.sourceHasMore.set(source.id, Boolean(stream.hasMore && stream.entries.length));
			}

			const limit = streamPageLimit(maxEntries);
			const visible = sortStreamEntries([...this.fetchedEntries.values()]).slice(0, nextPage * limit);
			const entries = visible.filter(entry => !this.loadedNoteIds.has(entry.id));
			this.loadedNoteIds = new Set(visible.map(entry => entry.id));
			this.loadedPages = nextPage;
			this.hasMore = this.fetchedEntries.size > visible.length || [...this.sourceHasMore.values()].some(Boolean);
			const selectedNoteIds = this.selectionSeen ? await joplin.workspace.selectedNoteIds() : [];
			const bookmarkedNoteIds = await this.bookmarkedIdsForEntries(entries, resolved.selectedSourceId);

			joplin.views.panels.postMessage(this.handle, {
				type: 'appendEntries',
				entriesHtml: buildStreamEntriesHtml(entries, await renderEntryBodies(entries), selectedNoteIds, bookmarkedNoteIds),
				footerHtml: buildStreamFooterHtml(this.hasMore),
			});
		} finally {
			this.loadingMore = false;

			// A note or settings event that arrived while the page was loading is
			// rebuilt afterwards, so an appended page cannot overwrite fresher state.
			if (this.renderPending) {
				this.renderPending = false;
				await this.renderNow();
			}
		}
	}

	private async selectSource(sourceId: string): Promise<void> {
		const folders = await getFolderPaths();
		if (sourceId !== ALL_FOLDERS && sourceId !== BOOKMARKED_SOURCE && !folders.some(folder => folder.id === sourceId)) return;

		await setFolderId(sourceId);
		this.loadedPages = 1;
		await this.renderNow();
	}

	private async renderNow(): Promise<void> {
		if (this.loadingMore) {
			this.renderPending = true;
			return;
		}

		if (this.rendering) {
			this.renderPending = true;
			return;
		}

		this.rendering = true;
		try {
			// Anything that arrived mid-render is drawn on the next pass rather than
			// dropped, so the panel always settles on the newest content.
			do {
				this.renderPending = false;
				await this.setHtml();
			} while (this.renderPending);
		} finally {
			this.rendering = false;
		}

		if (this.loadMorePending) {
			this.loadMorePending = false;
			await this.loadMore();
		}
	}

	private async setHtml(): Promise<void> {
		let label = '';

		try {
			const { maxEntries, showImages } = await getSettings();
			const resolved = await resolveSources();
			label = resolved.label;
			this.activeSourceId = resolved.selectedSourceId;
			if (resolved.selectedSourceId === BOOKMARKED_SOURCE) {
				this.bookmarkedTagId = resolved.sources.find(source => source.kind === 'tag')?.targetId ?? null;
				this.lastMissingBookmarkTagLookup = this.bookmarkedTagId ? 0 : Date.now();
			}

			if (resolved.sourceKey !== this.loadedSourceKey || maxEntries !== this.loadedMaxEntries) {
				this.loadedPages = 1;
			}

			const fetchedEntries = new Map<string, StreamEntry>();
			const sourceHasMore = new Map<string, boolean>();
			let activeSources = [...resolved.sources];
			const showFolderLabels = resolved.selectedSourceId === ALL_FOLDERS;

			for (let page = 1; page <= this.loadedPages && activeSources.length; page++) {
				const results = await Promise.all(activeSources.map(async source => ({
					source,
					stream: await listResolvedSourcePage(source, page, maxEntries, showFolderLabels, resolved.folderLabels),
				})));
				const nextActive: ResolvedStreamSource[] = [];

				for (const { source, stream } of results) {
					for (const entry of stream.entries) fetchedEntries.set(entry.id, entry);
					const sourceMore = Boolean(stream.hasMore && stream.entries.length);
					sourceHasMore.set(source.id, sourceMore);
					if (sourceMore) nextActive.push(source);
				}

				activeSources = nextActive;
			}

			const limit = streamPageLimit(maxEntries);
			const merged = sortStreamEntries([...fetchedEntries.values()]);
			const entries = merged.slice(0, this.loadedPages * limit);

			this.loadedSourceKey = resolved.sourceKey;
			this.loadedMaxEntries = maxEntries;
			this.fetchedEntries = fetchedEntries;
			this.sourceHasMore = sourceHasMore;
			this.loadedNoteIds = new Set(entries.map(entry => entry.id));
			this.hasMore = fetchedEntries.size > entries.length || [...sourceHasMore.values()].some(Boolean);
			const bookmarkedNoteIds = await this.bookmarkedIdsForEntries(entries, resolved.selectedSourceId);

			await joplin.views.panels.setHtml(this.handle, buildPanelHtml({
				folderLabel: resolved.label,
				status: resolved.status,
				entries,
				bodies: await renderEntryBodies(entries),
				todayTitle: todayTitle(),
				maxEntries: limit,
				truncated: this.hasMore,
				showImages,
				onThisDay: [],
				fontSize: await getEditorFontSize(),
				selectedNoteIds: this.selectionSeen ? await joplin.workspace.selectedNoteIds() : [],
				bookmarkedNoteIds,
				selectedSourceId: resolved.selectedSourceId,
				sourceOptions: resolved.sourceOptions,
				emptyNotice: resolved.selectedSourceId === BOOKMARKED_SOURCE
					? `No notes are bookmarked yet. Bookmark a note from another Stream source to see it here.`
					: undefined,
			}));

			this.stale = false;
		} catch (error) {
			// A failed render must still leave the panel usable, otherwise the
			// user is stuck with stale content and no way to retry.
			logError('could not render the panel')(error);
			await joplin.views.panels.setHtml(this.handle, buildErrorHtml(label, `${error?.message ?? error}`));
		}
	}

	private async onMessage(message: PanelMessage): Promise<unknown> {
		if (!message?.type) return;

		try {
			if (message.type === 'refresh') {
				await this.refresh();
			} else if (message.type === 'loadMore') {
				await this.loadMore();
			} else if (message.type === 'selectSource' && message.sourceId) {
				await this.selectSource(message.sourceId);
			} else if (message.type === 'toggleBookmark' && message.noteId && typeof message.bookmarked === 'boolean') {
				return await this.toggleBookmark(message.noteId, message.bookmarked);
			} else if (message.type === 'openEntry') {
				// Undefined for the today button, which is what openEntry defaults to.
				await this.openEntry(message.title);
			} else if (message.type === 'openNote' && message.noteId) {
				await joplin.commands.execute('openNote', message.noteId);
			} else if (message.type === 'openLink' && message.url) {
				// Resolves ":/noteId" links within Joplin, and sends everything
				// else to the system browser or file handler.
				await joplin.commands.execute('openItem', message.url);
			}
		} catch (error) {
			logError(`"${message.type}" failed`)(error);
			if (message.type === 'toggleBookmark' && typeof message.bookmarked === 'boolean') {
				return { ok: false, bookmarked: !message.bookmarked };
			}
		}
	}
}
