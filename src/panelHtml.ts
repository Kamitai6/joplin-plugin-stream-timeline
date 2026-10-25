import { StreamEntry } from './stream';

export type FolderStatus =
	/** The selected source is available. */
	| 'ready'
	/** A notebook source was selected but has since been deleted. */
	| 'missing';

export interface StreamSourceOption {
	id: string;
	label: string;
}

export interface PanelState {
	/** Label for the selected Stream source. */
	folderLabel: string;
	status: FolderStatus;
	entries: StreamEntry[];
	/** Rendered note body per entry id. */
	bodies: Map<string, string>;
	truncated: boolean;
	/** When false, attachments are hidden with CSS - the render cache is untouched. */
	showImages: boolean;
	/**
	 * Root size in px, from Joplin's editor setting. Every other size in the
	 * panel is in `em`, so this one value scales the whole reader. 0 leaves the
	 * stylesheet's `--joplin-font-size` in charge.
	 */
	fontSize: number;
	/** Notes currently open in the editor, highlighted in the reader. */
	selectedNoteIds: string[];
	/** Visible notes carrying the dedicated Bookmarked tag. */
	bookmarkedNoteIds: string[];
	/** Source currently selected in the Stream's own selector. */
	selectedSourceId: string;
	/** All Stream sources the selector can switch to. */
	sourceOptions: StreamSourceOption[];
	/** Optional source-specific message when it currently contains no notes. */
	emptyNotice?: string;
}

const HTML_ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	'\'': '&#39;',
};

// Note titles and notebook paths are user content, so they are never
// interpolated into the panel markup as-is. Rendered note bodies are the one
// exception: they are HTML by definition, already sanitised by Joplin's
// renderer, and setHtml() assigns through innerHTML, which does not run
// scripts.
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => HTML_ESCAPES[char]);

/** Full user-created date and time; several notes may share one day. */
const formatEntryDateTime = (entry: StreamEntry): string => {
	const date = new Date(entry.userCreatedTime);
	const day = date.toLocaleDateString(undefined, {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	});
	const time = date.toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit',
	});

	return `${day} ${time}`;
};

