import * as vscode from "vscode";
import { CubeClient } from "./api";
import { registerCommands } from "./commands";
import { CubeFileSystemProvider } from "./fs/provider";
import {
  getApiKey,
  getApiUrl,
  syncToggleContextKeys,
  updateContextKeys,
} from "./state";
import { CubeDragDropController, CubeTreeProvider } from "./tree";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const client = new CubeClient(getApiUrl, () => getApiKey(context));

  const tree = new CubeTreeProvider(
    client,
    async () => !!(await getApiKey(context)),
  );
  const dragDrop = new CubeDragDropController(client, tree);
  const fsProvider = new CubeFileSystemProvider(client, (bucket, location) =>
    tree.invalidate(bucket, location),
  );

  const treeView = vscode.window.createTreeView("cubeExplorer", {
    treeDataProvider: tree,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: dragDrop,
  });
  context.subscriptions.push(
    treeView,
    fsProvider.register(),
    vscode.workspace.registerFileSystemProvider("cube", fsProvider, {
      isCaseSensitive: true,
    }),
    ...registerCommands({ context, client, tree, treeView }),
    context.secrets.onDidChange(() => {
      void updateContextKeys(context).then(() => tree.refresh());
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cube-oss.apiUrl")) {
        fsProvider.invalidateAll();
        tree.refresh();
      }
    }),
  );

  await updateContextKeys(context);
  // Re-sync toggle context keys now that all contributed menus are registered, so the
  // title-bar items reflect the saved settings immediately (not only after the first
  // tree refresh triggered by the bucket list loading).
  syncToggleContextKeys();
}

export function deactivate() {}
