import { App, Notice, parseYaml, TFile, TFolder } from "obsidian";
import { Annotation, Bookmark, BookmarkData, BookmarkStatus, ReadeckPluginSettings } from "./interfaces";
import { ReadeckApi } from "./api";
import { Utils } from "./utils";
import { MultipartPart } from "@mjackson/multipart-parser";
import { attachmentsFolder, relinkImagesToAttachments, uniqueNotePath, withReadeckId } from "./layout";
import { NoteTemplate, buildTemplateContext, templateErrorMessage } from "./template";

type BookmarksServiceDeps = {
	app: App;
	api: ReadeckApi;
	getSettings: () => ReadeckPluginSettings;
	saveSettings: () => Promise<void>;
};

export class BookmarksService {
	private syncing = false;
	private app: App;
	private api: ReadeckApi;
	private getSettings: () => ReadeckPluginSettings;
	private saveSettings: () => Promise<void>;

	constructor({ app, api, getSettings, saveSettings }: BookmarksServiceDeps) {
		this.app = app;
		this.api = api;
		this.getSettings = getSettings;
		this.saveSettings = saveSettings;
	}

	private get settings() {
		return this.getSettings();
	}

	/*
	* Fetch Readeck data and process bookmarks
	* 1. Get bookmark status since last sync
	* 2. For each updated bookmark, fetch data based on mode
	* 3. Create/update markdown notes and save images
	* 4. Delete removed bookmarks if setting enabled
	* 5. Update last sync time
	*/
	async getReadeckData() {
		if (this.syncing) return;
		this.syncing = true;
		try {
			await this.sync();
		} finally {
			this.syncing = false;
		}
	}

	private async sync() {
		const syncStartedAt = new Date().toISOString();
		const { lastSyncAt } = this.settings;

		// Compile the note template first, so a broken template stops the sync before anything is written
		let noteTemplate: NoteTemplate;
		try {
			noteTemplate = new NoteTemplate(this.settings.template);
		} catch (error) {
			new Notice(`Readeck importer: Note template has an error, sync stopped: ${templateErrorMessage(error)}`, 15000);
			return;
		}

		// Get bookmark status since last sync
		let bookmarksStatus: BookmarkStatus[] = [];
		try {
			const response = await this.api.getBookmarksStatus(
				Utils.parseDateStrToISO(lastSyncAt)
			);
			bookmarksStatus = response.items;
		} catch (error) {
			new Notice(`Readeck importer: Error getting bookmarks, error ${error}`);
			return;
		}

		// Check if bookmarks were returned
		if (bookmarksStatus.length <= 0) {
			new Notice("Readeck importer: No new bookmarks found");
			return;
		}

		// Ensure bookmarks folder exists
		await this.createFolderIfNotExists("", this.settings.folder);

		// Determine what data to fetch based on mode
		let get = {
			md: false,
			res: false,
			annotations: false
		};
		if (this.settings.mode == "text") {
			get.md = true;
		} else if (this.settings.mode == "textImages") {
			get.md = true;
			get.res = true;
		} else if (this.settings.mode == "textAnnotations") {
			get.md = true;
			get.annotations = true;
		} else if (this.settings.mode == "textImagesAnnotations") {
			get.md = true;
			get.res = true;
			get.annotations = true;
		} else if (this.settings.mode == "annotations") {
			get.annotations = true;
		}

		const { filterCollections } = this.settings;
		const hasCollectionFilter = filterCollections.length > 0;

		// Extract only updated bookmark IDs (ignore deletes at this stage)
		let toUpdateIds = bookmarksStatus.filter(b => b.type === 'update').map(b => b.id);

		if (hasCollectionFilter && toUpdateIds.length > 0) {
			try {
				// One API call per selected collection; results are OR-unioned.
				const calls = filterCollections.map(id =>
					this.api.filterBookmarkIds(toUpdateIds, id)
				);
				const idSets = await Promise.all(calls);
				const unionSet = new Set(idSets.flat());
				toUpdateIds = toUpdateIds.filter(id => unionSet.has(id));
			} catch (error) {
				new Notice(`Readeck importer: Error filtering bookmarks, error ${error}`);
				return;
			}
		}


		const bookmarksData = new Map<string, BookmarkData>();
		for (const id of toUpdateIds) {
			bookmarksData.set(id, { id: id, text: null, json: { title: '' }, images: [], annotations: [] });
		}

		// Fetch bookmarks data in multipart format
		if (toUpdateIds.length > 0) {
			const bookmarksMPData = await this.getBookmarksData(toUpdateIds, get.md, get.res, true);
			await this.parseBookmarksMP(bookmarksData, bookmarksMPData);
		}

		if (get.annotations) {
			// Fetch annotations for each updated bookmark
			for (const bookmarkId of toUpdateIds) {
				const annotationsData = await this.getBookmarkAnnotations(bookmarkId);
				for (const annotationData of annotationsData) {
					const bookmark: BookmarkData = bookmarksData.get(bookmarkId)!;
					bookmark.annotations.push(annotationData);
				}
			}
		}

		const flat = this.settings.layout === "flat";
		const notesById = await this.notesByReadeckId();
		let renderFailed = false;

		// Process each bookmark
		for (const [id, bookmark] of bookmarksData.entries()) {
			// Create markdown note
			if ((get.md && bookmark.text) || bookmark.annotations.length > 0) {
				// Legacy folder notes stay in place when the layout setting changes.
				const bookmarkFolderPath = flat ? this.settings.folder : `${this.settings.folder}/${id}`;
				const article = get.md ? (bookmark.text || '') : '';
				const content = flat ? relinkImagesToAttachments(article, this.settings.folder, id) : article;
				const context = buildTemplateContext(
					this.settings.apiUrl, id, bookmark.json, content,
					bookmark.annotations, this.generateBookmarkHeader(bookmark.json),
					get.res ? this.thumbnailPath(id, bookmark) : "",
				);
				let noteContent: string;
				try {
					noteContent = withReadeckId(noteTemplate.render(context), id);
				} catch (error) {
					new Notice(`Readeck importer: Could not render note for ${bookmark.json.title}: ${templateErrorMessage(error)}`, 15000);
					renderFailed = true;
					continue;
				}
				const legacyFolder = this.app.vault.getAbstractFileByPath(`${this.settings.folder}/${id}`);
				if (flat && !notesById.has(id) && legacyFolder instanceof TFolder) {
					new Notice(`Readeck importer: Keeping existing folder for ${bookmark.json.title}; no automatic migration`);
					continue;
				}
				if (flat || notesById.has(id)) {
					await this.writeFlatNote(id, bookmark.json.title, noteContent, notesById);
				} else {
				await this.createFolderIfNotExists(id, bookmarkFolderPath);
					const filePath = `${bookmarkFolderPath}/${Utils.sanitizeFileName(bookmark.json.title) || 'Untitled'}.md`;
					await this.createFile(bookmark.json.title, filePath, noteContent);
				}
			}

			// Save images
			if (get.res && bookmark.images.length > 0 && bookmark.json) {
				const bookmarkImgsFolderPath = attachmentsFolder(this.settings.folder, id, this.settings.layout);
				await this.createFolderIfNotExists(id, bookmarkImgsFolderPath);
				for (const image of bookmark.images) {
					const filePath = `${bookmarkImgsFolderPath}/${image.filename}`;
					await this.createFile(bookmark.json.title, filePath, image.content, false, true);
				}
			}
		}

		// Retry failed renders on the next sync; do not advance the cursor or delete notes.
		if (renderFailed) return;

		// Delete removed bookmarks
		if (this.settings.delete) {
			const toDeleteIds = bookmarksStatus.filter(b => b.type === 'delete').map(b => b.id);
			for (const id of toDeleteIds) {
				if (flat) {
					const note = notesById.get(id);
					if (note) await this.app.vault.delete(note);
					await this.deleteFolder(id, attachmentsFolder(this.settings.folder, id, "flat"), true);
				} else {
					const note = notesById.get(id);
					if (note) await this.app.vault.delete(note);
					await this.deleteFolder(id, `${this.settings.folder}/${id}`, true);
				}
			}
		}
		
		// Update last sync time
		this.settings.lastSyncAt = syncStartedAt;
		await this.saveSettings();
	}

