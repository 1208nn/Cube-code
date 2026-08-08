import * as vscode from "vscode";
import { CubeClient, FileMeta } from "./api";

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

  constructor(
    private readonly client: CubeClient,
    private readonly onMutated: (bucket: string, location: string) => void,
  ) {}

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
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    if (!key || key.endsWith("/")) {
      // Bucket root or explicit directory: verify it exists.
      if (!key) {
        const buckets = await this.client.listBuckets();
        if (!buckets.includes(bucket)) {
          throw vscode.FileSystemError.FileNotFound(uri);
        }
        return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      }
      await this.listFilesCached(bucket, key.replace(/\/$/, ""));
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
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
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
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
    const { bucket, key } = parseUri(uri);
    if (!key || key.endsWith("/")) {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    await this.client.upload(
      bucket,
      parentLocation(key),
      baseName(key),
      content,
      {
        convertWebp: false,
        useUuid: false,
      },
    );
    this.touch(bucket, parentLocation(key));
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
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
