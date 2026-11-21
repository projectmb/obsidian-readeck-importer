# Readeck Importer Plugin

The Readeck Importer is a plugin for Obsidian that enables users to seamlessly import their saved bookmarks from [Readeck](https://readeck.org/) into their Obsidian vault. This plugin is perfect for those who want to organize and annotate their Readeck bookmarks within Obsidian's powerful note-taking environment.

## Features
- Import bookmarks directly from Readeck.
- Save imported bookmarks to a specified folder in your Obsidian vault, optionally using a flat layout with readable filenames.
- Customize notes and YAML properties with Nunjucks templates, including `type: Notes`.
- Optionally fetch full bookmarks, images and annotations from Readeck.
- Flexible import settings, including overwriting existing files.
- Automatically set properties and metadata for imported bookmarks.

## Installation

1. Download the plugin files and place them in your Obsidian plugins folder (`.obsidian/plugins/readeck-importer`).
2. Enable the plugin in the Obsidian settings under **Settings > Community Plugins**.
3. Configure the plugin settings as described below.

## Plugin Settings

The plugin provides the following configurable options:
- **API URL**: The base URL of the Readeck instance (without a trailing `/`).  
- **Folder**: The folder for saving notes.  
- **Note layout**: **Folder per bookmark** (default) keeps `<Folder>/<Readeck ID>/<Title>.md`. **Flat** stores `<Folder>/<Title>.md` with images in `<Folder>/attachments/<Readeck ID>/`. Duplicate titles receive ` (2)`, ` (3)`, etc.
- **Overwrite**: Off by default. If enabled, replaces an existing note, including your local edits.
- **Delete**: Off by default. If enabled, removes imported notes and their attachment folders when Readeck reports a deletion. This can delete local edits too.
- **Mode**: Defines the content to be saved:  
  - **Text**: Save the text.  
  - **Text + Images**: Save text along with images.  
  - **Text + Annotations**: Save text and annotations.  
  - **Text + Images + Annotations**: Save text, images, and annotations.  
  - **Annotations**: Import only highlights, their associated notes and links back to each highlight in Readeck. Article Markdown and images are not requested; `content` is empty even with a custom template. Bookmarks without highlights do not create notes.
- **Filter by collections**: Select one or more Readeck collections; bookmarks matching any selected collection are imported. Leave all unchecked to import everything. Use **Refresh** to load collections after logging in. After changing selections, use **Resync all bookmarks** to include older bookmarks. Existing notes are not removed merely because they leave a collection.
- **Note template**: A [Nunjucks](https://mozilla.github.io/nunjucks/templating.html) template that shapes every imported note. Leave it at the default to keep the classic layout; **Reset to default** restores it. A template with a syntax error is reported in the settings and stops the sync before any note is written.

## Note template

The template uses Nunjucks (Jinja-style) syntax: `{{ variable }}`, `{% for %}`, `{% if %}` and filters like `{{ value | filter }}`.

Block tags on their own line leave no blank line behind (Nunjucks `trimBlocks` and `lstripBlocks` are on), so loops and conditions can be written one tag per line. For finer control, `{%-` and `-%}` strip the whitespace before or after a tag.

### Variables

Example values are from a real Readeck bookmark.

| Variable | Type | Example |
|---|---|---|
| `title` | text | `Interstitial journaling: combining notes, to-do and time tracking` |
| `url` | text | `https://nesslabs.com/interstitial-journaling` |
| `site` | text | `nesslabs.com` |
| `site_name` | text | `Ness Labs` |
| `description` | text | `Your mind at work` |
| `lang` | text | `en` |
| `authors` | list of text | `["Anne-Laure Le Cunff"]` |
| `labels` | list of text | `["fire", "review"]` |
| `created` | date, saved in Readeck | use `{{ created \| date("YYYY-MM-DD") }}` â†’ `2025-12-17` |
| `published` | date, may be empty | `{{ published \| date("YYYY-MM-DD") }}` â†’ `2020-04-15` |
| `word_count` | number | `673` |
| `reading_time` | number, minutes | `3` |
| `id` | text, Readeck bookmark id | `8fV5nHaQwi3pG7RRcZciNx` |
| `readeck_url` | text, the bookmark in Readeck | `https://readeck.example/bookmarks/8fV5nHaQwi3pG7RRcZciNx` |
| `thumbnail` | text, URL of the thumbnail image in Readeck | `https://readeck.example/bm/8f/8fV5nHaQwi3pG7RRcZciNx/img/thumbnail.png` |
| `thumbnail_path` | text, vault path of the downloaded thumbnail; empty in modes without images | `Readeck/8fV5nHaQwi3pG7RRcZciNx/imgs/thumbnail.png`, e.g. `cover: "[[{{ thumbnail_path }}]]"` |
| `content` | text, the article as Markdown | empty in Annotations mode |
| `highlights` | list, see below | loop with `{% for highlight in highlights %}` |
| `frontmatter` | text, the default frontmatter block | `---\ntitle: "â€¦"\nâ€¦\n---` |
| `now` | date, time of the import | `{{ now \| date("YYYY-MM-DD") }}` |
| `bookmark` | object, everything Readeck sends, see below | `{{ bookmark.read_progress }}` |

**Each highlight** in `highlights`:

| Field | Type | Example |
|---|---|---|
| `text` | text, the highlighted passage | `Track time. Type /time to insert the current timeâ€¦` |
| `note` | text, your own note on the highlight | empty if none |
| `color` | text | `yellow`, `red`, `blue` or `green` |
| `created` | date | `{{ highlight.created \| date("YYYY-MM-DD") }}` â†’ `2026-01-28` |
| `id` | text | `dAUNBCc7T7A1ALnfSSxv1` |
| `readeck_url` | text, the highlight in Readeck | `https://readeck.example/bookmarks/8fV5â€¦#annotation-dAUNâ€¦` |

**Useful fields of `bookmark`** beyond the variables above (anything Readeck adds later appears here too):

| Field | Example |
|---|---|
| `bookmark.note` | your note on the whole bookmark |
| `bookmark.resources.image.src` | the article's cover image URL, e.g. for `cover: {{ bookmark.resources.image.src }}` |
| `bookmark.is_marked`, `bookmark.is_archived` | `true` / `false` (favourite, archived) |
| `bookmark.read_progress` | `100` (percent) |
| `bookmark.updated` | date of the last change in Readeck |
| `bookmark.type`, `bookmark.document_type` | `article`, `photo` or `video` |
| `bookmark.links` | list of links in the article, each with `url`, `domain`, `title` |

### Filters

| Filter | Example | Result |
|---|---|---|
| `date(format)` | `{{ published \| date("YYYY-MM-DD") }}` | Date formatted with [moment.js tokens](https://momentjs.com/docs/#/displaying/format/) |
| `blockquote` | `{{ highlight.text \| blockquote }}` | Prefixes every line with `> `, so multi-line highlights stay inside a quote or callout |
| `yaml` | `title: {{ title \| yaml }}` | A safely quoted YAML string for frontmatter |

All [built-in Nunjucks filters](https://mozilla.github.io/nunjucks/templating.html#builtin-filters) such as `join`, `default` and `length` work too.

### Example

```
---
title: {{ title | yaml }}
url: {{ url }}
published: {{ published | date("YYYY-MM-DD") }}
imported: {{ now | date("YYYY-MM-DD") }}
tags:
{% for label in labels %}
  - {{ label }}
{% endfor %}
---

# {{ title }}

## Highlights

{% for highlight in highlights %}
> [!quote] {{ highlight.created | date("YYYY-MM-DD") }} Â· [open in Readeck]({{ highlight.readeck_url }})
{{ highlight.text | blockquote }}
{% if highlight.note %}
>
{{ highlight.note | blockquote }}
{% endif %}

{% else %}
_No highlights yet._

{% endfor %}
## Content

{{ content }}
```

### Highlights-only template

Select **Annotations**, choose **Flat** if desired, then choose **Highlights only (type: Notes)** under **Template preset**. This preset includes article metadata, multiline highlights, and associated notes with links to Readeck. Its source is [highlights-only.njk](examples/highlights-only.njk).

Choose **templateNotes (your Notes layout)** for the vault template with dates, title, author, Notes, Source, and Link fields. In a mode that imports article text, it places Readeck’s Markdown below the Link field so the original heading levels, paragraphs, lists, and other Markdown formatting carry through. In **Annotations** mode it renders highlights and their notes. The preset is copied into **Note template** when selected. Select it again to load the updated version, or copy the `{% if content %}` block into your saved template if you’ve customized it. [templateNotes.njk](examples/templateNotes.njk)

### Synchronisation and existing notes

Every newly written note receives `readeck_id` in its frontmatter, including when a custom template supplies its own frontmatter or omits it. This field is managed by the importer: leave it intact. It identifies the bookmark even after the note or upstream title is renamed, or the note is moved within this vault. Repeated imports keep that file and respect **Overwrite**. Changes made only in Obsidian are not sent to Readeck.

Changing the layout does not move or rewrite existing notes automatically. When switching to Flat, a legacy `<Folder>/<Readeck ID>/` folder without an identified note is left untouched and that bookmark is skipped, avoiding a second flat copy. Notes already carrying an ID are found in place. Use a fresh folder or separate vault to try a new layout; there is no automatic migration. Identification uses Readeck IDs across this vault, so changing folders does not create a second copy of an already identified bookmark.

With **Overwrite** off, upstream changes (including new highlights) do not replace an existing note. To intentionally refresh, back up local edits first, enable **Overwrite**, run **Resync all bookmarks**, then turn **Overwrite** off again. Resync resets the cursor and rechecks bookmarks; it does not bypass overwrite/delete settings. A runtime template error or failed file write leaves the sync cursor unchanged for retry; a partial batch may already have created other notes.

## How to Use

1. Configure the plugin settings in **Settings > Readeck Importer**.
2. Use the "Readeck Importer: Get Readeck Data" command from the command palette.
3. The plugin will fetch your bookmarks and save them in the specified folder.

## Test safely in a separate vault

The automated tests use an in-memory Obsidian host and mocked Readeck responses, with real multipart parsing and the same browser Nunjucks build as the plugin. They do not open a vault or contact a Readeck server:

```sh
npm ci
npm test
npm run build
```

For manual Obsidian checks:

1. Create a new, empty vault such as `Readeck Importer Test`, outside your production vault and any synced vault folder.
2. Copy only the built `main.js`, `manifest.json` and `styles.css` into that vault's `.obsidian/plugins/readeck-importer/` directory. Do not copy production `data.json`, credentials, or plugin settings.
3. Enable the plugin in the test vault. Before connecting, disable **Sync on startup** and keep **Overwrite** and **Delete** off. Choose a fresh folder such as `Readeck Test` and **Flat** layout.
4. Use a separate disposable Readeck test instance with test credentials and a small dataset: two bookmarks with the same title, multiline highlights, associated highlight notes, and an article with images. Do not use production credentials or change your production server for this test.
5. Select **Annotations**, choose the Highlights only template preset, and run **Get readeck data**. Verify `type: Notes`, `readeck_id`, readable names, highlight notes and Readeck links. Confirm that full article text and image files are absent. No note is expected for a bookmark without highlights.
6. Run **Resync all bookmarks** twice. Edit a note locally, rename it and move it within the test vault; resync again. Confirm one note per ID and that your edit survives. Also change a title on the disposable server and repeat.
7. In disposable data only, test explicit **Overwrite** and **Delete** opt-ins. Delete a test bookmark on the test server and sync with Delete off first; confirm the note stays. Enable Delete and resync to verify opt-in removal. Restore both toggles to off afterward.
8. Use fresh test vaults for each full-article mode and for Folder per bookmark layout. Reset the template to default (or include `{{ content }}`). Check article text, optional images, and optional annotations; image paths should resolve in Obsidian. Switch a populated test vault to Flat and confirm existing notes stay in place.
9. Try an invalid template and confirm the error appears without new notes. Review Obsidian's developer console for plugin errors. Live Obsidian rendering and compatibility with your Readeck version require these manual checks; automated host tests do not verify the actual UI.

## Development

If you wish to contribute to the plugin or customize it for your needs:

1. Clone the repository and run `npm install` to install dependencies.
2. Run `npm test` for regression tests and `npm run build` for type checking and a production bundle. Use `npm run dev` for watch mode.

This integration starts from `main` and reuses only the flat-layout implementation from `feature/flat-layout` and the Nunjucks implementation from `feature/note-template`. Their existing shared collection-filtering implementation is retained; no additional feature branches are integrated.

## License

This project is licensed under the MIT License. See the LICENSE file for details.