/** Font Awesome 5 is already loaded in plugin webviews; FA6-only names render blank. */
const renderTopBar = (title: string, folderLabel: string, selectedSourceId = '', sourceOptions: StreamSourceOption[] = []): string => {
	const sourceSelector = sourceOptions.length ? `
		<select class="jt-topbar__source" data-action="select-source" aria-label="Stream source" title="Stream source">
			${sourceOptions.map(option => `<option value="${escapeHtml(option.id)}"${option.id === selectedSourceId ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
		</select>` : `<span class="jt-topbar__folder" title="${escapeHtml(folderLabel)}">${escapeHtml(folderLabel)}</span>`;

	return `
	<header class="jt-topbar">
		<div class="jt-topbar__lead">
			${sourceSelector}
		</div>
		<h1 class="jt-topbar__title">${escapeHtml(title)}</h1>
		<div class="jt-topbar__actions"></div>
	</header>
`;
};

const renderNotice = (message: string, modifier = ''): string => `
	<p class="jt-notice${modifier}">${escapeHtml(message)}</p>
`;

const renderBookmarkButton = (entry: StreamEntry, bookmarked: boolean): string => `
	<button type="button" class="jt-entry__bookmark${bookmarked ? ' is-bookmarked' : ''}" data-action="toggle-bookmark" data-note-id="${escapeHtml(entry.id)}" aria-pressed="${bookmarked ? 'true' : 'false'}" aria-label="${bookmarked ? 'Remove bookmark' : 'Add bookmark'}" title="${bookmarked ? 'Remove bookmark' : 'Add bookmark'}">
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 4.75A1.75 1.75 0 0 1 8.75 3h6.5A1.75 1.75 0 0 1 17 4.75v15l-5-3.35-5 3.35v-15Z"/></svg>
	</button>
`;

const renderEntryHeader = (entry: StreamEntry, bookmarked: boolean): string => `
	<div class="jt-entry__header">
		<button type="button" class="jt-entry__date" data-action="open-note" data-note-id="${escapeHtml(entry.id)}" title="Open ${escapeHtml(entry.title)}">
			${escapeHtml(formatEntryDateTime(entry))}
		</button>
		<div class="jt-entry__header-actions">
			${entry.sourceFolderLabel ? `<span class="jt-entry__source" title="${escapeHtml(entry.sourceFolderLabel)}">${escapeHtml(entry.sourceFolderLabel)}</span>` : ''}
			${renderBookmarkButton(entry, bookmarked)}
		</div>
	</div>
`;

// data-note-id lets panel.js move the selection highlight without a re-render.
// data-action on the article makes the whole entry open its note; the heading
// stays a real button so the entry is still reachable by keyboard.
const renderEntry = (entry: StreamEntry, body: string, isSelected: boolean, bookmarked: boolean): string => `
	<article class="jt-entry${isSelected ? ' jt-entry--selected' : ''}" data-action="open-note" data-note-id="${escapeHtml(entry.id)}">
		${renderEntryHeader(entry, bookmarked)}
		${body
		? `<div class="jt-md">${body}</div>`
		: `<p class="jt-entry__empty">This entry is empty. <button type="button" class="jt-link" data-action="open-note" data-note-id="${escapeHtml(entry.id)}">Write something</button></p>`}
	</article>
`;

/** Renders only stream entries, so another page can be appended without replacing the panel. */
export const buildStreamEntriesHtml = (entries: StreamEntry[], bodies: Map<string, string>, selectedNoteIds: string[], bookmarkedNoteIds: string[] = []): string => {
	const selected = new Set(selectedNoteIds);
	const bookmarked = new Set(bookmarkedNoteIds);
	return entries.map(entry => renderEntry(entry, bodies.get(entry.id) ?? '', selected.has(entry.id), bookmarked.has(entry.id))).join('');
};

/** Contents of the stable footer container; panel.js replaces only this after loading a page. */
export const buildStreamFooterHtml = (hasMore: boolean): string => {
	if (!hasMore) return '';

	return `<button type="button" class="jt-link" data-action="load-more">Load more</button>`;
};

const renderStatusNotice = (state: PanelState): string => {
	if (state.status === 'missing') {
		return renderNotice('The selected notebook no longer exists. Choose another source above.', ' jt-notice--warn');
	}


	if (!state.entries.length) {
		return renderNotice(state.emptyNotice || 'No notes in this source yet.');
	}

	return '';
};

export const buildPanelHtml = (state: PanelState): string => {
	const { entries, bodies, truncated } = state;
	const stream = buildStreamEntriesHtml(entries, bodies, state.selectedNoteIds, state.bookmarkedNoteIds);

	return `
		<div class="jt${state.showImages ? '' : ' jt--no-images'}"${state.fontSize ? ` style="font-size: ${state.fontSize}px"` : ''}>
			${renderTopBar('Stream', state.folderLabel, state.selectedSourceId, state.sourceOptions)}
			<div class="jt-scroll">
				${renderStatusNotice(state)}
				<div class="jt-stream">${stream}</div>
				<p class="jt-notice jt-stream-footer">${buildStreamFooterHtml(truncated)}</p>
			</div>
		</div>
	`;
};

// The reader refreshes itself on note, sync and settings changes, so the only
// place a manual retry earns its keep is here, where the last attempt failed.
export const buildErrorHtml = (folderLabel: string, message: string): string => `
	<div class="jt">
		${renderTopBar('Stream', folderLabel)}
		<div class="jt-scroll">
			${renderNotice(`The timeline could not be loaded: ${message}`, ' jt-notice--error')}
			<p class="jt-notice"><button type="button" class="jt-link" data-action="refresh">Try again</button></p>
		</div>
	</div>
`;

