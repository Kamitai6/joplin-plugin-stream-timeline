import { ALL_FOLDERS, BOOKMARKED_SOURCE, buildSourceOptions, MAX_ENTRIES_LIMIT, parseMaxEntries } from './settings';
import { NotebookPath } from './stream';

const notebooks: NotebookPath[] = [
	{ id: 'f1', path: 'Archive' },
	{ id: 'f2', path: 'Journals' },
	{ id: 'f3', path: 'Journals/Personal' },
];

describe('buildSourceOptions', () => {
	test('offers All notebooks, Bookmarked, then the notebooks in order', () => {
		expect(Object.keys(buildSourceOptions(notebooks, 'f2'))).toEqual([ALL_FOLDERS, BOOKMARKED_SOURCE, 'f1', 'f2', 'f3']);
	});

	test('labels notebooks by their full path', () => {
		expect(buildSourceOptions(notebooks, '').f3).toBe('Journals/Personal');
	});

	// A <select> whose value matches no option renders blank, which reads as the
	// setting having been lost.
	test('keeps a placeholder for a notebook that has been deleted', () => {
		expect(buildSourceOptions(notebooks, 'gone').gone).toMatch(/no longer exists/);
	});

	test('keeps both special Stream sources when there are no notebooks', () => {
		expect(Object.keys(buildSourceOptions([], ''))).toEqual([ALL_FOLDERS, BOOKMARKED_SOURCE]);
	});
});

describe('parseMaxEntries', () => {
	// The setting is free text, because Joplin's Int field cannot be typed into:
	// it is a controlled number input, so clearing it writes 0 and "0" returns.
	test('reads a plain number', () => {
		expect(parseMaxEntries('80')).toBe(80);
		expect(parseMaxEntries(' 80 ')).toBe(80);
		expect(parseMaxEntries('30.7')).toBe(30);
	});

	test('treats 0 as the maximum page size', () => {
		expect(parseMaxEntries('0')).toBe(0);
	});

	test('caps values that would make a refresh crawl', () => {
		expect(parseMaxEntries('9999')).toBe(MAX_ENTRIES_LIMIT);
	});

	// Falling back to 0 would quietly request the maximum page size.
	test('falls back to the default rather than to 0', () => {
		expect(parseMaxEntries('')).toBe(30);
		expect(parseMaxEntries('abc')).toBe(30);
		expect(parseMaxEntries('-5')).toBe(30);
		expect(parseMaxEntries(undefined)).toBe(30);
		expect(parseMaxEntries(null)).toBe(30);
	});

	test('still reads a value stored while the setting was an Int', () => {
		expect(parseMaxEntries(30)).toBe(30);
	});
});
