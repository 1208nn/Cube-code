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
  const { context, client, tree } = deps;

  const reg = (name: string, fn: CommandFn) =>
    vscode.commands.registerCommand(name, runSafely(fn));

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
      if (node && node.kind !== "file") {
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
      if (node && node.kind !== "file") {
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

    reg("cube.downloadFile", async (node: CubeNode) => {
      if (node?.kind !== "file") {
        return;
      }
      const target = await vscode.window.showSaveDialog({
        defaultUri: defaultDownloadUri(node.meta.name),
        saveLabel: "Download",
      });
      if (!target) {
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Cube：正在下载 ${node.meta.name}`,
          cancellable: false,
        },
        async () => {
          const data = await client.download(node.bucket, nodeKey(node));
          await vscode.workspace.fs.writeFile(target, data);
        },
      );
      await vscode.window.showInformationMessage(
        `Cube：已下载 ${node.meta.name}。`,
      );
    }),

    reg("cube.deleteFile", async (node: CubeNode) => {
      if (node?.kind !== "file") {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `确定要从 bucket「${node.bucket}」删除「${node.meta.name}」吗？此操作不可撤销。`,
        { modal: true },
        "删除",
      );
      if (confirm !== "删除") {
        return;
      }
      await client.delete(node.bucket, nodeKey(node));
      const key = nodeKey(node);
      const location = key.includes("/")
        ? key.slice(0, key.lastIndexOf("/"))
        : "";
      tree.invalidate(node.bucket, location);
      await vscode.window.showInformationMessage(
        `Cube：已删除 ${node.meta.name}。`,
      );
    }),

    reg("cube.copyFileUrl", async (node: CubeNode) => {
      if (node?.kind !== "file") {
        return;
      }
      await vscode.env.clipboard.writeText(
        client.fileUrl(node.bucket, nodeKey(node)),
      );
      await vscode.window.showInformationMessage(
        "Cube：文件地址已复制到剪贴板。",
      );
    }),

    reg("cube.openFile", async (node: CubeNode) => {
      if (node?.kind !== "file") {
        return;
      }
      await vscode.commands.executeCommand("vscode.open", nodeUri(node));
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
