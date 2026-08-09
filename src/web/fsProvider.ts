import * as vscode from "vscode";
import { ApiError, CubeClient, FileMeta } from "./api";

interface ParsedUri {
  bucket: string;
  key: string;
}

function parseUri(uri: vscode.Uri): ParsedUri {
  return {
    bucket: decodeURIComponent(uri.authority),
    key: decodeURIComponent(uri.path.replace(/^\//, "")),
  };
}

function parentLocation(key: string): string {
  const idx = key.lastIndexOf("/");
  return idx === -1 ? "" : key.slice(0, idx);
}

function baseName(key: string): string {
  const idx = key.lastIndexOf("/");
  return idx === -1 ? key : key.slice(idx + 1);
}

/** Shared stat returned for any virtual directory node. */
const DIR_STAT: vscode.FileStat = {
  type: vscode.FileType.Directory,
  ctime: 0,
  mtime: 0,
  size: 0,
};

/**
 * FileSystemProvider for `cube://{bucket}/{object_key}` URIs.
 * Opening a file reads it through the public file URL; saving re-uploads it.
 * Folder deletion/rename/creation are not supported by the backend API.
 */
export class CubeFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  private readonly dirCache = new Map<string, FileMeta[]>();

  // Saves are deferred: writeFile caches the new content and returns success
  // immediately, then kicks off the real upload in the background. The only
  // user prompt happens *during* that upload, if the backend reports the
  // object already exists.
  private readonly pendingWrites = new Map<
    string,
    { uri: vscode.Uri; content: Uint8Array }
  >();

  constructor(
    private readonly client: CubeClient,
    private readonly onMutated: (bucket: string, location: string) => void,
  ) {}

  /**
   * Returns a Disposable that cleans up internal listeners.
   * The caller must push this into `context.subscriptions`.
   */
  register(): vscode.Disposable {
    // When a cube file's editor is closed, discard any pending draft so an
    // in-flight upload for that file is aborted.
    return vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === "cube") {
        this.cancelPending(doc.uri);
      }
    });
  }

  /** Discard the pending draft for a uri (e.g. when its editor is closed). */
  cancelPending(uri: vscode.Uri): void {
    this.pendingWrites.delete(uri.toString());
  }

  invalidateAll(): void {
    this.dirCache.clear();
  }

  watch(
    _uri: vscode.Uri,
    _options: { recursive: boolean; excludes: string[] },
  ): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  private async listFilesCached(
    bucket: string,
    location: string,
  ): Promise<FileMeta[]> {
    const cacheKey = `${bucket}::${location}`;
    let metas = this.dirCache.get(cacheKey);
    if (!metas) {
      metas = await this.client.listFiles(bucket, location);
      this.dirCache.set(cacheKey, metas);
    }
    return metas;
  }

  private touch(bucket: string, location: string): void {
    this.dirCache.delete(`${bucket}::${location}`);
    this.onMutated(bucket, location);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { bucket, key } = parseUri(uri);
    if (!bucket) {
      return DIR_STAT;
    }
    if (!key || key.endsWith("/")) {
      // Bucket root or explicit directory: verify it exists.
      if (!key) {
        const buckets = await this.client.listBuckets();
        if (!buckets.includes(bucket)) {
          throw vscode.FileSystemError.FileNotFound(uri);
        }
        return DIR_STAT;
      }
      await this.listFilesCached(bucket, key.replace(/\/$/, ""));
      return DIR_STAT;
    }
    const location = parentLocation(key);
    const metas = await this.listFilesCached(bucket, location);
    const meta = metas.find(
      (m) => m.object_key === key || m.name === baseName(key),
    );
    if (!meta) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (meta.type === "dir") {
      return DIR_STAT;
    }
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: meta.last_modified ? Date.parse(meta.last_modified) || 0 : 0,
      size: meta.size ?? 0,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { bucket, key } = parseUri(uri);
    const metas = await this.listFilesCached(bucket, key.replace(/\/$/, ""));
    return metas.map((m) => [
      m.name,
      m.type === "dir" ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { bucket, key } = parseUri(uri);
    if (!key || key.endsWith("/")) {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    return this.client.download(bucket, key);
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const { key } = parseUri(uri);
    if (!key || key.endsWith("/")) {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    // Defer the actual backend write: cache the new content and report success
    // to VS Code right away, then kick off the upload in the background.
    const pendingKey = uri.toString();
    this.pendingWrites.set(pendingKey, { uri, content });
    void this.flushPending(pendingKey);
  }

  private async flushPending(pendingKey: string): Promise<void> {
    const entry = this.pendingWrites.get(pendingKey);
    if (!entry) {
      return;
    }
    const { bucket, key: objKey } = parseUri(entry.uri);
    const location = parentLocation(objKey);
    const fileName = baseName(objKey);
    // Always read content from the map so that a newer save that arrived while
    // an async modal was open is used instead of the stale snapshot.
    const uploadLatest = () => {
      const latest = this.pendingWrites.get(pendingKey);
      if (!latest) {
        return Promise.resolve();
      }
      return this.client.upload(bucket, location, fileName, latest.content, {
        convertWebp: false,
        useUuid: false,
      });
    };
    try {
      await uploadLatest();
    } catch (e) {
      if (e instanceof ApiError && /已存在|exists/i.test(e.message)) {
        // The object already exists on the backend. Ask the user to force an
        // overwrite (delete then re-upload) — this prompt fires *during* the
        // upload, not at edit time.
        const choice = await vscode.window.showInformationMessage(
          `文件已存在：${fileName}\n是否强制覆盖（删除后重新上传）？`,
          { modal: false },
          "强制覆盖",
          "取消",
        );
        // The editor may have been closed while the prompt was showing.
        if (!this.pendingWrites.has(pendingKey)) {
          return;
        }
        if (choice === "强制覆盖") {
          await this.client.delete(bucket, objKey);
          await uploadLatest();
        } else {
          await vscode.window.showInformationMessage(
            "Cube：已取消覆盖，更改仍暂存。",
          );
          return;
        }
      } else {
        throw e;
      }
    }
    // A confirmed/in-progress upload always completes, even if the editor was
    // closed while it was running — so we never abort it here. (The only thing
    // close cancels is an *unconfirmed* overwrite prompt, handled above.)
    this.pendingWrites.delete(pendingKey);
    this.touch(bucket, location);
    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Changed, uri: entry.uri },
    ]);
    await vscode.window.showInformationMessage("Cube：已保存到 OSS。");
  }

  async delete(
    uri: vscode.Uri,
    _options: { recursive: boolean },
  ): Promise<void> {
    const { bucket, key } = parseUri(uri);
    if (!key || key.endsWith("/")) {
      throw vscode.FileSystemError.NoPermissions(
        "Deleting folders is not supported by Cube OSS",
      );
    }
    await this.client.delete(bucket, key);
    this.touch(bucket, parentLocation(key));
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  createDirectory(_uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(
      "Folders are created implicitly by the upload location; upload a file into a new folder path instead",
    );
  }

  rename(
    _oldUri: vscode.Uri,
    _newUri: vscode.Uri,
    _options: { overwrite: boolean },
  ): void {
    throw vscode.FileSystemError.NoPermissions(
      "Renaming is not supported by Cube OSS",
    );
  }
}
