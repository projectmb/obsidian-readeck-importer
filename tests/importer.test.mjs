import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import * as yaml from 'js-yaml';

// Bundle the actual browser Nunjucks implementation used by the plugin.
// Only the Obsidian host is replaced; multipart parsing and rendering stay real.
const result = await build({
  stdin: { contents: `export * from './src/bookmarks'; export * from './src/api'; export { requestLog } from 'obsidian'; export * from './src/template'; export * from './src/layout'; export * from './src/interfaces'; export { default as RDPlugin } from './src/plugin'; export { TFile, TFolder } from 'obsidian';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  alias: { nunjucks: './node_modules/nunjucks/browser/nunjucks.js' },
  external: ['moment', 'js-yaml'],
  plugins: [{ name: 'obsidian-host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'host' }));
    builder.onLoad({ filter: /.*/, namespace: 'host' }, () => ({
      contents: `export { default as moment } from 'moment'; import * as yaml from 'js-yaml'; export const parseYaml = yaml.load; export class Notice { constructor() {} }
      export class Plugin { commands = []; async loadData() { return {}; } async saveData() {} addSettingTab() {} addCommand(command) { this.commands.push(command); } }
      export class PluginSettingTab { constructor() {} }
      export class Modal {}
      export class Setting {}
      export class TextAreaComponent {}
      export const debounce = fn => Object.assign(fn, { cancel() {} });
      export const requestLog = []; export const requestUrl = async options => { requestLog.push(options); return {json: []}; }; export class TFile { constructor(path) { this.path = path; } } export class TFolder { constructor(path) { this.path = path; } }`,
      resolveDir: process.cwd(),
    }));
  } }],
});
const runtime = new Module(resolve('tests/runtime.cjs'));
runtime.filename = resolve('tests/runtime.cjs');
runtime.paths = createRequire(import.meta.url).resolve.paths('moment');
runtime._compile(result.outputFiles[0].text, runtime.filename);
const { BookmarksService, NoteTemplate, buildTemplateContext, withReadeckId, DEFAULT_SETTINGS, TFile, TFolder } = runtime.exports;

function fixture(options = {}) {
  const settings = { ...DEFAULT_SETTINGS, layout: 'flat', mode: 'annotations', ...options };
  const files = new Map();
  const contents = new Map();
  const mutations = [];
  const calls = [];
  const bookmarks = [{ id: 'abc', title: 'A readable title', text: 'FULL ARTICLE SECRET' }];
  let statuses = [{ id: 'abc', type: 'update' }];
  let failCreate = false;
  const vault = {
    getAbstractFileByPath: path => files.get(path) ?? null,
    getMarkdownFiles: () => [...files.values()].filter(f => f instanceof TFile && f.path.endsWith('.md')),
    read: async file => contents.get(file.path),
    createFolder: async path => {
      assert(!files.has(path), `Folder already exists: ${path}`);
      const parent = path.split('/').slice(0, -1).join('/');
      if (parent) assert(files.get(parent) instanceof TFolder, `Missing parent: ${parent}`);
      files.set(path, new TFolder(path));
    },
    create: async (path, content) => {
      if (failCreate) throw new Error('disk full');
      assert.equal(typeof content, 'string');
      assert(!files.has(path));
      const file = new TFile(path); files.set(path, file); contents.set(path, content); mutations.push(['create', path]); return file;
    },
    createBinary: async (path, content) => { assert(content instanceof ArrayBuffer); files.set(path, new TFile(path)); contents.set(path, content); mutations.push(['binary', path]); },
    modify: async (file, content) => { assert.equal(typeof content, 'string'); contents.set(file.path, content); mutations.push(['modify', file.path]); },
    modifyBinary: async (file, content) => { assert(content instanceof ArrayBuffer); contents.set(file.path, content); mutations.push(['modifyBinary', file.path]); },
    delete: async file => {
      mutations.push(['delete', file.path]);
      for (const path of files.keys()) if (path === file.path || path.startsWith(file.path + '/')) { files.delete(path); contents.delete(path); }
    },
  };
  const api = {
    filterBookmarkIds: async (ids, collection) => {
      calls.push(['filter', ids, collection]);
      if (options.filterError) throw new Error('filter unavailable');
      return ids.filter(id => (options.collectionIds?.[collection] ?? []).includes(id));
    },
    getBookmarksStatus: async since => { calls.push(['status', since]); return { items: statuses }; },
    getBookmarks: async (ids, markdown, resources, json) => {
      calls.push(['bookmarks', ids, markdown, resources, json]);
      const parts = [];
      for (const bookmark of bookmarks.filter(b => ids.includes(b.id))) {
        const add = (type, body, filename) => parts.push(`--test-boundary\r\nBookmark-Id: ${bookmark.id}\r\nContent-Type: ${type}\r\n${filename ? `Content-Disposition: attachment; filename="${filename}"\r\n` : ''}\r\n${body}\r\n`);
        add('application/json', JSON.stringify({ title: bookmark.title, url: 'https://article.example', authors: ['An Author'], labels: ['test'], resources: { thumbnail: { src: 'https://readeck.example/thumb.png' } } }));
        if (markdown || options.unexpectedText) add('text/markdown', bookmark.text + (resources ? '\n![picture](./imgs/thumbnail.png)' : ''));
        if (resources) add('image/png', 'PNG', 'thumbnail.png');
      }
      const buffer = Buffer.from(parts.join('') + '--test-boundary--\r\n');
      return { headers: { 'content-type': 'multipart/mixed; boundary=test-boundary' }, arrayBuffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
    },
    getBookmarkAnnotations: async id => {
      calls.push(['annotations', id]);
      return options.emptyHighlights ? [] : [{ id: 'highlight1', text: 'Highlighted passage\nSecond line', note: 'My associated note\nAnother line', color: 'yellow' }];
    },
  };
  let saved = 0;
  const service = new BookmarksService({ app: { vault, metadataCache: { getFileCache: file => options.fileCache?.(file) ?? null } }, api, getSettings: () => settings, saveSettings: async () => { saved++; } });
  return { service, settings, vault, files, contents, calls, mutations, bookmarks,
    setStatuses(value) { statuses = value; }, failWrites() { failCreate = true; }, get saved() { return saved; },
    async seed(path, text) { await vault.create(path, text); mutations.length = 0; },
  };
}
const notes = f => [...f.contents].filter(([path]) => path.endsWith('.md'));
const frontmatter = text => yaml.load(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);

test('safe defaults remain compatible with existing settings', () => {
  assert.equal(DEFAULT_SETTINGS.layout, 'folder'); assert.equal(DEFAULT_SETTINGS.template, '');
  assert.equal(DEFAULT_SETTINGS.overwrite, false); assert.equal(DEFAULT_SETTINGS.delete, false);
  assert.deepEqual(DEFAULT_SETTINGS.filterCollections, []);
});

for (const layout of ['flat', 'folder']) {
  for (const mode of ['annotations', 'text', 'textImages', 'textAnnotations', 'textImagesAnnotations']) {
    test(`${layout}: ${mode} preserves content selection and image storage`, async () => {
      const f = fixture({ layout, mode }); await f.service.getReadeckData();
      const [[path, content]] = notes(f);
      assert.equal(path, layout === 'flat' ? 'Readeck/A readable title.md' : 'Readeck/abc/A readable title.md');
      assert.equal(frontmatter(content).readeck_id, 'abc');
      assert.equal(content.includes('FULL ARTICLE SECRET'), mode !== 'annotations');
      const annotations = mode.toLowerCase().includes('annotations');
      assert.equal(content.includes('Highlighted passage'), annotations);
      assert.equal(content.includes('My associated note'), annotations);
      if (annotations) assert(content.includes('/bookmarks/abc#annotation-highlight1'));
      const images = mode.includes('Images');
      assert.equal(f.calls.find(c => c[0] === 'bookmarks')[2], mode !== 'annotations');
      assert.equal(f.calls.find(c => c[0] === 'bookmarks')[3], images);
      if (images) {
        const attachment = layout === 'flat' ? 'Readeck/attachments/abc/thumbnail.png' : 'Readeck/abc/imgs/thumbnail.png';
        assert(f.contents.has(attachment)); assert(f.contents.get(attachment) instanceof ArrayBuffer);
        if (layout === 'flat') assert(content.includes('](<Readeck/attachments/abc/thumbnail.png>)'));
      }
    });
  }
}

test('sample template renders Notes frontmatter, metadata, highlights, notes and links without article text', async () => {
  const f = fixture({ template: readFileSync('examples/highlights-only.njk', 'utf8'), unexpectedText: true });
  await f.service.getReadeckData();
  const text = notes(f)[0][1];
  assert.equal(frontmatter(text).type, 'Notes'); assert.equal(frontmatter(text).readeck_id, 'abc');
  assert(text.includes('> Highlighted passage\n> Second line'));
  assert(text.includes('> My associated note\n> Another line'));
  assert(text.includes('https://article.example')); assert(text.includes('#annotation-highlight1'));
  assert(!text.includes('FULL ARTICLE SECRET')); assert(!f.calls.some(c => c[0] === 'bookmarks' && (c[2] || c[3])));
});

test('repeated sync, title change and renamed/moved user-edited note do not create duplicates or overwrite', async () => {
  const f = fixture(); await f.service.getReadeckData();
  const [path, text] = notes(f)[0]; const file = f.files.get(path);
  f.files.delete(path); f.contents.delete(path); file.path = 'Elsewhere/My name.md';
  f.files.set(file.path, file); f.contents.set(file.path, text + '\nMY EDIT');
  f.bookmarks[0].title = 'Changed upstream title'; f.mutations.length = 0;
  await f.service.getReadeckData(); await f.service.getReadeckData();
  assert.equal(notes(f).length, 1); assert(f.contents.get(file.path).endsWith('MY EDIT')); assert.deepEqual(f.mutations, []);
  f.settings.overwrite = true; await f.service.getReadeckData();
  assert.equal(notes(f).length, 1); assert(!f.contents.get(file.path).includes('MY EDIT'));
});

test('same titles use readable collision suffixes without modifying unrelated notes', async () => {
  const f = fixture(); await f.seed('Readeck/A readable title.md', 'USER NOTE');
  f.bookmarks.push({ ...f.bookmarks[0], id: 'def' }); f.setStatuses([{ id: 'abc', type: 'update' }, { id: 'def', type: 'update' }]);
  await f.service.getReadeckData(); await f.service.getReadeckData();
  assert.equal(notes(f).length, 3); assert.equal(f.contents.get('Readeck/A readable title.md'), 'USER NOTE');
  assert.equal(frontmatter(f.contents.get('Readeck/A readable title (2).md')).readeck_id, 'abc');
  assert.equal(frontmatter(f.contents.get('Readeck/A readable title (3).md')).readeck_id, 'def');
});

test('switching layout preserves a legacy folder without creating a flat duplicate or migrating', async () => {
  const f = fixture(); await f.vault.createFolder('Readeck'); await f.vault.createFolder('Readeck/abc');
  await f.seed('Readeck/abc/Old title.md', 'LEGACY USER EDIT');
  await f.service.getReadeckData();
  assert.deepEqual(notes(f), [['Readeck/abc/Old title.md', 'LEGACY USER EDIT']]); assert.deepEqual(f.mutations, []);
});

for (const layout of ['flat', 'folder']) test(`${layout}: deletion-only sync preserves files by default and deletes only when opted in`, async () => {
  const f = fixture({ layout }); await f.service.getReadeckData();
  f.setStatuses([{ id: 'abc', type: 'delete' }]); f.calls.length = 0;
  await f.service.getReadeckData(); assert.equal(notes(f).length, 1);
  assert(!f.calls.some(c => c[0] === 'bookmarks'));
  f.settings.delete = true; await f.service.getReadeckData(); assert.equal(notes(f).length, 0);
});

test('invalid syntax stops sync before API calls or writes', async () => {
  const f = fixture({ template: '{% if %}' }); await f.service.getReadeckData();
  assert.equal(f.calls.length, 0); assert.equal(f.files.size, 0); assert.equal(f.settings.lastSyncAt, ''); assert.equal(f.saved, 0);
});

test('runtime template errors keep the cursor for retry and do not delete notes', async () => {
  const f = fixture({ template: '{{ title | unknown_filter }}', delete: true });
  await f.seed('Readeck/keep.md', '---\nreadeck_id: keep\n---\nKEEP');
  f.setStatuses([{ id: 'abc', type: 'update' }, { id: 'keep', type: 'delete' }]);
  await f.service.getReadeckData(); assert.equal(f.settings.lastSyncAt, ''); assert.equal(f.saved, 0);
  assert.equal(notes(f).length, 1); assert.equal(f.mutations.length, 0);
});

test('failed writes keep the cursor and release the concurrent-sync guard', async () => {
  const f = fixture(); f.failWrites(); await assert.rejects(f.service.getReadeckData(), /disk full/);
  assert.equal(f.settings.lastSyncAt, ''); await assert.rejects(f.service.getReadeckData(), /disk full/);
});

test('concurrent commands do not duplicate imports', async () => {
  const f = fixture(); await Promise.all([f.service.getReadeckData(), f.service.getReadeckData()]);
  assert.equal(notes(f).length, 1); assert.equal(f.calls.filter(c => c[0] === 'status').length, 1);
});

test('empty highlights do not import full article or create empty notes', async () => {
  const f = fixture({ emptyHighlights: true, unexpectedText: true }); await f.service.getReadeckData(); assert.equal(notes(f).length, 0);
});

test('ID injection preserves Notes and CRLF frontmatter and corrects a template ID', () => {
  const text = withReadeckId('---\r\ntype: Notes\r\nreadeck_id: wrong\r\n---\r\n# Title', 'abc');
  assert.deepEqual(frontmatter(text), { type: 'Notes', readeck_id: 'abc' });
  assert(text.endsWith('# Title')); assert.equal(frontmatter(withReadeckId('Body', 'abc')).readeck_id, 'abc');
});

test('template yaml/date filters and flat thumbnail paths work together', async () => {
  const f = fixture({ mode: 'textImages', template: '---\ntype: Notes\ntitle: {{ title | yaml }}\ncover: {{ thumbnail_path | yaml }}\n---\n{{ content }}' });
  f.bookmarks[0].title = 'Quotes " and colon: and \\ backslash';
  await f.service.getReadeckData(); const fm = frontmatter(notes(f)[0][1]);
  assert.equal(fm.title, f.bookmarks[0].title); assert.equal(fm.cover, 'Readeck/attachments/abc/thumbnail.png');
  const context = buildTemplateContext('https://readeck.example', 'abc', { title: 'Title', created: new Date('2026-11-08T10:00:00Z') }, '', [], '');
  assert.equal(new NoteTemplate('{{ created | date("YYYY-MM-DD") }}').render(context), '2026-11-08');
});


test('template reference lists every context field in settings and README', () => {
  const context = buildTemplateContext('https://readeck.example', 'abc', { title: 'Title' }, '', [], '');
  const names = runtime.exports.TEMPLATE_REFERENCE.map(field => field.name).sort();
  assert.deepEqual(names, Object.keys(context).sort());
  const readme = readFileSync('README.md', 'utf8');
  for (const name of names) assert(readme.includes('`' + name + '`'), name);
});

test('nested selected folders are created and an empty sanitized title uses Untitled', async () => {
  const f = fixture({ folder: 'Imports/Readeck Test' }); f.bookmarks[0].title = '<>:"/\\|?*';
  await f.service.getReadeckData();
  assert(f.contents.has('Imports/Readeck Test/Untitled.md'));
});

test('image bytes use binary APIs and overwrite remains opt-in', async () => {
  const f = fixture({ mode: 'textImages' }); await f.service.getReadeckData();
  const path = 'Readeck/attachments/abc/thumbnail.png';
  assert.equal(Buffer.from(f.contents.get(path)).toString(), 'PNG');
  f.contents.set(path, Uint8Array.from([1, 2, 3]).buffer); f.mutations.length = 0;
  await f.service.getReadeckData(); assert.deepEqual([...new Uint8Array(f.contents.get(path))], [1, 2, 3]);
  assert.deepEqual(f.mutations, []);
  f.settings.overwrite = true; await f.service.getReadeckData();
  assert.equal(Buffer.from(f.contents.get(path)).toString(), 'PNG');
  assert(f.mutations.some(([operation]) => operation === 'modifyBinary'));
});


test('templateNotes preserves the vault template structure and renders highlights-only metadata', async () => {
  const f = fixture({ template: readFileSync('examples/templateNotes.njk', 'utf8') });
  await f.service.getReadeckData();
  const text = notes(f)[0][1];
  const fm = frontmatter(text);
  assert.equal(fm.type, '📓Note');
  assert.equal(fm.area, null);
  assert.equal(fm.title, 'A readable title');
  assert.match(fm.dateCreated, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(fm.dateModified, fm.dateCreated);
  assert.equal(fm.readeck_id, 'abc');
  assert(text.includes('Date created: [[' + fm.dateCreated + ']]'));
  assert(text.includes('Title: [[A readable title]]'));
  assert(text.includes('Author:: An Author'));
  assert(text.includes('## Notes'));
  assert(text.includes('My associated note'));
  assert(text.includes('#annotation-highlight1'));
  assert(text.includes('Source: https://article.example'));
  assert.match(text, /^Link::[ \t]*$/m);
  assert(!text.includes('FULL ARTICLE SECRET'));
});

test('ready-made presets render, match the provided examples, and can be identified after settings reload', async () => {
  const { TEMPLATE_PRESETS, templatePresetId } = runtime.exports;
  assert.equal(templatePresetId(''), 'default');
  assert.equal(templatePresetId(runtime.exports.DEFAULT_TEMPLATE), 'default');
  assert.equal(templatePresetId('{{ title }} custom'), 'custom');
  for (const [id, example, type] of [
    ['highlights', 'examples/highlights-only.njk', 'Notes'],
    ['templateNotes', 'examples/templateNotes.njk', '📓Note'],
  ]) {
    const preset = TEMPLATE_PRESETS.find(item => item.id === id);
    assert.equal(preset.source, readFileSync(example, 'utf8').replace(/\r\n/g, '\n'));
    const restoredSettings = JSON.parse(JSON.stringify({ template: preset.source }));
    assert.equal(templatePresetId(restoredSettings.template), id);
    const f = fixture(restoredSettings); await f.service.getReadeckData();
    const text = notes(f)[0][1];
    assert.equal(frontmatter(text).type, type);
    assert(text.includes('Highlighted passage'));
    assert(text.includes('My associated note'));
    assert(!text.includes('FULL ARTICLE SECRET'));
  }
});

for (const layout of ['flat', 'folder']) test(`${layout}: collection filters union selected collections with custom templates`, async () => {
  const f = fixture({ layout, filterCollections: ['one', 'two'], collectionIds: { one: ['abc'], two: ['def'] }, template: readFileSync('examples/templateNotes.njk', 'utf8') });
  f.bookmarks.push({ id: 'def', title: 'Second article', text: 'FULL ARTICLE SECRET' }, { id: 'excluded', title: 'Excluded article', text: 'FULL ARTICLE SECRET' });
  f.setStatuses(f.bookmarks.map(b => ({ id: b.id, type: 'update' })));
  await f.service.getReadeckData();
  assert.deepEqual(notes(f).map(([, text]) => frontmatter(text).readeck_id).sort(), ['abc', 'def']);
  assert.equal(f.calls.filter(c => c[0] === 'filter').length, 2);
  assert.deepEqual(f.calls.find(c => c[0] === 'bookmarks')[1], ['abc', 'def']);
  for (const [, text] of notes(f)) { assert.equal(frontmatter(text).type, '📓Note'); assert(!text.includes('FULL ARTICLE SECRET')); }
});

test('collection filtering failure stops writes and keeps cursor for retry', async () => {
  const f = fixture({ filterCollections: ['one'], filterError: true });
  await f.service.getReadeckData();
  assert.equal(notes(f).length, 0); assert.equal(f.settings.lastSyncAt, ''); assert.equal(f.saved, 0);
});

test('no collection matches avoids empty data request but still processes opted-in deletions', async () => {
  const f = fixture({ filterCollections: ['one'], delete: true });
  await f.seed('Readeck/old.md', '---\nreadeck_id: old\n---\nOld');
  f.setStatuses([{ id: 'abc', type: 'update' }, { id: 'old', type: 'delete' }]);
  await f.service.getReadeckData();
  assert.equal(notes(f).length, 0); assert(!f.calls.some(c => c[0] === 'bookmarks')); assert.equal(f.saved, 1);
});


test('plugin startup registers Get readeck data and resync commands without authentication', async () => {
  const plugin = new runtime.exports.RDPlugin();
  plugin.manifest = { version: 'test' };
  plugin.app = { workspace: { onLayoutReady() {} } };
  await plugin.onload();
  assert.equal(plugin.settings.apiToken, '');
  const command = plugin.commands.find(item => item.id === 'get-readeck-data');
  assert(command);
  assert.equal(command.name, 'Get readeck data');
  assert(plugin.commands.some(item => item.id === 'resync'));
  let imports = 0;
  plugin.bookmarks.getReadeckData = async () => { imports++; };
  await command.callback();
  assert.equal(imports, 1);
});


test('sync and collection GET requests avoid stale cached responses without changing filters', async () => {
  const { ReadeckApi, requestLog } = runtime.exports;
  const api = new ReadeckApi({ ...DEFAULT_SETTINGS, apiUrl: 'https://readeck.example', apiToken: 'test-only' });
  const since = '2026-11-08T14:00:00.000Z';
  for (const [pathname, call] of [
    ['/api/bookmarks/sync', () => api.getBookmarksStatus(since)],
    ['/api/bookmarks/collections', () => api.getCollections()],
    ['/api/bookmarks', () => api.filterBookmarkIds(['abc', 'def'], 'collection1')],
  ]) {
    requestLog.length = 0;
    await call(); await call();
    const [first, second] = requestLog.map(request => new URL(request.url));
    assert.equal(first.pathname, pathname); assert.equal(second.pathname, pathname);
    assert(first.searchParams.get('v')); assert.notEqual(first.searchParams.get('v'), second.searchParams.get('v'));
    if (pathname.endsWith('/sync')) assert.equal(first.searchParams.get('since'), since);
    if (pathname === '/api/bookmarks') {
      assert.deepEqual(first.searchParams.getAll('id'), ['abc', 'def']);
      assert.equal(first.searchParams.get('collection'), 'collection1');
    }
  }
});


test('large vault scans use indexed metadata and still recognize moved Readeck notes', async () => {
  const f = fixture({ fileCache: file => ({ frontmatter: file.path === 'Elsewhere/Existing.md' ? { readeck_id: 'abc' } : undefined }) });
  await f.seed('Elsewhere/Existing.md', 'LOCAL EDIT');
  for (let i = 0; i < 1000; i++) await f.seed('Unrelated/' + i + '.md', 'Unrelated');
  let reads = 0;
  f.vault.read = async () => { reads++; throw new Error('Indexed notes should not need disk reads'); };
  await f.service.getReadeckData();
  assert.equal(reads, 0); assert.equal(f.contents.get('Elsewhere/Existing.md'), 'LOCAL EDIT');
  assert.equal(notes(f).length, 1001);
});
