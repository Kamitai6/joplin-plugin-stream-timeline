# Stream Timeline

A [Joplin](https://joplinapp.org) plugin that streams ordinary notes from one or more notebooks into a continuous, newest-first timeline.

Unlike the original Journal Timeline plugin, notes do **not** need date-formatted titles. Every note is eligible, and chronological order is based on Joplin's `user_created_time`, so editing an old note does not move it to the top of the stream.

## Features

- Shows ordinary Joplin notes as a continuous timeline, rendered with Joplin's own Markdown/HTML renderer.
- Switches directly from the panel between:
  - **All notebooks** — merges notes from every notebook into one chronological stream.
  - **Bookmarked** — shows notes carrying the normal Joplin `Bookmarked` tag.
  - **Any individual notebook** — shows only notes from that notebook.
- Orders entries by `user_created_time` (newest first). Editing a note updates its rendered content without changing its chronological position.
- Loads incrementally with **Load more** instead of expanding the entire history into the DOM at once.
- Shows the original notebook beside an entry when notes from multiple notebooks are mixed.
- Clicking anywhere in an entry opens that note in the editor. The currently selected note is highlighted.
- Renders attachments as thumbnails; click an image to expand or shrink it, or hide images from the plugin settings.
- Adds a bookmark button to each entry. Bookmarking uses a normal Joplin tag named `Bookmarked`, so the bookmark state remains part of your Joplin data and syncs normally.
- Reflects bookmark membership changes automatically while the Bookmarked source is visible, using a lightweight ID-only check.
- Keeps the timeline current when notes change, are deleted, or finish syncing without resetting the reader to the top.

## Requirements

Joplin **3.2 or newer**, desktop only.

## Installation

### From a `.jpl` file

Download the `.jpl` package from the repository's [Releases](https://github.com/Kamitai6/joplin-plugin-stream-timeline/releases) page and install it from Joplin's Plugins settings.

### Build from source

```bash
npm ci
npm run dist
```

The generated plugin archive is placed in `publish/`.

For development, add the repository root to Joplin's **Development plugins** path and restart Joplin in development mode.

## Usage

The panel appears the first time the plugin runs and afterwards remembers whether you left it open or closed.

| Action | Where |
| --- | --- |
| Choose the stream source | Source selector at the top-left of the panel |
| Show or hide the panel | Toolbar button, _Tools → Stream Timeline_, or `Ctrl/Cmd+Alt+J` |
| Open a note in the editor | Click anywhere in its entry |
| Bookmark or unbookmark a note | Bookmark button at the right side of the entry header |
| Load older notes | **Load more** at the bottom of the stream |
| Follow a link in an entry | Click the link; note links open in Joplin and other links use the system handler |
| Expand or shrink an image | Click the image |

The panel can be resized or moved with Joplin's normal layout controls.

## Sources

### All notebooks

Merges notes from every notebook and orders the combined result by `user_created_time`.

### Individual notebook

Shows only notes from the selected notebook.

### Bookmarked

Shows notes tagged `Bookmarked`. The bookmark button creates this tag automatically the first time it is needed.

Because the bookmark is a standard Joplin tag rather than plugin-local state, it is visible to Joplin itself and participates in normal sync.

## Settings

_Preferences → Stream Timeline_

| Setting | Default | What it does |
| --- | --- | --- |
| Stream source | `All notebooks` | Choose one notebook, merge every notebook, or show the `Bookmarked` tag source. |
| Entries per page | `30` | Number of entries loaded at a time, up to 100. `0` uses the maximum page size of 100. |
| Show images in entries | on | Hide attached images in the timeline without changing the notes themselves. |

The source can also be changed directly from the selector in the panel; the selection is persisted in the plugin setting.

## Chronology and performance

Stream Timeline deliberately uses `user_created_time` rather than `updated_time` for ordering. This keeps the timeline stable when old notes are edited.

Only the current page is rendered initially. Older entries are fetched and appended when **Load more** is pressed, which avoids building a very large DOM for long-running note archives.

## Credits

Stream Timeline is a fork of [Journal Timeline](https://github.com/xFuture603/joplin-plugin-journal-timeline) by xFuture603. Version 1.5.0 changes the journal-specific reader into a general-purpose note stream while retaining the original project's foundation.

## License

MIT
