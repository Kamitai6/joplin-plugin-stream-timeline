import joplin from 'api';
import { MenuItemLocation, ToolbarButtonLocation } from 'api/types';
import { StreamPanel } from './panel';
import { refreshSourceOptions, registerSettings, SettingKey } from './settings';

const COMMAND_TOGGLE = 'streamToggle';
const COMMAND_REFRESH = 'streamRefresh';

const registerCommands = async (panel: StreamPanel) => {
	await joplin.commands.register({
		name: COMMAND_TOGGLE,
		label: 'Toggle Stream Timeline',
		iconName: 'fas fa-book-open',
		execute: () => panel.toggle(),
	});

	// The panel keeps itself current, so this has no toolbar button - it is here
	// for the command palette and for anyone who wants to bind a shortcut.
	await joplin.commands.register({
		name: COMMAND_REFRESH,
		label: 'Refresh Stream Timeline',
		iconName: 'fas fa-sync-alt',
		execute: () => panel.refresh(),
	});

	await joplin.views.toolbarButtons.create(
		'streamToggleButton',
		COMMAND_TOGGLE,
		// The third argument is a ToolbarButtonLocation - passing anything else
		// leaves the button out of the toolbar entirely.
		ToolbarButtonLocation.NoteToolbar,
	);

	await joplin.views.menus.create('streamMenu', 'Stream Timeline', [
		{ commandName: COMMAND_TOGGLE, accelerator: 'CmdOrCtrl+Alt+J' },
		{ commandName: COMMAND_REFRESH },
	], MenuItemLocation.Tools);
};

joplin.plugins.register({
	onStart: async () => {
		await registerSettings();
		await refreshSourceOptions();

		const panel = new StreamPanel();
		await panel.create();
		await registerCommands(panel);

		// Show the panel on the first run only. Showing it on every start would
		// override the user's choice to hide it.
		if (!await joplin.settings.value(SettingKey.PanelIntroduced)) {
			await joplin.settings.setValue(SettingKey.PanelIntroduced, true);
			await panel.show();
		}

		await joplin.settings.onChange(() => {
			// Only this plugin's settings reach this handler.
			panel.render().catch(error => console.error('Stream Timeline: refresh after a settings change failed', error));
		});

		// Keeps the timeline in step with notes added, renamed, moved or deleted
		// anywhere in the app, including by sync.
		await joplin.workspace.onNoteChange(() => panel.scheduleRender());
		await joplin.workspace.onSyncComplete(() => panel.scheduleRender());

		await joplin.workspace.onNoteSelectionChange(() => {
			// Highlight whichever entry is now open in the editor.
			panel.syncSelection().catch(error => console.error('Stream Timeline: could not update the selection', error));

			// A notebook click normally changes the selected note too, so this gives
			// sidebar-to-Stream synchronisation an immediate path. Empty notebooks are
			// covered by the lightweight selectedFolder() watcher in StreamPanel.
			panel.checkSelectedFolder().catch(error => console.error('Stream Timeline: could not update the source from Joplin notebook selection', error));

			// Deleting the selected note changes the selection after the note has already
			// disappeared from Joplin's note list. onNoteChange() is not guaranteed to
			// reach this plugin for that deleted note, so rebuild the stream here too.
			// scheduleRender() is debounced, and the panel restores its scroll position.
			panel.scheduleRender();

			// The panel can also be revealed from Joplin's own layout controls,
			// which raise no event, so catch up the next time the user moves around.
			if (panel.needsRefresh) panel.scheduleRender();
		});
	},
});
