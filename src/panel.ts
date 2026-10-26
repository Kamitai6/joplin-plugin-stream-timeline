import joplin from 'api';
import { ViewHandle } from 'api/types';
import { findOrCreateTagByTitle, findTagByTitle, getNotebookPaths, getTaggedMembershipSnapshot, getTaggedNoteIdsAtOrAfter, listStreamEntries, listTaggedStreamEntries, setNoteTag, StreamEntry, StreamPage } from './stream';
import { buildErrorHtml, buildPanelHtml, buildStreamEntriesHtml, buildStreamFooterHtml, FolderStatus, StreamSourceOption } from './panelHtml';
import { ALL_FOLDERS, BOOKMARK_TAG_TITLE, BOOKMARKED_SOURCE, getEditorFontSize, getSettings, refreshSourceOptions, setSourceId } from './settings';
import { renderEntryBodies } from './render';

const PANEL_ID = 'streamPanel';

// Note changes arrive in bursts, especially during sync; coalesce them.
const REFRESH_DEBOUNCE_MS = 400;

// The Plugin API exposes the currently selected notebook, but no dedicated
// notebook-selection event. Poll only that lightweight workspace value so a
// click in Joplin's sidebar can drive the Stream even when the notebook is
// empty and therefore changes no note selection.
const FOLDER_WATCH_INTERVAL_MS = 500;

// Tag membership has no dedicated workspace event. Poll only while the
// Bookmarked source is actually visible, and fetch ids only; normal notebook
// streams remain fully event-driven.
const BOOKMARK_WATCH_INTERVAL_MS = 1000;

// Finding a tag requires listing the tag collection. When Bookmarked does not
// exist yet, do that heavier lookup much less often than the normal id probe.
const MISSING_BOOKMARK_TAG_LOOKUP_INTERVAL_MS = 5000;

interface PanelMessage {
	type: 'refresh' | 'loadMore' | 'selectSource' | 'toggleBookmark' | 'openNote' | 'openLink';
	noteId?: string;
	url?: string;
	sourceId?: string;
	bookmarked?: boolean;
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
	console.error(`Stream Timeline: ${context}`, error);
};

/** Resolves the Stream source selector into one or more concrete data sources. */
const resolveSources = async (): Promise<ResolvedSources> => {
	const { sourceId } = await getSettings();
	const folders = await getNotebookPaths();
	const folderLabels = new Map(folders.map(folder => [folder.id, folder.path]));
	const sourceOptions: StreamSourceOption[] = [
		{ id: ALL_FOLDERS, label: 'All notebooks' },
		{ id: BOOKMARKED_SOURCE, label: 'Bookmarked' },
		...folders.map(folder => ({ id: folder.id, label: folder.path })),
	];

	if (sourceId === ALL_FOLDERS) {
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

	if (sourceId === BOOKMARKED_SOURCE) {
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


	const folder = folders.find(candidate => candidate.id === sourceId);
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
	sourceOptions.push({ id: sourceId, label: '(the selected notebook no longer exists)' });
	return {
		sources: [],
		folderLabels,
		label: '(missing notebook)',
		status: 'missing',
		selectedSourceId: sourceId,
		sourceOptions,
		sourceKey: `missing:${sourceId}`,
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

export class StreamPanel {
	private handle: ViewHandle;

	// Renders are serialised: two overlapping setHtml() calls would race and the
	// slower one could overwrite fresher content.
	private rendering = false;
	private renderPending = false;

	private refreshTimer: ReturnType<typeof setTimeout> | null = null;

	// There is no public folder-selection event. Remember the last sidebar
	// notebook observed by selectedFolder() and only act when its id changes.
	// The first value is primed at startup so the persisted Stream source is not
	// overwritten merely because Joplin restored a notebook from last session.
	private observedFolderId = '';
	private folderWatchRunning = false;

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

		// Preserve the saved Stream source at startup. From this point on, a real
		// change in Joplin's sidebar notebook is what drives source synchronisation.
		await this.rememberSelectedFolder();

		// Rendered unconditionally: at startup the panel may not have been added
		// to the app layout yet, and a visibility check would wrongly report it
		// as hidden and leave it blank.
		await this.renderNow();

		setInterval(() => {
			this.checkSelectedFolder().catch(logError('the selected notebook check failed'));
		}, FOLDER_WATCH_INTERVAL_MS);

		setInterval(() => {
			this.checkBookmarkedMembership().catch(logError('the bookmark membership check failed'));
		}, BOOKMARK_WATCH_INTERVAL_MS);
	}

	private async rememberSelectedFolder(): Promise<void> {
		const folder = await joplin.workspace.selectedFolder();
		this.observedFolderId = `${folder?.id ?? ''}`;
	}

	/**
	 * Mirrors a real Joplin sidebar notebook change into the Stream source.
	 * selectedFolder() returns the last notebook while a tag or search is open,
	 * so comparing ids is important: merely selecting another note must not pull
	 * an All notebooks or Bookmarked Stream back to that last notebook.
	 */
	public async checkSelectedFolder(): Promise<void> {
		if (this.folderWatchRunning) return;
		if (!await joplin.views.panels.visible(this.handle)) return;

		this.folderWatchRunning = true;
		try {
			const folder = await joplin.workspace.selectedFolder();
			const folderId = `${folder?.id ?? ''}`;
			if (!folderId || folderId === this.observedFolderId) return;

			this.observedFolderId = folderId;

			// selectedFolder() should name a real notebook, but keep the webview
			// boundary and Joplin state defensive rather than storing an unknown id.
			const folders = await getNotebookPaths();
			if (!folders.some(candidate => candidate.id === folderId)) return;

			const { sourceId } = await getSettings();
			if (sourceId === folderId) return;

			await setSourceId(folderId);
			this.loadedPages = 1;
			await this.render();
		} finally {
			this.folderWatchRunning = false;
		}
	}

	/**
	 * Redraws whether or not anything is known to have changed, and rebuilds the
	 * notebook list with it. Backs the "Refresh Stream Timeline" command and the
	 * retry link shown when a render fails.
	 */
	public async refresh(): Promise<void> {
		await refreshSourceOptions();
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
		await this.checkSelectedFolder();
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

			refreshSourceOptions()
				.catch(logError('could not refresh the notebook list'))
				.then(() => this.render())
				.catch(logError('a scheduled refresh failed'));
		}, REFRESH_DEBOUNCE_MS);
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
		const folders = await getNotebookPaths();
		const folder = folders.find(candidate => candidate.id === sourceId);
		if (sourceId !== ALL_FOLDERS && sourceId !== BOOKMARKED_SOURCE && !folder) return;

		await setSourceId(sourceId);
		this.loadedPages = 1;

		// All notebooks and Bookmarked have no single notebook to select in
		// Joplin's sidebar. For a concrete notebook, use Joplin's openFolder
		// command so the normal sidebar selection follows the Stream selector.
		// Keep Stream selection working even if a future Joplin version removes or
		// changes that internal desktop command.
		if (folder) {
			try {
				await joplin.commands.execute('openFolder', folder.id);
				this.observedFolderId = folder.id;
			} catch (error) {
				logError('could not select the notebook in Joplin')(error);
			}
		}

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
				truncated: this.hasMore,
				showImages,
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
