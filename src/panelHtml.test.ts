import { buildErrorHtml, buildPanelHtml, buildStreamEntriesHtml, buildStreamFooterHtml, PanelState } from './panelHtml';
import { StreamEntry } from './stream';

const today = new Date();
const shift = (days: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);

const entryFor = (date: Date): StreamEntry => ({
	id: `n-${date.getTime()}`,
	title: `Note ${date.toISOString()}`,
	userCreatedTime: date.getTime(),
	updatedTime: 1,
});

const panel = (over: Partial<PanelState> = {}) => buildPanelHtml({
	folderLabel: 'Journals',
	status: 'ready',
	entries: [],
	bodies: new Map(),
	truncated: false,
	showImages: true,
	fontSize: 0,
	selectedNoteIds: [],
	bookmarkedNoteIds: [],
	selectedSourceId: 'f-journals',
	sourceOptions: [
		{ id: '__all__', label: 'All notebooks' },
		{ id: '__bookmarked__', label: 'Bookmarked' },
		{ id: 'f-journals', label: 'Journals' },
	],
	...over,
});

const articleFor = (html: string, id: string) => {
	return (html.match(new RegExp(`<article[^>]*data-note-id="${id}"[^>]*>`)) ?? [''])[0];
};

describe('escaping', () => {
	const hostileId = '"><script>alert(1)</script>';
	const hostileSourceLabel = 'Journals/<img src=x onerror="alert(1)">';
	const hostile = panel({
		selectedSourceId: 'f-hostile',
		sourceOptions: [{ id: 'f-hostile', label: hostileSourceLabel }],
		entries: [{ id: hostileId, title: 'Hostile', userCreatedTime: shift(-2).getTime(), updatedTime: 1 }],
		bodies: new Map([[hostileId, '<p>Rendered <em>body</em></p>']]),
	});

	test('escapes source labels and note ids', () => {
		expect(hostile).not.toContain('<img src=x');
		expect(hostile).not.toContain('<script>alert');
		expect(hostile).toContain('&lt;img');
	});

	// Bodies come from Joplin's renderer, which has already sanitised them, and
	// must reach the panel as markup rather than as text.
	test('passes rendered note bodies through as HTML', () => {
		expect(hostile).toContain('<p>Rendered <em>body</em></p>');
	});

	test('escapes the error message', () => {
		expect(buildErrorHtml('A<B', 'boom & <crash>')).toContain('&lt;crash&gt;');
	});
});

describe('selection', () => {
	const older = entryFor(shift(-3));
	const html = panel({
		entries: [entryFor(shift(0)), entryFor(shift(-1)), older],
		selectedNoteIds: [older.id],
	});

	test('highlights the open entry and nothing else', () => {
		expect(html.match(/jt-entry--selected/g)).toHaveLength(1);
		expect(articleFor(html, older.id)).toContain('jt-entry--selected');
		expect(articleFor(html, entryFor(shift(0)).id)).not.toContain('jt-entry--selected');
	});

	test('highlights nothing when the selection is elsewhere in the app', () => {
		expect(panel({ entries: [entryFor(shift(0))] })).not.toContain('jt-entry--selected');
	});
});

describe('entries', () => {
	test('are clickable as a whole, not only their date heading', () => {
		const html = panel({ entries: [entryFor(shift(0)), entryFor(shift(-1))] });
		expect(html.match(/<article[^>]*data-action="open-note"/g)).toHaveLength(2);
	});

	test('say when they have no body', () => {
		expect(panel({ entries: [entryFor(shift(0))] })).toContain('This entry is empty');
	});
});

describe('images', () => {
	const withImage = new Map([['n-x', '<p><img src="joplin-content://note-viewer/x.png"></p>']]);
	const imageDate = shift(-2);
	const imageEntry: StreamEntry = { id: 'n-x', title: 'Image note', userCreatedTime: imageDate.getTime(), updatedTime: 1 };

	test('are shown by default', () => {
		expect(panel({ entries: [imageEntry], bodies: withImage })).not.toContain('jt--no-images');
	});

	// Hiding is a CSS toggle so the cached note HTML stays valid: stripping the
	// tags would force every visible entry to be rendered again.
	test('are hidden with a class, leaving the rendered body intact', () => {
		const html = panel({ entries: [imageEntry], bodies: withImage, showImages: false });
		expect(html).toContain('class="jt jt--no-images"');
		expect(html).toContain('<img src="joplin-content://note-viewer/x.png">');
	});
});

describe('font size', () => {
	// The panel reads note bodies, so it is sized by Joplin's editor setting
	// rather than --joplin-font-size, which measures menus and the note list.
	test('renders at the editor size when Joplin reports one', () => {
		expect(panel({ fontSize: 18 })).toContain('style="font-size: 18px"');
	});

	// Every other size in the panel is in em, so the one root value carries them.
	test('leaves the stylesheet in charge when there is no editor size', () => {
		expect(panel({ fontSize: 0 })).not.toContain('style="font-size');
		expect(panel({ fontSize: 0 })).toContain('class="jt"');
	});

	test('composes with images being hidden', () => {
		expect(panel({ fontSize: 18, showImages: false })).toContain('class="jt jt--no-images" style="font-size: 18px"');
	});
});

