import joplin from 'api';
import { renderEntryBodies } from './render';
import { getNoteContent } from './stream';
import type { StreamEntry } from './stream';

jest.mock('api', () => ({
	__esModule: true,
	default: {
		commands: {
			execute: jest.fn(),
		},
	},
}));

jest.mock('./stream', () => ({
	getNoteContent: jest.fn(),
}));

const mockedGetNoteContent = getNoteContent as jest.MockedFunction<typeof getNoteContent>;
const mockedExecute = joplin.commands.execute as jest.MockedFunction<typeof joplin.commands.execute>;

const entry = (id: string, updatedTime = 1): StreamEntry => ({
	id,
	title: `Note ${id}`,
	userCreatedTime: 1,
	updatedTime,
});

beforeEach(() => {
	jest.clearAllMocks();
});

describe('renderEntryBodies', () => {
	test('renders the note body through Joplin with the body-only wrapper option', async () => {
		mockedGetNoteContent.mockResolvedValue({ body: '  **Hello**  ', markupLanguage: 1 });
		mockedExecute.mockResolvedValue({ html: '<p><strong>Hello</strong></p>' });

		const rendered = await renderEntryBodies([entry('render')]);

		expect(mockedGetNoteContent).toHaveBeenCalledWith('render');
		expect(mockedExecute).toHaveBeenCalledWith(
			'renderMarkup',
			1,
			'**Hello**',
			null,
			{ bodyOnly: true },
		);
		expect(rendered.get('render')).toBe('<p><strong>Hello</strong></p>');
	});

	test('reuses the cached HTML while updated_time is unchanged', async () => {
		mockedGetNoteContent.mockResolvedValue({ body: 'Cached', markupLanguage: 1 });
		mockedExecute.mockResolvedValue({ html: '<p>Cached</p>' });
		const same = entry('cached');

		await renderEntryBodies([same]);
		const rendered = await renderEntryBodies([same]);

		expect(mockedGetNoteContent).toHaveBeenCalledTimes(1);
		expect(mockedExecute).toHaveBeenCalledTimes(1);
		expect(rendered.get('cached')).toBe('<p>Cached</p>');
	});

	test('renders the note again when updated_time changes', async () => {
		mockedGetNoteContent
			.mockResolvedValueOnce({ body: 'Before', markupLanguage: 1 })
			.mockResolvedValueOnce({ body: 'After', markupLanguage: 1 });
		mockedExecute
			.mockResolvedValueOnce({ html: '<p>Before</p>' })
			.mockResolvedValueOnce({ html: '<p>After</p>' });

		await renderEntryBodies([entry('edited', 1)]);
		const rendered = await renderEntryBodies([entry('edited', 2)]);

		expect(mockedGetNoteContent).toHaveBeenCalledTimes(2);
		expect(mockedExecute).toHaveBeenCalledTimes(2);
		expect(rendered.get('edited')).toBe('<p>After</p>');
	});

	test('does not call the renderer for an empty body', async () => {
		mockedGetNoteContent.mockResolvedValue({ body: '   ', markupLanguage: 1 });

		const rendered = await renderEntryBodies([entry('empty')]);

		expect(mockedExecute).not.toHaveBeenCalled();
		expect(rendered.get('empty')).toBe('');
	});

	test('keeps rendering other entries when one note fails', async () => {
		const error = new Error('broken note');
		mockedGetNoteContent
			.mockRejectedValueOnce(error)
			.mockResolvedValueOnce({ body: 'Still works', markupLanguage: 1 });
		mockedExecute.mockResolvedValue({ html: '<p>Still works</p>' });
		const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

		try {
			const rendered = await renderEntryBodies([entry('broken'), entry('good')]);

			expect(rendered.get('broken')).toBe('');
			expect(rendered.get('good')).toBe('<p>Still works</p>');
			expect(consoleError).toHaveBeenCalledWith('Stream Timeline: could not render "Note broken"', error);
		} finally {
			consoleError.mockRestore();
		}
	});
});
