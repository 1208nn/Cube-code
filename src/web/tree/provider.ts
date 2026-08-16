import * as vscode from "vscode";
import { CubeClient, FileMeta } from "../api";
import { CubeNode, formatSize, nodeUri } from "./types";

export class CubeTreeProvider implements vscode.TreeDataProvider<CubeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    CubeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly cache = new Map<string, FileMeta[]>();

  constructor(
    private readonly client: CubeClient,
    private readonly hasApiKey: () => Promise<boolean>,
  ) {}

  refresh(): void {
    this.cache.clear();
    this._onDidChangeTreeData.fire();
  }

  invalidate(bucket: string, location: string): void {
    // Clear the target location and every ancestor up to the bucket root so
    // that parent directories also re-fetch their children list — otherwise a
    // stale parent cache hides the newly uploaded file in the tree view.
    this.cache.delete(`${bucket}::${location}`);
    let ancestor = location;
    while (ancestor.includes("/")) {
      ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"));
      this.cache.delete(`${bucket}::${ancestor}`);
    }
    // Always clear the bucket-root cache too.
    this.cache.delete(`${bucket}::`);
    this._onDidChangeTreeData.fire();
  }

  async getChildren(node?: CubeNode): Promise<CubeNode[]> {
    if (!(await this.hasApiKey())) {
      return [];
    }
    if (!node) {
      const buckets = await this.client.listBuckets();
      return buckets.map((bucket) => ({ kind: "bucket", bucket }));
    }
    if (node.kind === "file") {
      return [];
    }
    const location = node.kind === "bucket" ? "" : node.path.replace(/\/$/, "");
    const metas = await this.listFilesCached(node.bucket, location);
    return metas.map((meta) => this.metaToNode(node.bucket, location, meta));
  }

  private async listFilesCached(
    bucket: string,
    location: string,
  ): Promise<FileMeta[]> {
    const cacheKey = `${bucket}::${location}`;
    let metas = this.cache.get(cacheKey);
    if (!metas) {
      metas = await this.client.listFiles(bucket, location);
      this.cache.set(cacheKey, metas);
    }
    return metas;
  }

  private metaToNode(
    bucket: string,
    location: string,
    meta: FileMeta,
  ): CubeNode {
    if (meta.type === "dir") {
      const path = location ? `${location}/${meta.name}/` : `${meta.name}/`;
      return { kind: "dir", bucket, path };
    }
    const path =
      meta.object_key ?? (location ? `${location}/${meta.name}` : meta.name);
    return { kind: "file", bucket, path, meta };
  }

  getTreeItem(node: CubeNode): vscode.TreeItem {
    switch (node.kind) {
      case "bucket": {
        const item = new vscode.TreeItem(
          node.bucket,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = nodeUri(node).toString();
        item.contextValue = "bucket";
        item.iconPath = new vscode.ThemeIcon("database");
        return item;
      }
      case "dir": {
        const name = node.path.replace(/\/$/, "").split("/").pop() ?? node.path;
        const uri = nodeUri(node);
        const item = new vscode.TreeItem(
          name,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = uri.toString();
        item.contextValue = "folder";
        item.iconPath = new vscode.ThemeIcon("folder");
        item.resourceUri = uri;
        return item;
      }
      case "file": {
        const isImage = node.meta.type === "image";
        const item = new vscode.TreeItem(
          node.meta.name,
          vscode.TreeItemCollapsibleState.None,
        );
        item.id = nodeUri(node).toString();
        item.contextValue = isImage ? "image" : "file";
        item.iconPath = new vscode.ThemeIcon(isImage ? "file-media" : "file");
        item.resourceUri = nodeUri(node);
        if (node.meta.size !== undefined) {
          item.description = formatSize(node.meta.size);
        }
        if (node.meta.last_modified) {
          item.tooltip = `${node.meta.name}\nModified: ${node.meta.last_modified}`;
        }
        item.command = {
          command: "cube.openFile",
          title: "Open File",
          arguments: [node],
        };
        return item;
      }
    }
  }
}
