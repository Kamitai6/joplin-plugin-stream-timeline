// Panel-side script. It is loaded once, when the panel is created, and is *not*
// re-executed when the plugin calls setHtml() - that only swaps the content of
// the plugin container. Listeners therefore have to live on `document`, which
// outlives every re-render; anything bound to an element inside the panel would
// stop working after the first refresh.

(() => {
	const request = (message) => {
		if (typeof webviewApi === 'undefined') {
			console.error('Stream Timeline: webviewApi is unavailable');
			return Promise.resolve(null);
		}

		return webviewApi.postMessage(message).catch((error) => {
			console.error('Stream Timeline: the plugin rejected a message', message, error);
			return null;
		});
	};

	const send = (message) => {
		request(message);
	};

	const setBookmarkButtonState = (button, bookmarked) => {
		button.classList.toggle('is-bookmarked', bookmarked);
		button.setAttribute('aria-pressed', bookmarked ? 'true' : 'false');
		button.setAttribute('aria-label', bookmarked ? 'Remove bookmark' : 'Add bookmark');
		button.setAttribute('title', bookmarked ? 'Remove bookmark' : 'Add bookmark');
	};

	// Attachments render as thumbnails; clicking one toggles it to full width.
	// Tracked by src so the choice survives a re-render.
	const expandedImages = new Set();

	const restoreExpandedImages = (root) => {
		if (!expandedImages.size) return;

		for (const image of root.querySelectorAll('.jt-md img')) {
			if (expandedImages.has(image.getAttribute('src'))) image.classList.add('-expanded');
		}
	};

	// Links inside an entry are plain anchors, so letting one through would
	// navigate the whole panel away from the reader. Caught during capture so
	// the click never reaches the anchor, then handed to the app to open in the
	// right place - Joplin's `openItem` resolves note links, files and URLs.
	document.addEventListener('click', (event) => {
		const link = event.target instanceof Element ? event.target.closest('.jt-md a') : null;
		if (!link) return;

		event.preventDefault();
		event.stopPropagation();

		const url = link.getAttribute('href');

		// "#foo" is an anchor within the note, which means nothing here.
		if (url && url.charAt(0) !== '#') send({ type: 'openLink', url: url });
	}, true);

	// Anything that is not a link, an image or a form control opens the entry.
	const opensEntry = (element) => {
		return !element.closest('.jt-md a, .jt-md input, .jt-md label, .jt-md textarea, .jt-md select');
	};

	// Distinguishes a click from the end of a drag-select: at click time a plain
	// click has already collapsed any selection, while a drag leaves one behind.
	const isSelectingText = () => {
		const selection = window.getSelection();
		return !!selection && !selection.isCollapsed && selection.toString().trim() !== '';
	};

	document.addEventListener('click', (event) => {
		const image = event.target;
		if (image instanceof HTMLImageElement && image.closest('.jt-md')) {
			// Stops a linked image from navigating the panel away.
			event.preventDefault();

			const src = image.getAttribute('src');
			if (image.classList.toggle('-expanded')) expandedImages.add(src);
			else expandedImages.delete(src);
			return;
		}

		const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
		if (!target) return;

		switch (target.getAttribute('data-action')) {
			case 'refresh':
				send({ type: 'refresh' });
				break;
			case 'load-more':
				send({ type: 'loadMore' });
				break;
			case 'toggle-bookmark': {
				event.preventDefault();
				event.stopPropagation();

				const noteId = target.getAttribute('data-note-id');
				if (!noteId || !(target instanceof HTMLButtonElement) || target.disabled) return;

				const previous = target.getAttribute('aria-pressed') === 'true';
				const next = !previous;
				setBookmarkButtonState(target, next);
				target.disabled = true;

				request({ type: 'toggleBookmark', noteId, bookmarked: next }).then((response) => {
					const accepted = response && response.ok === true;
					setBookmarkButtonState(target, accepted ? response.bookmarked === true : previous);
					target.disabled = false;
				});
				break;
			}
			case 'open-note':
				// Reading an entry means selecting text in it, which must not be
				// mistaken for a click on the entry.
				if (isSelectingText() || !opensEntry(event.target)) return;
				send({ type: 'openNote', noteId: target.getAttribute('data-note-id') });
				break;
		}
	});

	// The top-bar source selector is routed through this stable document-level
	// handler, so it survives setHtml().
	document.addEventListener('change', (event) => {
		const input = event.target;

		if (input instanceof HTMLSelectElement && input.classList.contains('jt-topbar__source') && input.value) {
			send({ type: 'selectSource', sourceId: input.value });
			return;
		}

	});

	// The plugin pushes the editor's note selection here instead of re-rendering,
	// so the highlight moves without rebuilding the reader. `null` means nothing
	// has been pushed yet and the server-rendered highlight should stand.
	let selectedNoteIds = null;

	const applySelection = (root) => {
		if (!selectedNoteIds) return;

		for (const article of root.querySelectorAll('.jt-entry[data-note-id]')) {
			const isSelected = selectedNoteIds.indexOf(article.getAttribute('data-note-id')) !== -1;
			article.classList.toggle('jt-entry--selected', isSelected);
		}
	};

	if (typeof webviewApi !== 'undefined') {
		webviewApi.onMessage((event) => {
			const message = event && event.message;
			if (!message) return;

			if (message.type === 'selection') {
				selectedNoteIds = message.noteIds || [];
				applySelection(document);
			} else if (message.type === 'appendEntries') {
				const stream = document.querySelector('.jt-stream');
				const footer = document.querySelector('.jt-stream-footer');

				if (stream && message.entriesHtml) stream.insertAdjacentHTML('beforeend', message.entriesHtml);
				if (footer) footer.innerHTML = message.footerHtml || '';

				// Appending does not replace the scroller, so MutationObserver's
				// re-render path intentionally ignores it. Apply the two DOM-only states
				// that new entries still need here instead.
				restoreExpandedImages(document);
				applySelection(document);
			}
		});
	}

	// A re-render replaces the scrolling element, which would otherwise throw the
	// reader back to the top every time any note changed. Track the position and
	// put it back once the new content is in place.
	let savedScroll = 0;

	document.addEventListener('scroll', (event) => {
		const target = event.target;
		if (target instanceof Element && target.classList.contains('jt-scroll')) {
			savedScroll = target.scrollTop;
		}
	}, true); // Capture: scroll events do not bubble.

	// Everything that has to be reapplied after the plugin swaps the content in.
	let lastScroller = null;

	const onContentReplaced = (root) => {
		const scroller = root.querySelector('.jt-scroll');

		// Identity only changes on a real re-render.
		if (scroller === lastScroller) return;
		lastScroller = scroller;

		if (scroller && savedScroll) scroller.scrollTop = savedScroll;
		restoreExpandedImages(root);
		applySelection(root);
	};

	const watchForRerender = () => {
		const root = document.getElementById('joplin-plugin-content');

		// The host creates this container on DOMContentLoaded, which may not have
		// happened yet when this script runs.
		if (!root) {
			setTimeout(watchForRerender, 50);
			return;
		}

		new MutationObserver(() => onContentReplaced(root)).observe(root, { childList: true, subtree: true });

		// The panel may already hold content by the time this script runs.
		onContentReplaced(root);
	};

	watchForRerender();
})();
