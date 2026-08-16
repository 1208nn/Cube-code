import * as vscode from "vscode";
import { CubeClient, FileMeta } from "./api";

export type CubeNode =
  | { kind: "bucket"; bucket: string }
  | { kind: "dir"; bucket: string; path: string }
  | { kind: "file"; bucket: string; path: string; meta: FileMeta };

/** Object key for a node (files/dirs). Dir keys end with '/'. */
export function nodeKey(node: CubeNode): string {
  if (node.kind === "bucket") {
    return "";
  }
  return node.path;
}

export function nodeUri(node: CubeNode): vscode.Uri {
  const key = nodeKey(node).split("/").map(encodeURIComponent).join("/");
  return vscode.Uri.parse(`cube://${encodeURIComponent(node.bucket)}/${key}`);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}
