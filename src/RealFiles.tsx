import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, File, FileImage, FileText, Folder, HardDrive, RefreshCw, Save, Search, Upload } from 'lucide-react';

type WritableFile = { write(data: Blob | string): Promise<void>; close(): Promise<void> };
type LocalFileHandle = {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritableFile>;
};
type LocalDirectoryHandle = {
  kind: 'directory';
  name: string;
  values(): AsyncIterableIterator<LocalFileHandle | LocalDirectoryHandle>;
};
type PickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<LocalDirectoryHandle>;
};
type LocalEntry = {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  handle: LocalFileHandle | LocalDirectoryHandle;
  size?: number;
  modified?: number;
};
type Props = { onImport: (name: string, content: string) => void };

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm', 'css', 'js', 'mjs',
  'ts', 'tsx', 'jsx', 'py', 'xml', 'yaml', 'yml', 'toml', 'ini', 'log', 'svg', 'sql',
  'sh', 'bat', 'ps1', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'php', 'rb'
]);
const MAX_TEXT_BYTES = 1_500_000;
const MAX_VIRTUAL_COPY_BYTES = 250_000;
const MAX_ENTRIES = 300;

function isTextFile(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return file.type.startsWith('text/') || file.type === 'application/json' ||
    file.type === 'application/xml' || TEXT_EXTENSIONS.has(ext);
}
function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
async function listDirectory(root: LocalDirectoryHandle) {
  const result: LocalEntry[] = [];
  const walk = async (directory: LocalDirectoryHandle, prefix: string, depth: number): Promise<void> => {
    if (depth > 5 || result.length >= MAX_ENTRIES) return;
    const children: (LocalFileHandle | LocalDirectoryHandle)[] = [];
    for await (const child of directory.values()) children.push(child);
    children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    for (const child of children) {
      if (result.length >= MAX_ENTRIES) break;
      const path = prefix ? prefix + '/' + child.name : child.name;
      if (child.kind === 'directory') {
        result.push({ path, name: child.name, kind: 'directory', handle: child });
        await walk(child as LocalDirectoryHandle, path, depth + 1);
      } else {
        try {
          const file = await (child as LocalFileHandle).getFile();
          result.push({ path, name: child.name, kind: 'file', handle: child, size: file.size, modified: file.lastModified });
        } catch {
          result.push({ path, name: child.name, kind: 'file', handle: child });
        }
      }
    }
  };
  await walk(root, '', 0);
  return result;
}

