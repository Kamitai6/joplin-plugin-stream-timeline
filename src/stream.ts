import joplin from 'api';
export interface Folder {
	id: string;
	title: string;
	parent_id: string;
}

export interface Tag {
	id: string;
	title: string;
}

interface Note {
	id: string;
	title: string;
	parent_id?: string;
	user_created_time?: number;
	updated_time?: number;
}

export interface StreamEntry {
	id: string;
	title: string;
	/** Notebook this entry came from. Used when multiple sources are merged. */
	sourceFolderId?: string;
	/** Full notebook path shown beside entries in an all-notebooks stream. */
	sourceFolderLabel?: string;
	/** The timeline position is fixed by Joplin's user_created_time. */
	userCreatedTime: number;
	/** Part of the render cache key, so an edited entry is re-rendered. */
	updatedTime: number;
}

interface NoteContent {
	body: string;
	/** 1 = Markdown, 2 = HTML. */
	markupLanguage: number;
}

const PAGE_LIMIT = 100;

// Guards against a server that keeps reporting `has_more`; 500 pages is far
// beyond any realistic notebook and stops the loop from hanging Joplin.
const MAX_PAGES = 500;

/**
 * The data API returns at most `limit` items per call, so every listing has to
 * be paged through. Reading only the first page silently hides notebooks and
 * notes once a collection grows past 100 items.
 */
const getAll = async <T>(path: string[], query: Record<string, unknown> = {}): Promise<T[]> => {
	const items: T[] = [];

	for (let page = 1; page <= MAX_PAGES; page++) {
		const response = await joplin.data.get(path, { ...query, page, limit: PAGE_LIMIT });
		const pageItems: T[] = response?.items ?? [];

		items.push(...pageItems);

		if (!response?.has_more || !pageItems.length) break;
	}

	return items;
};

export interface NotebookPath {
	id: string;
	/** Full "Parent/Child" path, used as the dropdown label. */
	path: string;
}

const getFolders = () => getAll<Folder>(['folders'], { fields: ['id', 'title', 'parent_id'] });
const getTags = () => getAll<Tag>(['tags'], { fields: ['id', 'title'] });

/** Finds an existing Joplin tag by title without creating data while rendering. */
export const findTagByTitle = async (title: string): Promise<Tag | null> => {
	const wanted = title.trim().toLowerCase();
	if (!wanted) return null;

	return (await getTags()).find(tag => tag.title.trim().toLowerCase() === wanted) ?? null;
};

/** Finds a tag by title, creating it only when an explicit user action needs it. */
export const findOrCreateTagByTitle = async (title: string): Promise<Tag> => {
	const normalized = title.trim();
	if (!normalized) throw new Error('The tag title is empty.');

	const existing = await findTagByTitle(normalized);
	if (existing) return existing;

	return await joplin.data.post(['tags'], null, { title: normalized }) as Tag;
};

/** Adds or removes one tag without changing any other note metadata. */
export const setNoteTag = async (tagId: string, noteId: string, tagged: boolean): Promise<void> => {
	if (tagged) {
		await joplin.data.post(['tags', tagId, 'notes'], null, { id: noteId });
		return;
	}

	await joplin.data.delete(['tags', tagId, 'notes', noteId]);
};

export interface TaggedMembershipSnapshot {
	noteIds: string[];
	hasMore: boolean;
}

/**
 * Reads only enough tagged note ids to tell whether the currently visible
 * Bookmarked slice changed. Bodies, titles and timestamps are deliberately not
 * requested, keeping the periodic membership probe as small as possible.
 */
export const getTaggedMembershipSnapshot = async (tagId: string, visibleCount: number): Promise<TaggedMembershipSnapshot> => {
	const safeVisibleCount = Math.max(0, Math.floor(visibleCount) || 0);
	const probeCount = safeVisibleCount + 1;
	const requestLimit = Math.min(PAGE_LIMIT, probeCount);
	const noteIds: string[] = [];
	let apiHasMore = false;

	for (let page = 1; noteIds.length < probeCount; page++) {
		const response = await joplin.data.get(['tags', tagId, 'notes'], {
			fields: ['id'],
			page,
			limit: requestLimit,
			order_by: 'user_created_time',
			order_dir: 'DESC',
		});
		const pageItems: Note[] = response?.items ?? [];

		noteIds.push(...pageItems.map(note => note.id));
		apiHasMore = Boolean(response?.has_more);

		if (!apiHasMore || !pageItems.length) break;
	}

	return {
		noteIds: noteIds.slice(0, safeVisibleCount),
		hasMore: noteIds.length > safeVisibleCount || apiHasMore,
	};
};


/**
 * Returns tagged note ids down to the oldest timestamp currently visible in a
 * Stream. Because the tag list uses the same newest-first chronology as the
 * Stream, no older tagged note can match an entry already on screen.
 */