describe('notices', () => {
	test('explains an empty source', () => {
		expect(panel()).toContain('No notes in this source yet');
	});

	test('explains a notebook that has disappeared', () => {
		expect(panel({ status: 'missing' })).toContain('no longer exists');
	});

	test('offers another page when more entries exist', () => {
		const html = panel({ entries: [entryFor(shift(0))], truncated: true });
		expect(html).toContain('data-action="load-more"');
		expect(html).toContain('Load more');
	});

	test('removes the load-more control at the end of the stream', () => {
		expect(buildStreamFooterHtml(false)).toBe('');
		expect(panel({ entries: [entryFor(shift(0))], truncated: false })).not.toContain('data-action="load-more"');
	});

	// The reader refreshes itself, so a manual retry only earns its place where
	// the last attempt failed.
	test('offers a retry when a render fails', () => {
		expect(buildErrorHtml('Journals', 'boom')).toContain('data-action="refresh"');
		expect(buildErrorHtml('Journals', 'boom')).toContain('Try again');
	});
});

describe('paged stream fragments', () => {
	test('renders entries without rebuilding the surrounding panel', () => {
		const entry = entryFor(shift(-2));
		const html = buildStreamEntriesHtml([entry], new Map([[entry.id, '<p>older</p>']]), []);

		expect(html).toContain(`data-note-id="${entry.id}"`);
		expect(html).toContain('<p>older</p>');
		expect(html).not.toContain('jt-topbar');
		expect(html).not.toContain('jt-scroll');
	});

	test('renders a load-more footer only while another page exists', () => {
		expect(buildStreamFooterHtml(true)).toContain('data-action="load-more"');
		expect(buildStreamFooterHtml(false)).toBe('');
	});
});

describe('stream presentation', () => {
	const entryAt = (hour: number, minute: number, title: string): StreamEntry => {
		const date = new Date(2026, 9, 23, hour, minute);
		return {
			id: `n-${title}`,
			title,
			userCreatedTime: date.getTime(),
			updatedTime: 1,
		};
	};

	test('shows each entry user-created date and time', () => {
		const entry = entryAt(22, 13, 'test');
		const date = new Date(entry.userCreatedTime);
		const expectedDay = date.toLocaleDateString(undefined, {
			weekday: 'long',
			year: 'numeric',
			month: 'long',
			day: 'numeric',
		});
		const expectedTime = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
		const html = panel({ entries: [entry] });

		expect(html).toContain(expectedDay);
		expect(html).toContain(expectedTime);
	});

	test('distinguishes two entries created on the same day by time', () => {
		const later = entryAt(22, 13, 'later');
		const earlier = entryAt(22, 9, 'earlier');
		const html = panel({ entries: [later, earlier] });
		const laterTime = new Date(later.userCreatedTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
		const earlierTime = new Date(earlier.userCreatedTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

		expect(html).toContain(laterTime);
		expect(html).toContain(earlierTime);
		expect(laterTime).not.toBe(earlierTime);
	});

	test('uses Stream as the top-bar title', () => {
		expect(panel({ entries: [entryAt(22, 13, 'test')] })).toMatch(/class="jt-topbar__title">\s*Stream\s*</);
	});
});

describe('stream sources', () => {
	test('renders All notebooks and individual notebooks in the source selector', () => {
		const html = panel();
		expect(html).toContain('class="jt-topbar__source"');
		expect(html).toContain('<option value="__all__">All notebooks</option>');
		expect(html).toContain('<option value="__bookmarked__">Bookmarked</option>');
		expect(html).toContain('<option value="f-journals" selected>Journals</option>');
	});

	test('shows the notebook path beside entries only when a merged entry carries one', () => {
		const date = shift(-2);
		const entry: StreamEntry = {
			id: 'merged',
			title: 'Merged',
			sourceFolderId: 'robot',
			sourceFolderLabel: 'Robot/Logs',
			userCreatedTime: date.getTime(),
			updatedTime: 1,
		};
		const html = panel({ entries: [entry] });
		expect(html).toContain('class="jt-entry__source"');
		expect(html).toContain('Robot/Logs');
	});
});

describe('bookmarked source', () => {
	test('can be selected like any other Stream source', () => {
		const html = panel({ selectedSourceId: '__bookmarked__' });
		expect(html).toContain('<option value="__bookmarked__" selected>Bookmarked</option>');
	});

	test('explains that bookmarks are backed by the Joplin tag', () => {
		const html = panel({
			selectedSourceId: '__bookmarked__',
			emptyNotice: 'No notes are bookmarked yet. Bookmark a note from another Stream source to see it here.',
		});
		expect(html).toContain('Bookmarked');
		expect(html).toContain('Bookmark a note from another Stream source');
	});
});

describe('bookmark control', () => {
	test('renders an outline bookmark for an unbookmarked entry', () => {
		const entry = entryFor(shift(-2));
		const html = panel({ entries: [entry] });

		expect(html).toContain('data-action="toggle-bookmark"');
		expect(html).toContain('aria-pressed="false"');
		expect(html).toContain('aria-label="Add bookmark"');
		expect(html).not.toContain('jt-entry__bookmark is-bookmarked');
	});

	test('renders a filled bookmark for a bookmarked entry', () => {
		const entry = entryFor(shift(-2));
		const html = panel({ entries: [entry], bookmarkedNoteIds: [entry.id] });

		expect(html).toContain('jt-entry__bookmark is-bookmarked');
		expect(html).toContain('aria-pressed="true"');
		expect(html).toContain('aria-label="Remove bookmark"');
	});

	test('paged fragments preserve bookmark state', () => {
		const entry = entryFor(shift(-3));
		const html = buildStreamEntriesHtml([entry], new Map(), [], [entry.id]);

		expect(html).toContain('jt-entry__bookmark is-bookmarked');
	});
});