	/* Every note in the vault whose frontmatter has readeck_id, wherever it was moved to */
	private async notesByReadeckId(): Promise<Map<string, TFile>> {
		const notes = new Map<string, TFile>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			let id: unknown = cache?.frontmatter?.readeck_id;
			// Most notes have cached metadata. Only read files that Obsidian has
			// not indexed yet, rather than reading the entire vault every sync.
			if (!cache) {
				const content = await this.app.vault.read(file);
				const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
				try { id = match ? parseYaml(match[1])?.readeck_id : undefined; }
				catch { continue; }
			}
			if (typeof id === "string" && id !== "") notes.set(id, file);
		}
		return notes;
	}

	private async writeFlatNote(id: string, title: string, content: string, notesById: Map<string, TFile>) {
		const existing = notesById.get(id);
		if (existing) {
			if (this.settings.overwrite) {
				await this.app.vault.modify(existing, content);
				new Notice(`Readeck importer: Overwriting note for ${title}`);
			} else {
				new Notice(`Readeck importer: Note for ${title} already exists`);
			}
			return;
		}
		const path = uniqueNotePath(this.settings.folder, Utils.sanitizeFileName(title),
			candidate => this.app.vault.getAbstractFileByPath(candidate) !== null);
		const file = await this.app.vault.create(path, content);
		notesById.set(id, file);
		new Notice(`Readeck importer: Creating note for ${title}`);
	}

	private async getBookmarkAnnotations(bookmarkId: string) {
		const annotations = await this.api.getBookmarkAnnotations(bookmarkId);
		if (!annotations) {
			new Notice(`Readeck importer: Error getting annotations for ${bookmarkId}`);
		}
		return annotations;
	}

	private async getBookmarksData(
		ids: string[] = [],
        markdown: boolean = false,
        resources: boolean = false,
		json: boolean = false,
	) {
		const multipart = await this.api.getBookmarks(ids, markdown, resources, json);
		return multipart;
	}

	private async parseBookmarksMP(bookmarksData: Map<string, BookmarkData>, bookmarksMPData: any): Promise<boolean> {
		const partsData: MultipartPart[] = await Utils.parseMultipart(bookmarksMPData);

		for (const partData of partsData) {
			const mediaType = partData.mediaType || '';
			const bookmarkId = partData.headers.get('Bookmark-Id') || '';	
			const bookmark: BookmarkData = bookmarksData.get(bookmarkId)!;
			if (mediaType == 'text/markdown') {
				const markdownContent = await partData.text();
				bookmark.text = markdownContent;
				const frontmatter = /^---[ \t]*\r?\n((?:[^\n]*\n)*?)---[ \t]*(?:\r?\n|$)/.exec(markdownContent);
				if (frontmatter) {
					try {
						const properties = parseYaml(frontmatter[1]);
						if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
							bookmark.text = markdownContent.slice(frontmatter[0].length);
						}
					} catch {
						// A leading horizontal rule can look like a frontmatter delimiter.
					}
				}
			} else if (mediaType.includes('image')) {
				bookmark.images.push({
					filename: partData.filename,
					content: await partData.arrayBuffer(),
				});
			} else if (mediaType.includes('json')) {
				const jsonText = await partData.text();
				// Parse JSON with date conversion
				bookmark.json = JSON.parse(jsonText, (key, value) => {
					if (key === 'created' || key === 'published') {
						return new Date(value);
					}
					return value;
				});
			} else {
				console.warn(`Unknown content type: ${partData.mediaType}`);
			}
		}
		return true;
	}

	/* Vault path the downloaded thumbnail is saved to, or "" when images are not downloaded */
	private thumbnailPath(id: string, bookmark: BookmarkData): string {
		const thumbnail = bookmark.images.find(image => /^thumbnail\./i.test(image.filename ?? ""));
		return thumbnail ? `${attachmentsFolder(this.settings.folder, id, this.settings.layout)}/${thumbnail.filename}` : "";
	}

	private generateBookmarkHeader(bookmark: Bookmark): string {
		let header = `---\n`;
		if (bookmark.title) {
			header += `title: "${bookmark.title.replace(/"/g, '\\"')}"\n`;
		}
		if (bookmark.url) {
			header += `url: "${bookmark.url}"\n`;
		}
		if (bookmark.site) {
			header += `site: "${bookmark.site}"\n`;
		}
		if (bookmark.created) {
			header += `created: "${bookmark.created.toISOString()}"\n`;
		}
		if (bookmark.published) {
			header += `published: "${bookmark.published.toISOString().split('T')[0]}"\n`;
		}
		if (bookmark.authors && bookmark.authors.length > 0) {
			header += `authors:\n- ${bookmark.authors.join('\n- ')}\n`;
		}
		if (bookmark.labels && bookmark.labels.length > 0) {
			header += `tags:\n- ${bookmark.labels.join('\n- ')}\n`;
		}
		header += `---\n`;
		return header;
	}

	private async createFile(bookmarkTitle: string, filePath: string, content: any, showNotice: boolean = true, binary = false) {
		const file = this.app.vault.getAbstractFileByPath(filePath);

		if (file && file instanceof TFile) {
			if (this.settings.overwrite) {
				// the file exists and overwrite is true
				if (binary) await this.app.vault.modifyBinary(file, content);
				else await this.app.vault.modify(file, content);
				if (showNotice) { new Notice(`Readeck importer: Overwriting note for ${bookmarkTitle}`); }
			} else {
				// the file exists and overwrite is false
				if (showNotice) { new Notice(`Readeck importer: Note for ${bookmarkTitle} already exists`); }
			}
		} else if (!file) {
			// create file if not exists
			if (binary) await this.app.vault.createBinary(filePath, content);
			else await this.app.vault.create(filePath, content);
			if (showNotice) { new Notice(`Readeck importer: Creating note for ${bookmarkTitle}`); }
		}
	}

	private async createFolderIfNotExists(id: string, path: string, showNotice: boolean = false) {
		if (!path || path === "/") return;
		const folder = this.app.vault.getAbstractFileByPath(path);

		if (folder && folder instanceof TFolder) {
			if (showNotice) { new Notice(`Readeck importer: Folder already exists in ${id}`); }
		} else {
			if (folder) throw new Error(`Import folder is a file: ${path}`);
			const parent = path.split('/').slice(0, -1).join('/');
			if (parent) await this.createFolderIfNotExists(id, parent);
			await this.app.vault.createFolder(path);
			if (showNotice) { new Notice(`Readeck importer: Creating folder for ${id} for Readeck`); }
		}
	}

	private async deleteFolder(id: string, path:string, showNotice: boolean = false) {
		const folder = this.app.vault.getAbstractFileByPath(path);

		if (folder && folder instanceof TFolder) {
			await this.app.vault.delete(folder, true);
			if (showNotice) { new Notice(`Readeck importer: Deleting bookmark ${id}`); }
		} else if (!folder) {
			if (showNotice) { new Notice(`Readeck importer: Error deleting bookmark ${id}`); }
		}
	}
}