export const getTaggedNoteIdsAtOrAfter = async (tagId: string, oldestUserCreatedTime: number): Promise<Set<string>> => {
	const noteIds = new Set<string>();
	const cutoff = Math.max(0, Number(oldestUserCreatedTime) || 0);

	for (let page = 1; page <= MAX_PAGES; page++) {
		const response = await joplin.data.get(['tags', tagId, 'notes'], {
			fields: ['id', 'user_created_time'],
			page,
			limit: PAGE_LIMIT,
			order_by: 'user_created_time',
			order_dir: 'DESC',
		});
		const pageItems: Note[] = response?.items ?? [];

		for (const note of pageItems) {
			const created = Number(note.user_created_time) || 0;
			if (created < cutoff) return noteIds;
			noteIds.add(note.id);
		}

		if (!response?.has_more || !pageItems.length) break;
	}

	return noteIds;
};

const buildNotebookPath = (folder: Folder, byId: Map<string, Folder>): string => {
	const parts = [folder.title];
	const visited = new Set([folder.id]);
	let current = folder;

	// `visited` guards against a corrupt parent chain looping forever.
	while (current.parent_id && byId.has(current.parent_id) && !visited.has(current.parent_id)) {
		current = byId.get(current.parent_id);
		visited.add(current.id);
		parts.unshift(current.title);
	}

	return parts.join('/');
};

/** Every notebook with its full path, sorted by path. */
export const getNotebookPaths = async (): Promise<NotebookPath[]> => {
	const folders = await getFolders();
	const byId = new Map(folders.map(folder => [folder.id, folder]));

	return folders
		.map(folder => ({ id: folder.id, path: buildNotebookPath(folder, byId) }))
		.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
};


export interface StreamPage {
	entries: StreamEntry[];
	/** Whether Joplin reports another page after this one. */
	hasMore: boolean;
	page: number;
	limit: number;
}

/**
 * Reads one page of notes from a notebook, newest user-created timestamp first.
 * Every note is eligible; Joplin performs the ordering and pagination before
 * anything reaches the panel.
 */
export const listStreamEntries = async (folderId: string, page: number, limit: number, sourceFolderLabel = ''): Promise<StreamPage> => {
	const safePage = Math.max(1, Math.floor(page) || 1);
	// A stream never expands the whole notebook at once, so 0 maps to the
	// largest page the data API allows.
	const safeLimit = limit > 0 ? Math.min(Math.floor(limit), PAGE_LIMIT) : PAGE_LIMIT;

	// Bodies are deliberately not requested here: only the entries that end up
	// on screen are fetched, and only when they are not already rendered.
	const response = await joplin.data.get(['folders', folderId, 'notes'], {
		fields: ['id', 'title', 'user_created_time', 'updated_time'],
		page: safePage,
		limit: safeLimit,
		order_by: 'user_created_time',
		order_dir: 'DESC',
	});
	const notes: Note[] = response?.items ?? [];

	const entries = notes.map(note => {
		const userCreatedTime = Number(note.user_created_time) || 0;
		return {
			id: note.id,
			title: note.title.trim(),
			sourceFolderId: folderId,
			sourceFolderLabel: sourceFolderLabel || undefined,
			userCreatedTime,
			updatedTime: Number(note.updated_time) || 0,
		};
	});

	return {
		entries,
		hasMore: Boolean(response?.has_more),
		page: safePage,
		limit: safeLimit,
	};
};


/**
 * Reads one page of notes carrying a tag. The tag is only the membership rule;
 * chronology still comes from each note's user_created_time, exactly like a
 * notebook-backed Stream source.
 */
export const listTaggedStreamEntries = async (
	tagId: string,
	page: number,
	limit: number,
	folderLabels: ReadonlyMap<string, string> = new Map(),
): Promise<StreamPage> => {
	const safePage = Math.max(1, Math.floor(page) || 1);
	const safeLimit = limit > 0 ? Math.min(Math.floor(limit), PAGE_LIMIT) : PAGE_LIMIT;

	const response = await joplin.data.get(['tags', tagId, 'notes'], {
		fields: ['id', 'parent_id', 'title', 'user_created_time', 'updated_time'],
		page: safePage,
		limit: safeLimit,
		order_by: 'user_created_time',
		order_dir: 'DESC',
	});
	const notes: Note[] = response?.items ?? [];

	const entries = notes.map(note => {
		const userCreatedTime = Number(note.user_created_time) || 0;
		const folderLabel = note.parent_id ? folderLabels.get(note.parent_id) : undefined;

		return {
			id: note.id,
			title: note.title.trim(),
			sourceFolderId: note.parent_id || undefined,
			sourceFolderLabel: folderLabel,
			userCreatedTime,
			updatedTime: Number(note.updated_time) || 0,
		};
	});

	return {
		entries,
		hasMore: Boolean(response?.has_more),
		page: safePage,
		limit: safeLimit,
	};
};


export const getNoteContent = async (noteId: string): Promise<NoteContent> => {
	const note = await joplin.data.get(['notes', noteId], { fields: ['body', 'markup_language'] });

	return {
		body: `${note?.body ?? ''}`,
		markupLanguage: Number(note?.markup_language) || 1,
	};
};
