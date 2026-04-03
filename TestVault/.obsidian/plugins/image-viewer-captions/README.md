# Image Viewer Captions

Adds editable captions and stored aliases to images from Obsidian's image viewer, optional caption display under transcluded images, live preview rendering, and an editor context menu action to apply the stored alias to an image wikilink.


## 1.4.1

- Viewer panel now saves caption, alias, and embed visibility automatically while you type.
- Removed the Save button from the image viewer panel.


## 1.7.7

- Added a generated-alias option to append a trailing period, so aliases such as `Fig. 3.` can be generated directly.
- Abbreviated aliases now keep their original capitalization unless `Lowercase alias` is enabled.
- Added a `Use alias` button under `Prefix` to copy the stored alias into the prefix field.
- Added `Copy as bold` and `Wrap copied alias in parentheses` options in `Wikilink to copy`.


## 1.7.8

- Added a live preview for the copied wikilink using the generic placeholders `link` and `alias`, so the preview stays compact while reflecting the selected copy options.
- Simplified the `Copy as transclusion` label and removed the `Image properties` title block plus its divider to free a bit more space in the side panel.


## 1.7.9

- Fixed the rename-helper state so alias-generation options stay checked after using `Rename file`, making it possible to rename the alias immediately afterwards.
- Fixed `Use alias` for `Prefix`, which now keeps the filled value instead of reverting instantly.
- Removed the unused `Clear` button from the wikilink section.
- Reordered the side-panel sections to show the rename helper first, then the caption controls, then `Wikilink to copy`, with the `Alias` field moved into the rename-helper block to save space.