export function RealFilesPanel({ onImport }: Props) {
  const [root, setRoot] = useState<LocalDirectoryHandle | null>(null);
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<LocalEntry | null>(null);
  const [editor, setEditor] = useState('');
  const [status, setStatus] = useState('Your real files stay on your device. Choose a folder to grant access.');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editable, setEditable] = useState(false);
  const [fallbackImport, setFallbackImport] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewKind, setPreviewKind] = useState<'image' | 'audio' | 'video' | 'pdf' | null>(null);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const visible = useMemo(
    () => entries.filter(entry => entry.path.toLowerCase().includes(filter.toLowerCase())),
    [entries, filter],
  );

  const refresh = async (directory = root) => {
    if (!directory) return;
    setBusy(true);
    try {
      const next = await listDirectory(directory);
      setEntries(next);
      setStatus(next.length >= MAX_ENTRIES
        ? 'Showing the first ' + MAX_ENTRIES + ' entries (folder scan limit).'
        : next.length + ' real file-system entries loaded.');
      if (selected) {
        const updated = next.find(entry => entry.path === selected.path && entry.kind === 'file');
        setSelected(updated ?? null);
      }
    } catch (error) {
      setStatus('Could not read this folder. Reconnect it and check the browser permission.');
      console.error('AeroShell local folder scan failed:', error);
    } finally {
      setBusy(false);
    }
  };

  const connectFolder = async () => {
    const picker = (window as unknown as PickerWindow).showDirectoryPicker;
    if (!picker) {
      setStatus('Folder connection is not supported in this browser. Use “Open files” to choose specific files instead.');
      setFallbackImport(true);
      return;
    }
    setBusy(true);
    try {
      const directory = await picker.call(window, { mode: 'readwrite' });
      setRoot(directory);
      setSelected(null);
      setEditor('');
      setDirty(false);
      setPreviewUrl(null);
      await refresh(directory);
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') setStatus('Folder selection cancelled.');
      else setStatus('Could not connect that folder. Try choosing it again.');
    } finally {
      setBusy(false);
    }
  };

  const openEntry = async (entry: LocalEntry) => {
    if (entry.kind === 'directory') {
      setStatus(entry.path + ' is a folder. Its files are shown underneath.');
      return;
    }
    const handle = entry.handle as LocalFileHandle;
    setBusy(true);
    setSelected(entry);
    setDirty(false);
    setEditable(false);
    setEditor('');
    setPreviewUrl(null);
    setPreviewKind(null);
    try {
      const file = await handle.getFile();
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (file.size > MAX_TEXT_BYTES && isTextFile(file)) {
        setStatus('This text file is larger than 1.5 MB. It is listed, but was not loaded into the editor.');
        return;
      }
      if (isTextFile(file) && file.size <= MAX_TEXT_BYTES) {
        setEditable(true);
        setEditor(await file.text());
        setStatus('Opened real file: ' + entry.path + '. Edits are not saved until you click Save to device.');
      } else {
        setEditable(false);
        const kinds: Record<string, 'image' | 'audio' | 'video' | 'pdf' | undefined> = {
          png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image',
          mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio',
          mp4: 'video', webm: 'video', mov: 'video', pdf: 'pdf'
        };
        const kind = kinds[ext];
        if (kind) {
          setPreviewUrl(URL.createObjectURL(file));
          setPreviewKind(kind);
          setStatus('Previewing real file: ' + entry.path + '.');
        } else {
          setStatus('Selected ' + entry.path + ' (' + formatSize(file.size) + '). This file type has no built-in preview.');
        }
      }
    } catch {
      setStatus('Could not open ' + entry.path + '. Reconnect the folder to restore permission.');
    } finally {
      setBusy(false);
    }
  };

  const saveToDevice = async () => {
    if (!selected || selected.kind !== 'file') return;
    setBusy(true);
    try {
      const writable = await (selected.handle as LocalFileHandle).createWritable();
      await writable.write(editor);
      await writable.close();
      setDirty(false);
      setStatus('Saved changes to the real file: ' + selected.path);
      await refresh();
    } catch (error) {
      setStatus('Could not save changes. The browser may need folder permission again.');
      console.error('AeroShell local file write failed:', error);
    } finally {
      setBusy(false);
    }
  };

  const openPickedFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    let imported = 0;
    for (const file of Array.from(files)) {
      if (!isTextFile(file) || file.size > MAX_VIRTUAL_COPY_BYTES) continue;
      try { onImport(file.name, await file.text()); imported++; } catch { /* continue with other picked files */ }
    }
    setStatus(imported
      ? imported + ' text/code file(s) copied into AeroShell. Original files were not changed.'
      : 'No files were imported. Choose text/code files under 250 KB to keep browser storage reliable. Larger files can still be edited in the connected folder.');
    setFallbackImport(false);
  };

  return <section className="real-files-panel" aria-label="Real device files">
    <div className="real-files-heading">
      <div className="real-files-symbol"><HardDrive size={18}/></div>
      <div className="real-files-heading-copy"><b>Device files</b><span>Work with files from your actual computer</span></div>
      {root && <span className="real-files-connected"><Check size={12}/> Folder connected</span>}
    </div>
    <div className="real-files-actions">
      <button className="primary-button" onClick={() => void connectFolder()} disabled={busy}><HardDrive size={14}/>{root ? 'Change folder' : 'Connect a folder'}</button>
      <label className="secondary-button real-files-pick"><Upload size={14}/> Open files<input type="file" multiple onChange={e => { void openPickedFiles(e.target.files); e.currentTarget.value = ''; }}/></label>
      {root && <button className="secondary-button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={14}/> Refresh</button>}
    </div>
    {root && <div className="real-files-browser">
      <label className="real-files-search"><Search size={13}/><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search connected folder…" aria-label="Search real files"/></label>
      <div className="real-files-list">
        {visible.map(entry => <button key={entry.path} className={'real-file-row ' + (selected?.path === entry.path ? 'selected' : '')} onClick={() => void openEntry(entry)} title={entry.path}>
          {entry.kind === 'directory' ? <Folder size={15}/> : entry.name.match(/\.(png|jpg|jpeg|webp|gif|bmp)$/i) ? <FileImage size={15}/> : <FileText size={15}/>}
          <span className="real-file-name">{entry.path}</span><small>{entry.kind === 'directory' ? 'Folder' : entry.size === undefined ? 'File' : formatSize(entry.size)}</small>
        </button>)}
        {!visible.length && <div className="real-files-empty">{busy ? 'Reading folder…' : 'No matching files.'}</div>}
      </div>
    </div>}
    {selected && <div className="real-files-editor">
      <div className="real-files-editor-head"><File size={14}/><b>{selected.path}</b>{dirty && <span>Unsaved edits</span>}</div>
      {editable
        ? <textarea value={editor} onChange={e => { setEditor(e.target.value); setDirty(true); }} aria-label="Edit real device file" spellCheck={false}/>
        : previewUrl && previewKind === 'image' ? <img className="real-file-preview" src={previewUrl} alt={selected.name}/>
        : previewUrl && previewKind === 'audio' ? <audio className="real-file-media" controls src={previewUrl}/>
        : previewUrl && previewKind === 'video' ? <video className="real-file-media" controls src={previewUrl}/>
        : previewUrl && previewKind === 'pdf' ? <iframe className="real-file-pdf" src={previewUrl} title={selected.name}/>
        : <div className="real-files-empty"><AlertCircle size={16}/>{status}</div>}
      <div className="real-files-editor-actions">
        {editable ? <>
          <button className="primary-button" onClick={() => void saveToDevice()} disabled={busy || !dirty}><Save size={14}/> Save to device</button>
          <button className="secondary-button" disabled={(selected.size ?? 0) > MAX_VIRTUAL_COPY_BYTES} onClick={() => { if ((selected.size ?? 0) > MAX_VIRTUAL_COPY_BYTES) { setStatus('This file is too large to copy into browser storage. Save it directly to the device instead.'); return; } onImport(selected.name, editor); setStatus('A separate copy of ' + selected.name + ' was added to AeroShell.'); }}><Upload size={14}/> Copy into AeroShell</button>
        </> : null}
      </div>
    </div>}
    {fallbackImport && <p className="real-files-help">This browser may not support a connected folder. “Open files” works with the regular file picker; supported text/code files can be copied into AeroShell.</p>}
    <div className="real-files-status" role="status"><span className={status.toLowerCase().includes('could not') ? 'warning' : ''}>{status}</span><small>Browser permission required · folder access is active only for this session</small></div>
    {!root && <div className="real-files-footnote">AeroShell only reads or writes the folder you choose. It cannot scan the whole PC secretly. Virtual copies are limited to 250 KB to protect browser storage; folder edits can be larger.</div>}
  </section>;
}

function isTextFileName(name: string) {
  return TEXT_EXTENSIONS.has(name.split('.').pop()?.toLowerCase() ?? '');
}
