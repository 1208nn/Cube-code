import * as vscode from "vscode";
import { CubeClient } from "../api";
import { getPrefs, webpConvertibleRegex } from "../upload";
import { CubeNode, nodeKey, nodeUri } from "./types";
import { CubeTreeProvider } from "./provider";

/** A file item to be uploaded via drag-and-drop. */
interface DroppedFile {
  name: string;
  read: () => Promise<Uint8Array>;
}

/**
 * Drop onto the tree => upload. Drag from the tree => produce real files
 * (DataTransferFile) so the OS / Explorer can save them wherever you drop.
 */
export class CubeDragDropController implements vscode.TreeDragAndDropController<CubeNode> {
  private static readonly TREE_MIME = "application/vnd.code.tree.cubeexplorer";
  readonly dragMimeTypes: readonly string[] = [
    "files",
    "text/uri-list",
    CubeDragDropController.TREE_MIME,
  ];
  readonly dropMimeTypes: readonly string[] = [
    "text/uri-list",
    "files",
    CubeDragDropController.TREE_MIME,
  ];

  constructor(
    private readonly client: CubeClient,
    private readonly tree: CubeTreeProvider,
  ) {}

  async handleDrop(
    target: CubeNode | undefined,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken,
  ): Promise<void> {
    // Our own drag (a tree item being dragged) — don't treat it as an upload.
    if (dataTransfer.get(CubeDragDropController.TREE_MIME)) {
      return;
    }
    if (!target) {
      await vscode.window.showWarningMessage(
        "Cube: drop files onto a bucket, folder, or file to upload.",
      );
      return;
    }
    const bucket = target.bucket;
    let location: string;
    if (target.kind === "file") {
      // Dropping onto a file uploads into that file's parent folder (i.e. the
      // same level as the file), which feels natural when organizing uploads.
      const key = nodeKey(target);
      location = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
    } else if (target.kind === "dir") {
      location = target.path.replace(/\/$/, "");
    } else {
      location = "";
    }

    const files: DroppedFile[] = [];
    // Track names already collected via uri-list so the browser-File loop
    // below doesn't re-add duplicates when both sources carry the same items.
    const seenNames = new Set<string>();

    // From VS Code Explorer / desktop (uri-list)
    const uriItem = dataTransfer.get("text/uri-list");
    if (uriItem) {
      const text = await uriItem.asString();
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }
        const uri = vscode.Uri.parse(trimmed);
        if (uri.scheme === "file" || uri.scheme === "vscode-remote") {
          const name = uri.path.split("/").pop() ?? "file";
          seenNames.add(name);
          files.push({
            name,
            read: async () => vscode.workspace.fs.readFile(uri),
          });
        }
      }
    }

    // From OS into a web extension host (browser File objects).
    // Skip mime types that are not actual file payloads to avoid treating
    // the uri-list string itself as a file.
    const skipMimes = new Set([
      "text/uri-list",
      CubeDragDropController.TREE_MIME,
    ]);
    for (const [mime, item] of dataTransfer) {
      if (skipMimes.has(mime)) {
        continue;
      }
      const file = item.asFile();
      if (file && !seenNames.has(file.name)) {
        seenNames.add(file.name);
        files.push({ name: file.name, read: async () => file.data() });
      }
    }

    if (!files.length) {
      return;
    }

    const { convertWebp, useUuid } = getPrefs();
    const webpRegex = webpConvertibleRegex();

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Cube: uploading to ${bucket}${location ? "/" + location : ""}`,
        cancellable: false,
      },
      async (progress) => {
        for (const file of files) {
          if (token.isCancellationRequested) {
            break;
          }
          progress.report({
            message: file.name,
            increment: 100 / files.length,
          });
          const data = await file.read();
          await this.client.upload(bucket, location, file.name, data, {
            convertWebp: convertWebp && webpRegex.test(file.name),
            useUuid,
          });
        }
      },
    );
    this.tree.invalidate(bucket, location);
    await vscode.window.showInformationMessage(
      `Cube：已上传 ${files.length} 个文件到 ${bucket}${location ? "/" + location : ""}。`,
    );
  }

  async handleDrag(
    source: readonly CubeNode[],
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) {
      return;
    }

    // Set minimal data first so the drag is always valid, even if later
    // (network-dependent) steps fail. A rejected handleDrag aborts the drag.
    dataTransfer.set(
      CubeDragDropController.TREE_MIME,
      new vscode.DataTransferItem(source),
    );
    const uriList = source.map((n) => nodeUri(n).toString()).join("\r\n");
    if (uriList) {
      dataTransfer.set("text/uri-list", new vscode.DataTransferItem(uriList));
    }

    const DTF = (vscode as any).DataTransferFile as
      | (new (
          data: Uint8Array | (() => Promise<Uint8Array>),
          name: string,
          uri?: vscode.Uri,
        ) => unknown)
      | undefined;
    if (!DTF) {
      return;
    }

    // Build real files to drop onto the OS / Explorer. A single `file` node is
    // known without any network call, so its drag starts instantly. Directories
    // and buckets need enumeration, which is best-effort (wrapped so a failure
    // can't abort the drag).
    const files: unknown[] = [];
    for (const node of source) {
      if (token.isCancellationRequested) {
        return;
      }
      if (node.kind === "file") {
        files.push(
          new DTF(
            () => this.client.download(node.bucket, nodeKey(node)),
            node.meta.name,
          ),
        );
        continue;
      }
      try {
        const collected: { bucket: string; key: string; name: string }[] = [];
        await this.collectFiles(node, collected, token);
        for (const f of collected) {
          files.push(
            new DTF(() => this.client.download(f.bucket, f.key), f.name),
          );
        }
      } catch {
        // Couldn't enumerate now (e.g. offline) — skip this node.
      }
    }
    if (files.length) {
      dataTransfer.set("files", new vscode.DataTransferItem(files));
    }
  }

  /** Recursively gather every file under a node (expanding dirs/buckets). */
  private async collectFiles(
    node: CubeNode,
    out: { bucket: string; key: string; name: string }[],
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) {
      return;
    }
    if (node.kind === "file") {
      out.push({
        bucket: node.bucket,
        key: nodeKey(node),
        name: node.meta.name,
      });
      return;
    }
    const location = node.kind === "bucket" ? "" : node.path.replace(/\/$/, "");
    const metas = await this.client.listFiles(node.bucket, location);
    for (const meta of metas) {
      if (token.isCancellationRequested) {
        return;
      }
      if (meta.type === "dir") {
        const childPath = location
          ? `${location}/${meta.name}/`
          : `${meta.name}/`;
        await this.collectFiles(
          { kind: "dir", bucket: node.bucket, path: childPath },
          out,
          token,
        );
      } else {
        const key =
          meta.object_key ??
          (location ? `${location}/${meta.name}` : meta.name);
        out.push({ bucket: node.bucket, key, name: meta.name });
      }
    }
  }
}
