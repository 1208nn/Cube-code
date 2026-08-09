import * as vscode from "vscode";
import { ApiError, AuthError, ConfigError, CubeClient } from "./api";
import {
  clearApiKey,
  getApiUrl,
  setApiKey,
  syncToggleContextKeys,
} from "./state";
import { CubeNode, CubeTreeProvider, nodeKey, nodeUri } from "./tree";

type CommandFn = (...args: any[]) => unknown;

/** Wrap a command body with unified error handling UX. */
function runSafely(fn: CommandFn): CommandFn {
  return async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof AuthError) {
        const pick = await vscode.window.showErrorMessage(
          "Cube：API Key 无效或缺失。",
          "设置 API Key",
        );
        if (pick) {
          await vscode.commands.executeCommand("cube.setApiKey");
        }
      } else if (e instanceof ConfigError) {
        const pick = await vscode.window.showErrorMessage(
          `Cube：${e.message}`,
          "配置 API 地址",
        );
        if (pick) {
          await vscode.commands.executeCommand("cube.setApiUrl");
        }
      } else if (e instanceof ApiError) {
        await vscode.window.showErrorMessage(`Cube：${e.message}`);
      } else {
        await vscode.window.showErrorMessage(
          `Cube：${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return undefined;
    }
  };
}

export interface CommandDeps {
  context: vscode.ExtensionContext;
  client: CubeClient;
  tree: CubeTreeProvider;
  treeView: vscode.TreeView<CubeNode>;
}

/**
 * Normalize the arguments a view context-menu handler receives into the list of
 * selected FILE nodes. With `canSelectMany: true` VS Code passes
 * `(clickedItem, allSelected[])`, so we prefer the selected array when present.
 */
function selectedFiles(
  node: CubeNode | undefined,
  nodes?: readonly CubeNode[],
): Extract<CubeNode, { kind: "file" }>[] {
  const raw = nodes && nodes.length ? nodes : node ? [node] : [];
  return raw.filter(
    (n): n is Extract<CubeNode, { kind: "file" }> => n.kind === "file",
  );
}

function getPrefs(): { convertWebp: boolean; useUuid: boolean } {
  const cfg = vscode.workspace.getConfiguration("cube-oss");
  return {
    convertWebp: cfg.get<boolean>("convertWebp", true),
    useUuid: cfg.get<boolean>("useUuid", false),
  };
}

/** Build a case-insensitive regex from the configurable `cube-oss.webpConvertible` list. */
function webpConvertibleRegex(): RegExp {
  const exts = vscode.workspace
    .getConfiguration("cube-oss")
    .get<string[]>("webpConvertible") ?? [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".tif",
    ".tiff",
    ".bmp",
  ];
  const parts = exts
    .map((e) => e.trim().toLowerCase())
    .map((e) => (e.startsWith(".") ? e : "." + e))
    .map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(${parts.join("|")})$`, "i");
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { context, client, tree, treeView } = deps;

  const reg = (name: string, fn: CommandFn) =>
    vscode.commands.registerCommand(name, runSafely(fn));

  // Track the latest multi-selection. Commands invoked WITHOUT arguments (e.g.
  // the Delete keybinding, or palette) can't rely on the live `treeView.selection`
  // read at key-press time, which can come back empty — so we keep the last
  // known selection and fall back to it.
  let currentSelection: readonly CubeNode[] = [];
  context.subscriptions.push(
    treeView.onDidChangeSelection((e) => {
      currentSelection = e.selection;
    }),
  );

  // Resolve the file nodes a view command should act on. VS Code passes
  // (clickedItem, selectedItems[]) for multi-select context menus, but we also
  // fall back to the tracked selection so the command works from keybindings /
  // command palette too.
  const selectedFileNodes = (
    node: CubeNode | undefined,
    nodes?: readonly CubeNode[],
  ): Extract<CubeNode, { kind: "file" }>[] => {
    const fromArgs = selectedFiles(node, nodes);
    if (fromArgs.length) {
      return fromArgs;
    }
    const sel = currentSelection.length ? currentSelection : treeView.selection;
    return sel.filter(
      (n): n is Extract<CubeNode, { kind: "file" }> => n.kind === "file",
    );
  };

  /** Close any open editor tabs whose resource URI matches a deleted node. */
  const closeDeletedTabs = async (
    targets: readonly CubeNode[],
  ): Promise<void> => {
    for (const t of targets) {
      const uri = nodeUri(t).toString();
      const tabs: vscode.Tab[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const inp = tab.input as { uri?: vscode.Uri };
          if (inp?.uri?.toString() === uri) {
            tabs.push(tab);
          }
        }
      }
      if (tabs.length) {
        await vscode.window.tabGroups.close(tabs);
      }
    }
  };

  // Keep the title-bar toggle items in sync with the upload-mode settings.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("cube-oss.convertWebp") ||
        e.affectsConfiguration("cube-oss.useUuid")
      ) {
        syncToggleContextKeys();
      }
    }),
  );

  const pickBucket = async (): Promise<string | undefined> => {
    const buckets = await client.listBuckets();
    return vscode.window.showQuickPick(buckets, { title: "Cube：选择 bucket" });
  };

  /** Upload local files into bucket/location with progress. */
  const uploadFiles = async (
    bucket: string,
    location: string,
    uris: vscode.Uri[],
  ): Promise<void> => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Cube: uploading to ${bucket}${location ? "/" + location : ""}`,
        cancellable: false,
      },
      async (progress) => {
        const step = 100 / uris.length;
        const { convertWebp, useUuid } = getPrefs();
        const regex = webpConvertibleRegex();
        for (const uri of uris) {
          const name = uri.path.split("/").pop() ?? "file";
          progress.report({ message: name });
          const data = await vscode.workspace.fs.readFile(uri);
          await client.upload(bucket, location, name, data, {
            convertWebp: convertWebp && regex.test(name),
            useUuid,
          });
          progress.report({ increment: step });
        }
      },
    );
    tree.invalidate(bucket, location);
    await vscode.window.showInformationMessage(
      `Cube：已上传 ${uris.length} 个文件到 ${bucket}${location ? "/" + location : ""}。`,
    );
  };

  const pickLocalFiles = (title: string) =>
    vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "上传",
      title,
    });

  const setBool = async (key: string, value: boolean): Promise<void> => {
    await vscode.workspace
      .getConfiguration("cube-oss")
      .update(key, value, vscode.ConfigurationTarget.Global);
    syncToggleContextKeys();
  };

  return [
    reg("cube.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "Cube：设置 API Key",
        prompt: "输入你的 Cube OSS 后端 API Key",
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) {
        return;
      }
      await setApiKey(context, key.trim());
      tree.refresh();
      await vscode.window.showInformationMessage("Cube：已保存 API Key。");
    }),

    reg("cube.clearApiKey", async () => {
      await clearApiKey(context);
      tree.refresh();
      await vscode.window.showInformationMessage("Cube：已清除 API Key。");
    }),

    reg("cube.setApiUrl", async () => {
      const url = await vscode.window.showInputBox({
        title: "Cube：设置 API 地址",
        prompt: "Cube OSS 后端地址，例如 https://oss.example.com",
        value: getApiUrl(),
        ignoreFocusOut: true,
      });
      if (url === undefined) {
        return;
      }
      await vscode.workspace
        .getConfiguration("cube-oss")
        .update("apiUrl", url.trim(), vscode.ConfigurationTarget.Global);
      tree.refresh();
      await vscode.window.showInformationMessage("Cube：已保存 API 地址。");
    }),

    reg("cube.refresh", async () => {
      tree.refresh();
    }),

    // Menu label = the ACTION performed; the matching `when` shows it only while
    // the opposite mode is active, so clicking switches and the menu re-renders.
    reg("cube.setFilenameKeep", async () => {
      await setBool("useUuid", false);
    }),

    reg("cube.setFilenameRandom", async () => {
      await setBool("useUuid", true);
    }),

    reg("cube.setFormatWebp", async () => {
      await setBool("convertWebp", true);
    }),

    reg("cube.setFormatKeep", async () => {
      await setBool("convertWebp", false);
    }),

    reg("cube.openSettings", async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `@ext:${context.extension.id}`,
      );
    }),

    reg("cube.uploadFile", async (node?: CubeNode) => {
      let bucket: string | undefined;
      let location = "";
      if (node && (node.kind === "bucket" || node.kind === "dir")) {
        bucket = node.bucket;
        location = node.kind === "dir" ? node.path.replace(/\/$/, "") : "";
      } else {
        bucket = await pickBucket();
      }
      if (!bucket) {
        return;
      }

      const uris = await pickLocalFiles(
        `上传到 ${bucket}${location ? "/" + location : ""}`,
      );
      if (!uris?.length) {
        return;
      }
      await uploadFiles(bucket, location, uris);
    }),

    // Folders materialize on upload (backend has no explicit mkdir): the command
    // asks for a folder name, then uploads chosen files into that location.
    reg("cube.newFolder", async (node?: CubeNode) => {
      let bucket: string | undefined;
      let base = "";
      if (node && (node.kind === "bucket" || node.kind === "dir")) {
        bucket = node.bucket;
        base = node.kind === "dir" ? node.path.replace(/\/$/, "") : "";
      } else {
        bucket = await pickBucket();
      }
      if (!bucket) {
        return;
      }

      const name = await vscode.window.showInputBox({
        title: "Cube：新建文件夹",
        prompt: `在 ${bucket}/${base ? base + "/" : ""} 下新建文件夹（文件夹随上传的文件一起创建）`,
        validateInput: (v) => {
          if (!v.trim()) {
            return "文件夹名不能为空";
          }
          if (/[/\\]/.test(v)) {
            return "文件夹名不能包含 / 或 \\";
          }
          return undefined;
        },
      });
      if (name === undefined) {
        return;
      }
      const location = base ? `${base}/${name.trim()}` : name.trim();

      const uris = await pickLocalFiles(`上传到新文件夹 ${bucket}/${location}`);
      if (!uris?.length) {
        return;
      }
      await uploadFiles(bucket, location, uris);
    }),

    reg(
      "cube.downloadFile",
      async (node: CubeNode, nodes?: readonly CubeNode[]) => {
        const targets = selectedFileNodes(node, nodes);
        if (!targets.length) {
          return;
        }

        // Single file keeps the familiar "pick save location" dialog.
        if (targets.length === 1) {
          const t = targets[0];
          const target = await vscode.window.showSaveDialog({
            defaultUri: defaultDownloadUri(t.meta.name),
            saveLabel: "Download",
          });
          if (!target) {
            return;
          }
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Cube：正在下载 ${t.meta.name}`,
              cancellable: false,
            },
            async () => {
              const data = await client.download(t.bucket, nodeKey(t));
              await vscode.workspace.fs.writeFile(target, data);
            },
          );
          await vscode.window.showInformationMessage(
            `Cube：已下载 ${t.meta.name}。`,
          );
          return;
        }

        // Multiple files: pick one destination folder, download them all into it.
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          openLabel: "下载",
          title: `Cube：下载 ${targets.length} 个文件到文件夹`,
        });
        if (!picked?.length) {
          return;
        }
        const folder = picked[0];
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Cube：正在下载 ${targets.length} 个文件`,
            cancellable: false,
          },
          async (progress) => {
            const step = 100 / targets.length;
            for (const t of targets) {
              progress.report({ message: t.meta.name });
              const data = await client.download(t.bucket, nodeKey(t));
              await vscode.workspace.fs.writeFile(
                vscode.Uri.joinPath(folder, t.meta.name),
                data,
              );
              progress.report({ increment: step });
            }
          },
        );
        await vscode.window.showInformationMessage(
          `Cube：已下载 ${targets.length} 个文件到 ${folder.path}。`,
        );
      },
    ),

    reg(
      "cube.deleteFile",
      async (node: CubeNode, nodes?: readonly CubeNode[]) => {
        const targets = selectedFileNodes(node, nodes);
        if (!targets.length) {
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `确定要删除选中的 ${targets.length} 个文件吗？此操作不可撤销。`,
          { modal: true },
          "删除",
        );
        if (confirm !== "删除") {
          return;
        }
        const invalids = new Set<string>();
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Cube：正在删除 ${targets.length} 个文件`,
            cancellable: false,
          },
          async (progress) => {
            const step = 100 / targets.length;
            for (const t of targets) {
              progress.report({ message: t.meta.name });
              await client.delete(t.bucket, nodeKey(t));
              const key = nodeKey(t);
              const location = key.includes("/")
                ? key.slice(0, key.lastIndexOf("/"))
                : "";
              invalids.add(`${t.bucket}::${location}`);
              progress.report({ increment: step });
            }
          },
        );
        for (const k of invalids) {
          const sep = k.indexOf("::");
          tree.invalidate(k.slice(0, sep), k.slice(sep + 2));
        }
        // Close any open editor tabs for the deleted files so the right side
        // doesn't keep showing a now-deleted file.
        await closeDeletedTabs(targets);
        await vscode.window.showInformationMessage(
          `Cube：已删除 ${targets.length} 个文件。`,
        );
      },
    ),

    reg(
      "cube.copyFileUrl",
      async (node: CubeNode, nodes?: readonly CubeNode[]) => {
        const targets = selectedFileNodes(node, nodes);
        if (!targets.length) {
          return;
        }
        const urls = targets
          .map((t) => client.fileUrl(t.bucket, nodeKey(t)))
          .join("\n");
        try {
          await vscode.env.clipboard.writeText(urls);
        } catch {
          // The async clipboard API can be blocked (e.g. non-secure context in a
          // web extension). Fall back to a pre-filled input box the user can copy.
          await vscode.window.showInputBox({
            title: `Cube：复制 ${targets.length} 个文件地址（请手动复制）`,
            value: urls,
            prompt: "按 Ctrl/Cmd+C 复制以下地址",
          });
          return;
        }
        await vscode.window.showInformationMessage(
          targets.length > 1
            ? `Cube：已复制 ${targets.length} 个文件地址。`
            : "Cube：文件地址已复制到剪贴板。",
        );
      },
    ),

    reg("cube.openFile", async (node: CubeNode) => {
      if (node?.kind !== "file") {
        return;
      }
      // Open the file but keep focus in the explorer so that a fast open (when
      // the network is quick) doesn't steal focus from the sidebar and break
      // continued Ctrl/Shift multi-select in the tree.
      await vscode.commands.executeCommand("vscode.open", nodeUri(node), {
        preserveFocus: true,
      });
    }),

    reg("cube.previewImage", async (node: CubeNode) => {
      if (node?.kind !== "file") {
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        "cubeImagePreview",
        node.meta.name,
        vscode.ViewColumn.Beside,
        { enableScripts: false },
      );
      const src = client.thumbnailUrl(node.bucket, nodeKey(node));
      panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https:; style-src 'unsafe-inline';">
<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#1e1e1e}img{max-width:100%;max-height:100vh}</style>
</head>
<body><img src="${src}" alt="${node.meta.name}"></body>
</html>`;
    }),
  ];
}

/**
 * Default download target: configured `cube-oss.downloadDirectory` first (web
 * extensions cannot resolve the OS home dir, so set it to e.g.
 * `C:/Users/you/Downloads`), then the first workspace folder.
 */
function defaultDownloadUri(name: string): vscode.Uri {
  const dir = vscode.workspace
    .getConfiguration("cube-oss")
    .get<string>("downloadDirectory", "")
    .trim();
  if (dir) {
    return vscode.Uri.file(`${dir.replace(/[\\/]+$/, "")}/${name}`);
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    return vscode.Uri.joinPath(folder.uri, name);
  }
  return vscode.Uri.file(name);
}
